// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { ASSESSMENT_IDS, createAssessmentAccessDatabase } from "./assessment-access-fixture";
import { createLegacyRecordDatabase, LEGACY_IDS } from "./legacy-record-fixture";
import { asStaffActor, STAFF_IDS as actors, STAFF_ROWS as rows } from "./staff-scope-fixture";

const patches = [
  "20261105184935_freeze_legacy_client_mutations.sql",
  "20261105184937_revoke_assessment_access_on_role_removal.sql",
  "20261105184939_require_active_role_assignment_actor.sql",
  "20261105184942_atomic_student_account_activation.sql",
];
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const claimant = "30000000-0000-0000-0000-000000000701";
const privateFee = "30000000-0000-0000-0000-000000000702";

/** Compare canonical JSON text for every row, including money, links, saved
 * grades, raw audit payloads and timestamps, rather than just row counts. */
async function allPublicRows(db: PGlite) {
  const tables = (await db.query<{ name: string }>(`select c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' order by c.relname`)).rows;
  const snapshot: Record<string, string[]> = {};
  for (const table of tables) snapshot[table.name] = (await db.query<{ bytes: string }>(
    `select to_jsonb(rec)::text as bytes from public.${identifier(table.name)} rec order by to_jsonb(rec)::text`,
  )).rows.map((row) => row.bytes);
  return snapshot;
}

