// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHomeworkSubmissionDatabase } from "./homework-submissions-fixture";
import { asStaffActor, STAFF_IDS as actor, STAFF_ROWS as row } from "./staff-scope-fixture";

describe("private pupil homework uploads", () => {
  let db: Awaited<ReturnType<typeof createHomeworkSubmissionDatabase>>;
  const path = (student = row.A.student as string) => [actor.schoolA, row.A.year, row.A.class, row.A.section, row.A.subject, row.A.activity, student, `${randomUUID()}.pdf`].join("/");
  beforeAll(async () => {
    db = await createHomeworkSubmissionDatabase();
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    const file = (await readdir(dir)).find((name) => name.endsWith("_private_homework_submission_files.sql"));
    if (!file) throw new Error("Missing private homework file migration");
    await db.exec(await readFile(new URL(file, dir), "utf8"));
    await db.query("update public.profiles set school_id=$2 where id=$1", [actor.outsider, actor.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')", [actor.outsider, actor.schoolA]);
    await db.query("update public.students set profile_id=$2 where id=$1", [row.privateStudentA, actor.outsider]);
    await db.query("update public.enrollments set class_id=$2,section_id=$3 where id=$1", [row.privateEnrollmentA, row.A.class, row.A.section]);
  }, 30000);
  afterAll(async () => { await db?.close(); });
  async function storage(user: string, operation: string, sql: string, args: unknown[] = []) {
    await db.exec("begin;set local role authenticated");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('storage.operation',$2,true)", [user, operation]);
      const result = await db.query(sql, args);
      await db.exec("commit");
      return result.rows;
    } catch (error) { await db.exec("rollback"); throw error; }
  }
  const upload = (name: string, user: string = actor.studentA, owner: string = user) => storage(user, "object.upload",
    "insert into storage.objects(bucket_id,name,owner_id,metadata) values('homework-submissions',$1,$2,'{\"size\":608,\"mimetype\":\"application/pdf\"}') returning id", [name, owner]);
  const read = (name: string, user: string, operation = "object.get_authenticated") => storage(user, operation, "select name from storage.objects where name=$1", [name]);
  const submit = async (name: string) => (await asStaffActor<{ result: { id: string } }>(db, actor.studentA,
    "select public.submit_homework($1,'My PDF response',$2,null,$3,'answer.pdf') as result", [row.A.activity, name, randomUUID()])).rows[0].result;
  let submittedFile = "";

  it("creates a private PDF/JPEG/PNG bucket capped at ten MiB", async () => {
    expect((await db.query("select public,file_size_limit::text,allowed_mime_types from storage.buckets where id='homework-submissions'")).rows)
      .toEqual([{ public: false, file_size_limit: "10485760", allowed_mime_types: ["application/pdf", "image/jpeg", "image/png"] }]);
  });

  it("lets only the pupil read and clean up an unlinked own upload", async () => {
    const name = path();
    await upload(name);
    expect(await read(name, actor.studentA)).toEqual([{ name }]);
    for (const user of [actor.teacherA, actor.parentA, actor.outsider, actor.studentB]) expect(await read(name, user)).toEqual([]);
    expect(await storage(actor.studentA, "object.delete_many", "delete from storage.objects where name=$1 returning id", [name])).toHaveLength(1);
  });

  it("rejects forged school/year/section/student paths and owner impersonation", async () => {
    for (const name of [path().replace(actor.schoolA, actor.schoolB), path().replace(row.A.year, row.B.year),
      path().replace(row.A.section, row.privateSectionA), path(row.privateStudentA), `${actor.schoolA}/broadcast.pdf`]) {
      await expect(upload(name)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(upload(path(), actor.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(upload(path(), actor.studentA, actor.outsider)).rejects.toMatchObject({ code: "42501" });
  });

  it("shares only the linked submitted file with the assigned teacher and linked guardian", async () => {
    submittedFile = path();
    await upload(submittedFile);
    await submit(submittedFile);
    for (const user of [actor.studentA, actor.teacherA, actor.parentA, actor.adminA]) expect(await read(submittedFile, user)).toEqual([{ name: submittedFile }]);
    for (const user of [actor.outsider, actor.studentB, actor.teacherB, actor.parentB]) expect(await read(submittedFile, user)).toEqual([]);
  });

  it("denies URL signing, signed upload, copy, move and overwrite paths", async () => {
    for (const operation of ["object.sign", "object.sign_many", "object.sign_upload_url", "object.copy", "object.move", ""]) {
      expect(await read(submittedFile, actor.studentA, operation)).toEqual([]);
      expect(await read(submittedFile, actor.teacherA, operation)).toEqual([]);
    }
    expect(await storage(actor.studentA, "object.upload_update", "update storage.objects set metadata='{}' where name=$1 returning id", [submittedFile])).toEqual([]);
    expect(await storage(actor.studentA, "object.delete_many", "delete from storage.objects where name=$1 returning id", [submittedFile])).toEqual([]);
  });

  it("keeps submitted evidence immutable even under stale/broad RLS authorization or a trusted metadata mutation", async () => {
    await db.exec("create policy qa_stale_homework_file on storage.objects for all to authenticated using(bucket_id='homework-submissions') with check(bucket_id='homework-submissions')");
    try {
      await expect(storage(actor.studentA, "object.delete_many", "delete from storage.objects where name=$1", [submittedFile])).rejects.toMatchObject({ code: "42501" });
      await expect(storage(actor.studentA, "object.upload_update", "update storage.objects set metadata='{}' where name=$1", [submittedFile])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.exec("drop policy qa_stale_homework_file on storage.objects"); }
    await expect(db.query("delete from storage.objects where name=$1", [submittedFile])).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select metadata from storage.objects where name=$1", [submittedFile])).rows)
      .toEqual([{ metadata: { size: 608, mimetype: "application/pdf" } }]);
  });

  it("cuts off a removed teacher assignment while preserving own pupil and linked guardian downloads", async () => {
    await db.query("delete from public.teacher_subject_assignments where id=$1", [row.A.assignment]);
    expect(await read(submittedFile, actor.teacherA)).toEqual([]);
    expect(await read(submittedFile, actor.studentA)).toEqual([{ name: submittedFile }]);
    expect(await read(submittedFile, actor.parentA)).toEqual([{ name: submittedFile }]);
  });
});
