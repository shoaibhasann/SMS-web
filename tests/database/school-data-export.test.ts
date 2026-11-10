// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = randomUUID();
const studentPhoto = `${id.schoolA}/students/photo.png`;
const crossSchoolPhoto = `${id.schoolB}/students/foreign.png`;
const badPath = `${id.schoolA}/../${id.schoolB}/students/foreign.png`;

async function exportPage(
  dataset: string,
  {
    school = id.schoolA, user = id.adminA, aal = "aal2", session = user,
    offset = 0, role = "authenticated",
  }: {
    school?: string; user?: string; aal?: string; session?: string;
    offset?: number | null; role?: "anon" | "authenticated" | "service_role";
  } = {},
) {
  await db.exec("savepoint export_actor");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, session_id: session, aal }),
    ]);
    const { rows } = await db.query<{ data: Record<string, unknown>[] }>(
      "select public.export_school_dataset($1,$2,$3) as data", [school, dataset, offset],
    );
    return rows[0].data;
  } finally {
    await db.exec("rollback to savepoint export_actor; release savepoint export_actor");
  }
}

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'principal@export.invalid',now())", [principal]);
  await db.query("update public.profiles set school_id=$1 where id=$2", [id.schoolA, principal]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal, id.schoolA]);
  for (const user of [id.adminA, id.adminB, principal, id.teacherA, id.guardianA, id.studentUserA]) {
    const factor = randomUUID();
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, user]);
    await db.query("insert into auth.sessions(id,user_id,aal,factor_id) values($1,$1,'aal2',$2)", [user, factor]);
  }
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("school data portability RPC", () => {
  it("compiles every approved dataset and exports only matching business rows", async () => {
    const manifest = await exportPage("manifest");
    const names = manifest.map(({ name }) => String(name));
    expect(names).toEqual([...new Set(names)].sort());
    expect(names).toEqual(expect.arrayContaining([
      "students", "enrollments", "student_parents", "attendance", "class_activities", "activity_submissions",
      "fee_payments", "office_fee_payment_reversals", "assessment_result_submissions",
      "school_attendance_historical_days", "student_leave_requests", "files", "unavailable_files",
    ]));
    for (const name of names) {
      const rows = await exportPage(name);
      expect(rows.every((row) => !("school_id" in row) || row.school_id === id.schoolA)).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(250);
    }
    expect((await exportPage("students")).map((row) => row.id)).toEqual([id.pupilA, id.unlinkedPupilA]);
    expect((await exportPage("fee_payments")).map((row) => row.id)).toEqual([id.paymentA]);
    expect(await exportPage("student_parents")).toEqual([
      expect.objectContaining({ student_id: id.pupilA, parent_id: id.parentA }),
    ]);
    expect(await exportPage("parents")).toEqual([expect.not.objectContaining({ guardian_code: "REC-GUARDIAN-A" })]);
    expect(await exportPage("teacher_assessment_marks")).toEqual([expect.objectContaining({ id: id.markA })]);
  });

  it("rejects other schools, other roles, factor loss, and foreign or lower-assurance sessions", async () => {
    for (const options of [
      { school: id.schoolB }, { user: id.adminB }, { user: principal }, { user: id.teacherA },
      { user: id.guardianA }, { user: id.studentUserA }, { aal: "aal1" }, { session: id.adminB },
      { session: randomUUID() }, { role: "anon" as const }, { role: "service_role" as const },
    ]) {
      await expect(exportPage("students", options)).rejects.toMatchObject({ code: "42501" });
    }
    await db.query("update auth.mfa_factors set status='unverified' where user_id=$1", [id.adminA]);
    await expect(exportPage("students")).rejects.toMatchObject({ code: "42501" });
  });

  it("records an export attempt without including private audit metadata", async () => {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: id.adminA, session_id: id.adminA, aal: "aal2" }),
    ]);
    await db.query("select public.export_school_dataset($1,'manifest')", [id.schoolA]);
    await db.exec("reset role");
    expect((await db.query("select school_id,actor_user_id,action from public.audit_logs")).rows).toEqual([
      { school_id: id.schoolA, actor_user_id: id.adminA, action: "school_data_export_requested" },
    ]);
    expect(await exportPage("audit_logs")).toEqual([expect.objectContaining({ action: "school_data_export_requested" })]);
    expect((await exportPage("audit_logs"))[0]).not.toHaveProperty("ip_address");
  });

  it("paginates deterministically and rejects unknown datasets and bad offsets", async () => {
    await db.query(`insert into public.students(school_id,admission_no,first_name)
      select $1, 'PORTABILITY-' || n, 'Test student' from generate_series(1,260) n`, [id.schoolA]);
    const first = await exportPage("students");
    const second = await exportPage("students", { offset: 250 });
    expect(first).toHaveLength(250);
    expect(second).toHaveLength(12);
    const ids = [...first, ...second].map((row) => row.id);
    expect(ids).toEqual([...new Set(ids)].sort());
    await expect(exportPage("students", { offset: 500 })).resolves.toEqual([]);
    await expect(exportPage("students", { offset: null })).rejects.toMatchObject({ code: "22023" });
    await expect(exportPage("students", { offset: -1 })).rejects.toMatchObject({ code: "22023" });
    await expect(exportPage("auth.users")).rejects.toMatchObject({ code: "22023" });
  });

  it("exports same-school attachment references without leaking legacy tokens or cross-school paths", async () => {
    await db.query("update public.students set photo_url=$1 where id=$2", [
      `https://test.invalid/storage/v1/object/sign/school-assets/${studentPhoto}?token=ignored-signed-key`, id.pupilA,
    ]);
    await db.query("update public.students set photo_url=$1 where id=$2", [crossSchoolPhoto, id.unlinkedPupilA]);
    await db.query("update public.schools set logo_url=$1 where id=$2", [badPath, id.schoolA]);
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('school-assets',$1,'{\"size\":12}')", [studentPhoto]);
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('school-assets',$1,'{\"size\":44}')", [crossSchoolPhoto]);

    expect(await exportPage("files")).toEqual([
      { source: "students", source_id: id.pupilA, bucket: "school-assets", path: studentPhoto, name: null, byte_size: 12 },
    ]);
    expect(await exportPage("unavailable_files")).toEqual([
      { source: "schools", source_id: id.schoolA, bucket: "school-assets", reason: "unsupported_or_outside_school" },
      { source: "students", source_id: id.unlinkedPupilA, bucket: "school-assets", reason: "unsupported_or_outside_school" },
    ]);
    const students = await exportPage("students");
    expect(students.every((row) => !("photo_url" in row))).toBe(true);
  });
});