it("applies the security patches, notice versions and mark RPC in order without rewriting business history", async () => {
  const db = await createAssessmentAccessDatabase({ applyMigration: false });
  try {
    await createLegacyRecordDatabase({ applyMigration: false, database: db });
    await db.exec(`alter table auth.users add column email text, add column email_confirmed_at timestamptz,
      add column phone text, add column phone_confirmed_at timestamptz,
      add column is_anonymous boolean not null default false, add column banned_until timestamptz,
      add column deleted_at timestamptz`);
    const recovered = JSON.parse(await readFile(new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8")) as {
      routines: { schema: string; name: string; definition: string }[];
    };
    const oldActivation = recovered.routines.find((routine) => routine.schema === "public" && routine.name === "activate_student");
    if (!oldActivation) throw new Error("Recovered activation contract is missing.");
    await db.exec(oldActivation.definition);
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'chain-qa@example.test',now())", [claimant]);
    await db.query("insert into public.profiles(id,full_name) values($1,'Fresh chain claimant')", [claimant]);
    await db.query("update public.students set dob='2014-06-15',registered_mobile='9876543210' where id=$1", [rows.privateStudentA]);
    await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
      values($1,$2,$3,$4,'2026-11-05','absent',$5)`, [actors.schoolA, rows.A.year, rows.privateSectionA, rows.privateStudentA, actors.teacherA]);
    await db.query("insert into public.student_fees(id,school_id,student_id,fee_structure_id,amount) values($1,$2,$3,$4,750)", [privateFee, actors.schoolA, rows.privateStudentA, rows.A.structure]);
    await db.query("insert into public.fee_payments(school_id,student_id,student_fee_id,receipt_no,amount) values($1,$2,$3,'CHAIN-QA-RECEIPT',125)", [actors.schoolA, rows.privateStudentA, privateFee]);

    const before = await allPublicRows(db);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["payroll", "marks", "audit_logs", "teacher_assessments", "teacher_assessment_marks", "attendance", "fee_payments", "profiles", "user_roles"]));
    expect(patches).toEqual([...patches].sort());
    for (const filename of patches) {
      await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
      expect(await allPublicRows(db), filename).toEqual(before);
    }
    await db.exec(await readFile(new URL("../../supabase/migrations/20261105191227_notice_optimistic_versions.sql", import.meta.url), "utf8"));
    const withNoticeVersions = await allPublicRows(db);
    withNoticeVersions.notices = (await db.query<{ bytes: string }>(
      "select (to_jsonb(n)-'version')::text as bytes from public.notices n order by (to_jsonb(n)-'version')::text",
    )).rows.map((row) => row.bytes);
    expect(withNoticeVersions).toEqual(before);
    expect((await db.query<{ version: string }>("select version from public.notices")).rows.every((row) => typeof row.version === "string")).toBe(true);
    const beforeMarkRpc = await allPublicRows(db);
    await db.exec(await readFile(new URL("../../supabase/migrations/20261105192540_optimistic_assessment_mark_writes.sql", import.meta.url), "utf8"));
    expect(await allPublicRows(db)).toEqual(beforeMarkRpc);

    expect((await asStaffActor(db, actors.teacherA, "select id from public.teacher_assessments where id=$1", [ASSESSMENT_IDS.a])).rows).toEqual([{ id: ASSESSMENT_IDS.a }]);
    expect((await asStaffActor(db, actors.teacherA, "select marks_obtained from public.teacher_assessment_marks where assessment_id=$1", [ASSESSMENT_IDS.a])).rows).toEqual([{ marks_obtained: "35.00" }]);
    expect((await asStaffActor(db, actors.accountantA, "select id,net_salary from public.payroll")).rows).toEqual([{ id: LEGACY_IDS.A.payroll, net_salary: "61000.00" }]);
    expect((await asStaffActor(db, actors.adminA, "select id from public.marks")).rows).toEqual([{ id: LEGACY_IDS.A.mark }]);
    expect((await asStaffActor(db, actors.adminA, "select id from public.audit_logs")).rows).toEqual([{ id: LEGACY_IDS.A.audit }]);

    await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [actors.teacherA]);
    expect((await asStaffActor(db, actors.teacherA, "select id from public.teacher_assessments")).rows).toEqual([]);
    expect((await asStaffActor(db, actors.teacherA, "select id from public.teacher_assessment_marks")).rows).toEqual([]);
    expect((await asStaffActor(db, actors.teacherA, "update public.teacher_assessment_marks set marks_obtained=0 returning id")).rows).toEqual([]);
    expect((await db.query("select marks_obtained from public.teacher_assessment_marks where assessment_id=$1", [ASSESSMENT_IDS.a])).rows).toEqual([{ marks_obtained: "35.00" }]);
    await db.query("update public.profiles set is_active=false where id=$1", [actors.adminA]);
    await expect(asStaffActor(db, actors.adminA, "select public.assign_school_role($1,$2,'teacher'::public.app_role)", [actors.outsider, actors.schoolA])).rejects.toThrow(/active account/i);
    expect((await asStaffActor(db, actors.adminA, "select id from public.marks")).rows).toEqual([]);
    expect((await db.query("select id from public.user_roles where user_id=$1", [actors.outsider])).rows).toEqual([]);

    expect((await asStaffActor(db, claimant, "select student_id from public.attendance")).rows).toEqual([]);
    const history = await allPublicRows(db);
    expect((await asStaffActor(db, claimant, "select public.activate_student('PRIVATE-A','2014-06-15','9876543210') as id")).rows).toEqual([{ id: rows.privateStudentA }]);
    // Each actor helper commits, then opens a fresh transaction/JWT context.
    // This checks persisted reads after activation, not an in-memory response.
    for (let reload = 0; reload < 2; reload++) {
      expect((await asStaffActor(db, claimant, "select student_id,status from public.attendance")).rows).toEqual([{ student_id: rows.privateStudentA, status: "absent" }]);
      expect((await asStaffActor(db, claimant, "select student_id,receipt_no,amount from public.fee_payments")).rows).toEqual([{ student_id: rows.privateStudentA, receipt_no: "CHAIN-QA-RECEIPT", amount: "125.00" }]);
      expect((await asStaffActor(db, claimant, "select school_id,role from public.user_roles")).rows).toEqual([{ school_id: actors.schoolA, role: "student" }]);
      expect((await asStaffActor(db, claimant, "select id from public.marks")).rows).toEqual([]);
    }
    expect((await db.query("select profile_id from public.students where id=$1", [rows.privateStudentA])).rows).toEqual([{ profile_id: claimant }]);
    expect((await db.query("select school_id from public.profiles where id=$1", [claimant])).rows).toEqual([{ school_id: actors.schoolA }]);
    const afterActivation = await allPublicRows(db);
    for (const table of Object.keys(history).filter((table) => !["students", "profiles", "user_roles"].includes(table))) {
      expect(afterActivation[table], table).toEqual(history[table]);
    }
  } finally { await db.close(); }
}, 30_000);
