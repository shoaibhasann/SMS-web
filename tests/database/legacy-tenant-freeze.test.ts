// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const LEGACY_TABLES = [
  "admissions", "communication_logs", "documents", "employees", "events", "exam_subjects", "exams",
  "inventory_items", "inventory_transactions", "leave_balances", "leave_requests", "library_books",
  "library_issues", "notification_logs", "notification_templates", "notifications", "report_cards",
  "role_activation_requests", "streams", "teacher_attendance", "transport_assignments", "transport_routes",
];
const BUCKETS = ["student-documents", "school-assets", "report-cards"];

let db: PGlite;
const principal = randomUUID(), finance = randomUUID(), reception = randomUUID();
const employeeA = randomUUID(), employeeB = randomUUID(), admissionA = randomUUID(), documentA = randomUUID();

async function actor<T extends Record<string, unknown> = Record<string, unknown>>(user: string, sql: string, args: unknown[] = []) {
  await db.exec("savepoint legacy_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.path','/rest/v1/legacy',true)",
      [user, JSON.stringify({ sub: user, session_id: user, aal: "aal1" })]);
    await db.query("select public.check_staff_mfa_request()");
    const result = await db.query<T>(sql, args);
    await db.exec("reset role;release savepoint legacy_actor");
    return result.rows;
  } catch (error) {
    await db.exec("rollback to savepoint legacy_actor;release savepoint legacy_actor");
    throw error;
  }
}
const ids = async (user: string, table: string) => (await actor<{ id: string }>(user, `select id from public.${table} order by id`)).map((row) => row.id);
const files = async (user: string) => (await actor<{ name: string }>(user, "select bucket_id||'/'||name as name from storage.objects where bucket_id = any($1) order by 1", [BUCKETS])).map((row) => row.name);
const deny = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "42501" });

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  for (const [user, role] of [[principal, "principal"], [finance, "accountant"], [reception, "reception_staff"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@legacy.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  await db.query("insert into public.employees(id,school_id,employee_id,salary) values($1,$2,'LEG-A',58000),($3,$4,'LEG-B',61000)", [employeeA, id.schoolA, employeeB, id.schoolB]);
  await db.query("insert into public.admissions(id,school_id,application_no,applicant_name,parent_phone) values($1,$2,'APP-1','Legacy applicant','9876500000')", [admissionA, id.schoolA]);
  await db.query("insert into public.documents(id,school_id,admission_id,document_type,file_path) values($1,$2,$3,'aadhaar',$4)", [documentA, id.schoolA, admissionA, `${id.schoolA}/other-pupil/aadhaar.pdf`]);
  for (const bucket of BUCKETS) {
    await db.query("insert into storage.objects(bucket_id,name) values($1,$2),($1,$3)", [bucket, `${id.schoolA}/other-pupil/aadhaar.pdf`, `${id.schoolB}/pupil/file.pdf`]);
  }
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

const ownFiles = BUCKETS.map((bucket) => `${bucket}/${id.schoolA}/other-pupil/aadhaar.pdf`).sort();

describe("legacy tenant tables and buckets are read-only office history", () => {
  it("denies Reception salary, admissions PII, documents and legacy files and every write", async () => {
    expect(await ids(reception, "employees")).toEqual([]);
    expect(await ids(reception, "admissions")).toEqual([]);
    expect(await ids(reception, "documents")).toEqual([]);
    expect(await files(reception)).toEqual([]);
    await deny(actor(reception, "update public.employees set salary=99999 where id=$1", [employeeA]));
    await deny(actor(reception, "insert into public.admissions(school_id,application_no,applicant_name) values($1,'APP-X','Forged')", [id.schoolA]));
    await deny(actor(reception, "delete from public.documents where id=$1", [documentA]));
    expect((await db.query("select salary from public.employees where id=$1", [employeeA])).rows).toEqual([{ salary: "58000.00" }]);
  });

  it("lets the Accountant read salary like payroll but not admissions or documents", async () => {
    expect(await ids(finance, "employees")).toEqual([employeeA]);
    expect(await ids(finance, "admissions")).toEqual([]);
    expect(await ids(finance, "documents")).toEqual([]);
    expect(await files(finance)).toEqual([]);
    await deny(actor(finance, "update public.employees set salary=1 where id=$1", [employeeA]));
  });

  it.each([["admin", id.adminA], ["principal", principal]])("lets an active %s read own-school history but never write it", async (_label, user) => {
    expect(await ids(user, "employees")).toEqual([employeeA]);
    expect(await ids(user, "admissions")).toEqual([admissionA]);
    expect(await ids(user, "documents")).toEqual([documentA]);
    expect(await files(user)).toEqual(ownFiles);
    await deny(actor(user, "update public.employees set salary=99999 where id=$1", [employeeA]));
    await deny(actor(user, "insert into public.admissions(school_id,application_no,applicant_name) values($1,'APP-Y','Forged')", [id.schoolA]));
    await deny(actor(user, "delete from public.admissions where id=$1", [admissionA]));
    expect(await actor(user, "delete from storage.objects where bucket_id='student-documents' returning id")).toEqual([]);
    expect(await actor(user, "update storage.objects set name=name||'.moved' where bucket_id='school-assets' returning id")).toEqual([]);
    await deny(actor(user, "insert into storage.objects(bucket_id,name) values('report-cards',$1)", [`${id.schoolA}/forged.pdf`]));
    expect((await db.query("select count(*)::int as n from storage.objects where bucket_id = any($1)", [BUCKETS])).rows).toEqual([{ n: 6 }]);
  });

  it("removes every legacy read from a disabled admin with a live session", async () => {
    await db.query("update public.profiles set is_active=false where id=$1", [id.adminA]);
    for (const table of ["employees", "admissions", "documents"]) expect(await ids(id.adminA, table)).toEqual([]);
    expect(await files(id.adminA)).toEqual([]);
    expect(await actor(id.adminA, "select public.current_user_school_ids() as school")).toEqual([]);
    await deny(actor(id.adminA, "update public.employees set salary=1 where id=$1", [employeeA]));
  });

  it("keeps schools scoped and keeps active office school names", async () => {
    expect(await ids(id.adminB, "employees")).toEqual([employeeB]);
    expect(await ids(id.adminB, "admissions")).toEqual([]);
    expect(await files(id.adminB)).toEqual(BUCKETS.map((bucket) => `${bucket}/${id.schoolB}/pupil/file.pdf`).sort());
    for (const user of [finance, reception]) expect(await ids(user, "schools")).toEqual([id.schoolA]);
    for (const user of [id.teacherA, id.guardianA, id.studentUserA]) {
      for (const table of ["employees", "admissions", "documents"]) expect(await ids(user, table)).toEqual([]);
      expect(await files(user)).toEqual([]);
    }
  });

  it("leaves only SELECT policies and no client write privileges on all 22 legacy tables", async () => {
    const writable = await db.query<{ table: string }>(`select t as table from unnest($1::text[]) t
      where has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('authenticated','public.'||t,'INSERT,UPDATE,REFERENCES')
        or has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,REFERENCES')`, [LEGACY_TABLES]);
    expect(writable.rows).toEqual([]);
    const policies = await db.query<{ tablename: string; policyname: string }>(`select tablename, policyname from pg_policies
      where schemaname='public' and tablename = any($1) and permissive='PERMISSIVE' and (cmd<>'SELECT' or with_check is not null)
      union all select tablename, policyname from pg_policies where schemaname='storage' and tablename='objects'
        and (qual ilike '%current_user_school_ids%' or with_check ilike '%current_user_school_ids%')`, [LEGACY_TABLES]);
    expect(policies.rows).toEqual([]);
  });
});
