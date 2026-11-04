// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const { adminA, adminB, principalA, teacherA, accountantA, schoolA, schoolB } = STAFF_IDS;
const teacher = (employeeId: string, fullName = "Test Teacher") => ({ employeeId, fullName, staffType: "teacher" });
const staff = (employeeId: string, fullName = "Test Staff") => ({ employeeId, fullName, staffType: "staff" });

describe("audited school staff CSV import", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({
      includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true,
    });
    await db.exec(`
      create function public.activate_teacher(text,text) returns uuid language sql security definer as 'select null::uuid';
      create function public.activate_accountant(text,text) returns uuid language sql security definer as 'select null::uuid';
      create table public.payroll (school_id uuid not null references public.schools(id));
      alter table public.payroll enable row level security;
      create policy tenant_isolation_payroll on public.payroll for all to authenticated
        using (school_id in (select public.current_user_school_ids()))
        with check (school_id in (select public.current_user_school_ids()));
      create table public.staff (
        id uuid primary key default gen_random_uuid(),
        school_id uuid not null references public.schools(id) on delete cascade,
        profile_id uuid references public.profiles(id) on delete set null,
        employee_id text not null,
        designation text,
        department text,
        joining_date date,
        created_at timestamptz not null default now(),
        unique(school_id, employee_id)
      );
      alter table public.staff enable row level security;
      grant all on public.staff to anon, authenticated, service_role;
      create policy tenant_isolation_staff on public.staff for all
        using (school_id in (select public.current_user_school_ids()))
        with check (school_id in (select public.current_user_school_ids()));
    `);
    const files = await readdir(migrations);
    for (const suffix of [
      "_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_teacher_invitations.sql",
      "_scope_teacher_directory.sql", "_secure_staff_directory.sql", "_import_school_staff.sql",
    ]) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error("Missing migration " + suffix);
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    }
  }, 30000);

  afterAll(async () => { await db?.close(); });

  const batch = (actor: string, rows: unknown, requestId: string = randomUUID(), school: string = schoolA) =>
    asStaffActor(db, actor, "select public.import_school_staff($1,$2,$3::jsonb) as result",
      [school, requestId, JSON.stringify(rows)]);

  const history = (actor: string, school: string = schoolA) =>
    asStaffActor(db, actor, "select * from public.list_school_staff_imports($1)", [school]);

  it("writes both directory types and one audit receipt, without accounts or roles", async () => {
    const request = randomUUID();
    const payload = [teacher(" CSV-T01 ", " Asha Sharma "), staff("CSV-S01", "रवि सिंह")];
    const beforeRoles = (await db.query("select count(*)::int as count from public.user_roles")).rows;
    const beforeUsers = (await db.query("select count(*)::int as count from auth.users")).rows;
    expect((await batch(principalA, payload, request)).rows).toEqual([{ result: { teacher_count: 1, staff_count: 1 } }]);
    expect((await batch(principalA, payload, request)).rows).toEqual([{ result: { teacher_count: 1, staff_count: 1 } }]);
    await expect(batch(principalA, [...payload, staff("CHANGED")], request)).rejects.toMatchObject({ code: "22023" });
    await expect(batch(adminA, payload, request)).rejects.toMatchObject({ code: "22023" });
    await expect(batch(adminB, payload, request)).rejects.toMatchObject({ code: "42501" });

    const employee = (table: string, id: string) => db.query(
      "select employee_id,full_name,profile_id,school_id from public." + table + " where employee_id=$1", [id],
    );
    expect((await employee("teachers", "CSV-T01")).rows).toEqual([
      { employee_id: "CSV-T01", full_name: "Asha Sharma", profile_id: null, school_id: schoolA },
    ]);
    expect((await employee("staff", "CSV-S01")).rows).toEqual([
      { employee_id: "CSV-S01", full_name: "रवि सिंह", profile_id: null, school_id: schoolA },
    ]);
    expect((await db.query("select count(*)::int as count from public.user_roles")).rows).toEqual(beforeRoles);
    expect((await db.query("select count(*)::int as count from auth.users")).rows).toEqual(beforeUsers);
    expect((await history(adminA)).rows).toEqual([
      expect.objectContaining({ request_id: request, teacher_count: 1, staff_count: 1, imported_by_name: "principalA" }),
    ]);
    expect((await history(adminB, schoolB)).rows).toEqual([]);
    await expect(history(adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(history(teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "select * from app_private.staff_import_receipts")).rejects.toMatchObject({ code: "42501" });
    expect((await asStaffActor(db, adminA, "select employee_id from public.staff where school_id=$1", [schoolA])).rows)
      .toEqual([{ employee_id: "CSV-S01" }]);
    expect((await asStaffActor(db, teacherA, "select employee_id from public.staff where school_id=$1", [schoolA])).rows)
      .toEqual([]);
  });

  it("rejects invalid, duplicate and unauthorized batches atomically across both directories", async () => {
    for (const actor of [teacherA, accountantA, adminB]) {
      await expect(batch(actor, [staff("FORBIDDEN")])).rejects.toMatchObject({ code: "42501" });
    }
    const key = randomUUID();
    await expect(batch(adminA, [staff("AAA-ROLLBACK"), staff(" teacher-a ")], key))
      .rejects.toThrow("Staff row 2 repeats an employee ID");
    await expect(batch(adminA, [teacher("DUPLICATE"), staff(" duplicate ")], key))
      .rejects.toMatchObject({ code: "23505" });
    await expect(batch(adminA, [teacher("AAA-ROLLBACK"), { ...staff("ZZZ-INVALID"), staffType: "school_admin" }], key))
      .rejects.toThrow("Staff row 2 needs a valid employee ID, full name and staff type");
    await expect(batch(adminA, [teacher("AAA-ROLLBACK"), { ...staff("ZZZ-EXTRA"), profileId: STAFF_IDS.outsider }], key))
      .rejects.toThrow("Staff row 2 has invalid fields");
    await expect(batch(adminA, Array.from({ length: 51 }, (_, index) => staff("TOO-MANY-" + index)), key))
      .rejects.toMatchObject({ code: "22023" });
    expect((await db.query(
      "select employee_id from public.staff where employee_id like 'AAA-%' union all select employee_id from public.teachers where employee_id like 'AAA-%' or employee_id='DUPLICATE'",
    )).rows).toEqual([]);
    expect((await db.query("select request_id from app_private.staff_import_receipts where request_id=$1", [key])).rows)
      .toEqual([]);
    expect((await batch(adminA, [staff("AAA-ROLLBACK")], key)).rows).toEqual([{ result: { teacher_count: 0, staff_count: 1 } }]);
  });

  it("shares the duplicate rules with individual teacher creation and preserves separate schools", async () => {
    const employeeId = "SAME-SCHOOL-ID";
    await batch(adminA, [staff(employeeId)]);
    const createSql = "select public.create_teacher_record($1,$2,'Test Teacher') as id";
    await expect(asStaffActor(db, adminA, createSql, [schoolA, " same-school-id "]))
      .rejects.toMatchObject({ code: "23505" });
    await expect(asStaffActor(db, adminA, "update public.teachers set employee_id='same-school-id' where id=$1",
      [STAFF_ROWS.A.teacher])).rejects.toMatchObject({ code: "23505" });
    expect((await asStaffActor(db, adminB, createSql, [schoolB, employeeId])).rows).toHaveLength(1);
    expect((await db.query("select school_id from public.teachers where employee_id=$1", [employeeId])).rows)
      .toEqual([{ school_id: schoolB }]);
  });
});
