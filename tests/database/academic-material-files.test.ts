// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcademicPermissionDatabase } from "./academic-permissions-fixture";
import { STAFF_IDS as actor, STAFF_ROWS as row } from "./staff-scope-fixture";

describe("assignment-scoped private material files", () => {
  let db: Awaited<ReturnType<typeof createAcademicPermissionDatabase>>;
  const key = (side: "A" | "B" = "A", classId: string = row[side].class, sectionId: string = row[side].section) =>
    [actor[`school${side}`], row[side].year, classId, sectionId, row[side].subject, row[side].teacher, `${randomUUID()}.txt`].join("/");

  beforeAll(async () => {
    db = await createAcademicPermissionDatabase();
    await db.exec(`create schema storage;
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,owner_id text,metadata jsonb,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,anon;
      grant select,insert,update,delete on storage.objects to authenticated;
      create function storage.allow_any_operation(expected_operations text[]) returns boolean language sql stable as $$
        select coalesce(case when current_setting('storage.operation',true) like 'storage.%'
          then substr(current_setting('storage.operation',true),9) else current_setting('storage.operation',true) end = any(expected_operations),false) $$;
      create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$
        select storage.allow_any_operation(array[expected_operation]) $$;
      create policy study_materials_authenticated_access on storage.objects for all to authenticated
        using(bucket_id='study-materials') with check(bucket_id='study-materials');
      create policy unrelated_bucket on storage.objects for all to authenticated
        using(bucket_id='school-assets') with check(bucket_id='school-assets');`);
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = await readdir(directory);
    for (const suffix of ["_harden_academic_material_files.sql", "_permit_scoped_material_replace_probe.sql"]) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error("Missing file security migration: " + suffix);
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
  }, 30000);
  afterAll(async () => { await db?.close(); });

  async function api(user: string, operation: string, sql: string, args: unknown[] = []) {
    await db.exec("begin;set local role authenticated");
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('storage.operation',$2,true)", [user, operation]);
      const result = await db.query(sql, args);
      await db.exec("commit");
      return result.rows;
    } catch (error) { await db.exec("rollback"); throw error; }
  }
  const upload = (name: string, user: string = actor.teacherA) => api(user, "object.upload",
    "insert into storage.objects(bucket_id,name,owner_id,metadata) values('study-materials',$1,$2,'{\"bytes\":1}') returning id", [name, user]);
  const files = (user: string, name: string, operation = "object.get_authenticated") => api(user, operation,
    "select name from storage.objects where name=$1", [name]);

  it("allows own exact-scope pending upload/read/replace and cleanup, and leaves other buckets alone", async () => {
    const name = key();
    expect(await upload(name)).toHaveLength(1);
    expect(await files(actor.teacherA, name)).toEqual([{ name }]);
    expect(await files(actor.studentA, name)).toEqual([]);
    expect(await api(actor.teacherA, "object.upload_update", "update storage.objects set metadata='{\"bytes\":2}' where name=$1 returning id", [name])).toHaveLength(1);
    expect(await api(actor.teacherA, "object.delete_many", "delete from storage.objects where name=$1 returning id", [name])).toHaveLength(1);
    expect(await api(actor.studentA, "object.upload", "insert into storage.objects(bucket_id,name,owner_id) values('school-assets','unrelated-fixture',$1) returning id", [actor.studentA])).toHaveLength(1);
  });

  it("rejects unassigned, school/owner forged and malformed paths, including null broadcast sections", async () => {
    for (const name of [key("B"), key("A", row.privateClassA, row.privateSectionA), `${actor.schoolA}/file.txt`, key().replace(row.A.section, "all")]) {
      await expect(upload(name)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(upload(key(), actor.parentA)).rejects.toMatchObject({ code: "42501" });
    await expect(api(actor.teacherA, "object.upload", "insert into storage.objects(bucket_id,name,owner_id) values('study-materials',$1,$2)", [key(), actor.teacherB]))
      .rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select app_private.material_file_scope(null) as scope")).rows).toEqual([{ scope: null }]);
  });

  it("requires a visible published metadata reference with a matching physical scope for families", async () => {
    const name = key();
    await upload(name);
    const materialId = randomUUID();
    await db.query("insert into public.study_materials(id,school_id,class_id,section_id,subject_id,teacher_id,title,file_url) values($1,$2,$3,$4,$5,$6,'File fixture',$7)",
      [materialId, actor.schoolA, row.A.class, row.A.section, row.A.subject, row.A.teacher, name]);
    expect(await files(actor.studentA, name)).toEqual([]);
    await db.query("update public.study_materials set published_at=now() where id=$1", [materialId]);
    expect(await files(actor.studentA, name)).toEqual([{ name }]);
    expect(await files(actor.parentA, name)).toEqual([{ name }]);
    expect(await files(actor.studentB, name)).toEqual([]);
    expect(await api(actor.teacherA, "object.delete_many", "delete from storage.objects where name=$1 returning id", [name])).toEqual([]);
    // A same-school, readable but mismatched class reference cannot declassify a different file.
    const privateName = key("A", row.privateClassA, row.privateSectionA);
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('study-materials',$1,$2)", [privateName, actor.teacherA]);
    await db.query("update public.study_materials set file_url=$2 where id=$1", [materialId, privateName]);
    expect(await files(actor.studentA, privateName)).toEqual([]);
  });

  it("allows published log attachments while drafts and unlinked objects remain private", async () => {
    const name = key();
    await upload(name);
    await db.query("update public.class_activities set attachment_url=$2 where id=$1", [row.A.activity, name]);
    expect(await files(actor.studentA, name)).toEqual([{ name }]);
    await db.query("update public.class_logs set status='draft' where id=$1", [row.A.log]);
    try { expect(await files(actor.studentA, name)).toEqual([]); }
    finally { await db.query("update public.class_logs set status='published' where id=$1", [row.A.log]); }
  });

  it("preserves office-authored school-wide published files without opening a teacher broadcast path", async () => {
    const name = `${actor.schoolA}/shared/${randomUUID()}.txt`;
    await upload(name, actor.adminA);
    await db.query("insert into public.study_materials(school_id,title,file_url,published_at) values($1,'Office shared file',$2,now())", [actor.schoolA, name]);
    expect(await files(actor.studentA, name)).toEqual([{ name }]);
    expect(await files(actor.parentA, name)).toEqual([{ name }]);
    expect(await files(actor.studentB, name)).toEqual([]);
    await expect(upload(`${actor.schoolA}/shared/${randomUUID()}.txt`)).rejects.toMatchObject({ code: "42501" });
  });

  it("prevents the owning teacher from replacing file bytes referenced by a pupil response", async () => {
    const name = key();
    await upload(name);
    await db.query("insert into public.activity_submissions(activity_id,student_id,file_url) values($1,$2,$3)", [row.A.activity, row.A.student, name]);
    expect(await api(actor.teacherA, "object.upload_update", "update storage.objects set metadata='{\"bytes\":99}' where name=$1 returning id", [name])).toEqual([]);
    expect((await db.query("select metadata from storage.objects where name=$1", [name])).rows).toEqual([{ metadata: { bytes: 1 } }]);
  });

  it("authorizes the provider's INSERT-on-conflict replacement probe without relaxing submission or scope guards", async () => {
    const name = key();
    await upload(name);
    const replace = (target: string) => api(actor.teacherA, "object.upload_update", `insert into storage.objects(bucket_id,name,owner_id,metadata)
      values('study-materials',$1,$2,'{"bytes":2}') on conflict(bucket_id,name) do update set metadata=excluded.metadata returning name`, [target, actor.teacherA]);
    expect(await replace(name)).toEqual([{ name }]);
    await expect(replace(key("B"))).rejects.toMatchObject({ code: "42501" });
    await db.query("update public.activity_submissions set file_url=$1 where activity_id=$2 and student_id=$3", [name, row.A.activity, row.A.student]);
    await expect(replace(name)).rejects.toMatchObject({ code: "42501" });
  });

  it("denies copy/move declassification and access after assignment revocation while family references survive", async () => {
    const name = key();
    await upload(name);
    await db.query("update public.class_activities set attachment_url=$2 where id=$1", [row.A.activity, name]);
    for (const operation of ["object.copy", "object.move", "object.sign_upload_url", ""]) {
      expect(await files(actor.teacherA, name, operation)).toEqual([]);
      expect(await files(actor.studentA, name, operation)).toEqual([]);
    }
    expect(await api(actor.teacherA, "object.move", "update storage.objects set bucket_id='school-assets' where name=$1 returning id", [name])).toEqual([]);
    await db.query("delete from public.teacher_subject_assignments where id=$1", [row.A.assignment]);
    expect(await files(actor.teacherA, name)).toEqual([]);
    expect(await files(actor.teacherA, name, "object.sign")).toEqual([]);
    expect(await files(actor.studentA, name)).toEqual([{ name }]);
    expect(await files(actor.parentA, name)).toEqual([{ name }]);
    expect(await api(actor.teacherA, "object.upload_update", "update storage.objects set metadata='{}' where name=$1 returning id", [name])).toEqual([]);
    expect(await files(actor.adminA, name)).toEqual([{ name }]);
    expect(await files(actor.adminB, name)).toEqual([]);
  });
});
