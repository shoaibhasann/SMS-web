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
    after = null, role = "authenticated",
  }: {
    school?: string; user?: string; aal?: string; session?: string;
    after?: unknown; role?: "anon" | "authenticated" | "service_role";
  } = {},
) {
  await db.exec("savepoint export_actor");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, session_id: session, aal }),
    ]);
    const { rows } = await db.query<{ data: Record<string, unknown>[] }>(
      "select public.export_school_dataset($1,$2,$3::jsonb) as data", [school, dataset, after === null ? null : JSON.stringify(after)],
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
    expect(manifest).toEqual(expect.arrayContaining([
      { name: "students", order_key: "id" }, { name: "files", order_key: "source,source_id" },
      { name: "gate_attendance_days", order_key: "student_id,attendance_date" },
    ]));
    expect(names).toEqual(expect.arrayContaining([
      "students", "enrollments", "student_parents", "attendance", "class_activities", "activity_submissions",
      "fee_payments", "office_fee_payment_reversals", "assessment_result_submissions",
      "school_attendance_historical_days", "student_leave_requests", "files", "unavailable_files",
    ]));
    for (const name of names) {
      const rows = await exportPage(name);
      expect(rows.every((row) => !("school_id" in row) || row.school_id === id.schoolA)).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(1000);
    }
    expect((await exportPage("students")).map((row) => row.id)).toEqual([id.pupilA, id.unlinkedPupilA]);
    expect((await exportPage("fee_payments")).map((row) => row.id)).toEqual([id.paymentA]);
    expect(await exportPage("student_parents")).toEqual([
      expect.objectContaining({ student_id: id.pupilA, parent_id: id.parentA }),
    ]);
    expect(await exportPage("parents")).toEqual([expect.not.objectContaining({ guardian_code: "REC-GUARDIAN-A" })]);
    expect(await exportPage("teacher_assessment_marks")).toEqual([expect.objectContaining({ id: id.markA })]);
    // Score authorship (who entered the marks, separate from remark edits) is part of the result audit trail.
    expect(Object.keys((await exportPage("teacher_assessment_marks"))[0])).toContain("marks_entered_by");
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

  it("pages by keyset so live inserts and deletes never duplicate or shift rows", async () => {
    await db.query(`insert into public.students(school_id,admission_no,first_name)
      select $1, 'PORTABILITY-' || n, 'Test student' from generate_series(1,1010) n`, [id.schoolA]);
    const first = await exportPage("students");
    expect(first).toHaveLength(1000);
    const cursor = first.at(-1)!;
    // Gate scans and family writes keep landing mid-export: two rows sorting before the cursor and a deleted
    // page-1 row. Under OFFSET this net +1 shift repeated the cursor row on page 2.
    await db.query(`insert into public.students(id,school_id,admission_no,first_name) values
      ('00000000-0000-4000-8000-000000000000',$1,'PORTABILITY-LATE-1','Late'),
      ('00000000-0000-4000-8000-000000000001',$1,'PORTABILITY-LATE-2','Late')`, [id.schoolA]);
    await db.query("delete from public.students where id=(select id from public.students where admission_no like 'PORTABILITY-%' and id < $1 order by id limit 1)", [cursor.id]);
    const second = await exportPage("students", { after: cursor });
    expect(second).toHaveLength(12);
    // The exporter sends only the order-key fields; the page is the same as for the whole row.
    expect(await exportPage("students", { after: { id: cursor.id } })).toEqual(second);
    const ids = [...first, ...second].map((row) => row.id);
    expect(ids).toEqual([...new Set(ids)].sort());
    await expect(exportPage("students", { after: second.at(-1) })).resolves.toEqual([]);
  });

  it("rejects unknown datasets, malformed cursors and the old offset signature", async () => {
    for (const after of [{}, [], "x", { id: null }]) {
      await expect(exportPage("students", { after })).rejects.toMatchObject({ code: "22023" });
    }
    await expect(exportPage("manifest", { after: { id: id.pupilA } })).rejects.toMatchObject({ code: "22023" });
    // Cursor values are literals coerced to the key type, never SQL syntax.
    await expect(exportPage("students", { after: { id: "x') or (true" } })).rejects.toMatchObject({ code: "22P02" });
    await expect(exportPage("auth.users")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select to_regprocedure('public.export_school_dataset(uuid,text,integer)') as fn")).rows).toEqual([{ fn: null }]);
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
    const unavailable = await exportPage("unavailable_files");
    expect(unavailable).toEqual([
      { source: "schools", source_id: id.schoolA, bucket: "school-assets", reason: "unsupported_or_outside_school" },
      { source: "students", source_id: id.unlinkedPupilA, bucket: "school-assets", reason: "unsupported_or_outside_school" },
    ]);
    // Composite (source, source_id) keys page without gaps.
    expect(await exportPage("unavailable_files", { after: unavailable[0] })).toEqual([unavailable[1]]);
    const students = await exportPage("students");
    expect(students.every((row) => !("photo_url" in row))).toBe(true);
  });

  it("keeps roster admission, detail-edit, reinstatement and import history for the exporting school only", async () => {
    const scope = [id.schoolA, id.yearA, id.classA, id.sectionA];
    // Each RPC runs as the School Admin and stays in the test transaction so the next step sees it.
    const run = async (sql: string, params: unknown[]) => {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [id.adminA, JSON.stringify({ sub: id.adminA, session_id: id.adminA, aal: "aal2", role: "authenticated" })]);
      const { rows } = await db.query<{ value: string }>(sql, params);
      await db.exec("reset role");
      return rows[0]?.value;
    };
    const student = await run("select public.admit_roster_student($1,$2,$3,$4,'EXP-ROSTER-1','Export','Pupil','2014-06-15'::date,'9876543210') as value", scope);
    await run("select public.update_roster_student_details($1,$2,'Exported',null,'Pupil','2014-06-15'::date,'9876543210') as value", [id.schoolA, student]);
    await run("select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,'Family relocation') as value", [...scope, student]);
    const enrollment = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1", [student])).rows[0].id;
    await run("select public.reinstate_roster_enrollment($1,$2,'Withdrawn by mistake') as value", [id.schoolA, enrollment]);
    const request = randomUUID();
    await run("select public.import_roster_students($1,$2,$3,$4,$5,$6::jsonb)::text as value", [...scope, request,
      JSON.stringify([{ admissionNumber: "EXP-CSV-1", firstName: "Csv", lastName: "" }])]);
    const csvPupil = (await db.query<{ id: string }>("select id from public.students where admission_no='EXP-CSV-1'")).rows[0].id;

    // Another school's history must never appear in school A's archive.
    const enrollmentB = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1", [id.pupilB])).rows[0].id;
    await db.query("insert into app_private.student_admission_audit(student_id,school_id,admitted_by) values($1,$2,$3)", [id.pupilB, id.schoolB, id.adminB]);
    await db.query("insert into app_private.student_detail_changes(school_id,student_id,changed_fields,changed_by) values($1,$2,'{first_name}',$3)", [id.schoolB, id.pupilB, id.adminB]);
    await db.query(`insert into app_private.enrollment_reinstatements(enrollment_id,student_id,school_id,academic_year_id,class_id,section_id,
      withdrawal_reason,withdrawn_by,withdrawn_at,reason,reinstated_by) values($1,$2,$3,$4,$5,$6,'Other school',$7,now(),'Other school back',$7)`,
    [enrollmentB, id.pupilB, id.schoolB, id.yearB, id.classB, id.sectionB, id.adminB]);
    await db.query("insert into app_private.roster_import_receipts(school_id,request_id,payload_hash,student_count,imported_by) values($1,$2,'\\x00',1,$3)", [id.schoolB, randomUUID(), id.adminB]);

    const names = (await exportPage("manifest")).map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      "enrollment_reinstatements", "student_admission_audit", "student_detail_changes", "roster_import_receipts",
    ]));
    expect(await exportPage("enrollment_reinstatements")).toEqual([expect.objectContaining({
      enrollment_id: enrollment, student_id: student, school_id: id.schoolA, academic_year_id: id.yearA, class_id: id.classA,
      section_id: id.sectionA, withdrawal_reason: "Family relocation", withdrawn_by: id.adminA,
      withdrawn_at: expect.any(String), reason: "Withdrawn by mistake", reinstated_by: id.adminA, reinstated_at: expect.any(String),
    })]);
    expect(await exportPage("enrollment_withdrawals")).toEqual([]);
    expect(await exportPage("student_detail_changes")).toEqual([expect.objectContaining({
      school_id: id.schoolA, student_id: student, changed_fields: ["first_name"], changed_by: id.adminA, changed_at: expect.any(String),
    })]);
    expect((await exportPage("student_admission_audit")).map(({ student_id, school_id, admitted_by }) => ({ student_id, school_id, admitted_by })))
      .toEqual([{ student_id: student, school_id: id.schoolA, admitted_by: id.adminA }, { student_id: csvPupil, school_id: id.schoolA, admitted_by: id.adminA }]
        .sort((a, b) => a.student_id.localeCompare(b.student_id)));
    const receipts = await exportPage("roster_import_receipts");
    expect(receipts).toEqual([{
      school_id: id.schoolA, request_id: request, student_count: 1, imported_by: id.adminA, imported_at: expect.any(String),
    }]);
  });
});
