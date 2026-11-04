// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as fixtures } from "./staff-scope-fixture";

type Input = {
  employeeId: string; className: string; sectionName: string; subjectName: string; isClassTeacher: boolean;
  teacherId?: string; classId?: string; sectionId?: string; subjectId?: string;
};
type Preview = {
  row_number: number; employee_id: string; teacher_id: string | null; teacher_name: string | null;
  class_id: string | null; section_id: string | null; subject_id: string | null; error: string | null;
};
type Receipt = { request_id: string; assignment_count: number };
type History = Receipt & { assignment_ids: string[]; actor_name: string; created_at: string };

const { A, B, privateClassA, privateSectionA } = fixtures;
const previewSql = "select public.preview_teacher_assignment_import($1,$2,$3::jsonb) as result";
const importSql = "select public.import_teacher_assignments($1,$2,$3,$4::jsonb) as result";
const auditSql = "select public.list_teacher_assignment_imports($1,$2) as result";
const directory = new URL("../../supabase/migrations/", import.meta.url);
const newTeacher = randomUUID();
const alternateTeacher = randomUUID();
const gradeSixB = randomUUID();
const english = randomUUID();
const upcomingYear = randomUUID();
const base: Input = {
  employeeId: "CSV-TEACHER", teacherId: newTeacher, className: "Unassigned class", classId: privateClassA,
  sectionName: "A", sectionId: privateSectionA, subjectName: "Science", subjectId: A.subject, isClassTeacher: false,
};

describe("teacher assignment CSV import", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const files = await readdir(directory);
    async function apply(suffix: string) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error(`Missing migration: ${suffix}`);
      await db.exec(await readFile(new URL(file, directory), "utf8"));
    }
    await apply("_teacher_assessments_and_profile.sql");
    await apply("_repair_school_policy_helper.sql");
    await apply("_guardian_invitations.sql");
    await db.exec(`
      create function public.activate_teacher(text,text) returns uuid language sql security definer as 'select null::uuid';
      create function public.activate_accountant(text,text) returns uuid language sql security definer as 'select null::uuid';
      create table public.payroll (school_id uuid not null references public.schools(id), gross_salary numeric not null);
      alter table public.payroll enable row level security;
      grant select, update on public.payroll to authenticated;
      create policy tenant_isolation_payroll on public.payroll for all to authenticated
        using (school_id in (select public.current_user_school_ids()))
        with check (school_id in (select public.current_user_school_ids()));
    `);
    for (const suffix of [
      "_teacher_invitations.sql", "_guard_academic_year_setup.sql", "_govern_attendance_corrections.sql",
      "_withdraw_roster_enrollment.sql", "_change_roster_placement.sql", "_activate_academic_year.sql",
      "_import_teacher_assignment_csv.sql",
    ]) await apply(suffix);

    await db.query(`insert into public.teachers(id,school_id,employee_id,full_name)
      values($1,$3,'CSV-TEACHER','CSV Teacher'),($2,$3,'CSV-ALTERNATE',null)`, [newTeacher, alternateTeacher, actors.schoolA]);
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'B')", [gradeSixB, actors.schoolA, A.class]);
    await db.query(`insert into public.subjects(id,school_id,name,is_active)
      values($1,$2,'English',true),($4,$2,'Archived subject',false),($5,$3,'Foreign subject',true)`,
    [english, actors.schoolA, actors.schoolB, randomUUID(), randomUUID()]);
    await db.query(`insert into public.classes(school_id,name,is_active) values($1,'Archived class',false)`, [actors.schoolA]);
    await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values($1,$2,'Next year','2027-04-01','2028-03-31',false)`, [upcomingYear, actors.schoolA]);
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  async function preview(rows: unknown, actor: string = actors.adminA, yearId: string = A.year) {
    const { rows: [row] } = await asStaffActor<{ result: Preview[] }>(db, actor, previewSql, [actors.schoolA, yearId, JSON.stringify(rows)]);
    return row.result;
  }

  async function importRows(rows: unknown, { actor = actors.adminA as string, year = A.year as string, request = randomUUID() } = {}) {
    const { rows: [row] } = await asStaffActor<{ result: Receipt }>(
      db, actor, importSql, [actors.schoolA, year, request, JSON.stringify(rows)],
    );
    return row.result;
  }

  async function history(actor: string = actors.adminA, year: string = A.year) {
    const { rows: [row] } = await asStaffActor<{ result: History[] }>(db, actor, auditSql, [actors.schoolA, year]);
    return row.result;
  }

  it("previews exact current-school matches and rejects unauthorized, inactive and mismatched entries", async () => {
    const original = await db.query("select id from public.teacher_subject_assignments order by id");
    const rows = [
      { ...base, employeeId: " CSV-TEACHER ", className: " Unassigned class " },
      { ...base, employeeId: "TEACHER-B" },
      { ...base, employeeId: "csv-teacher" },
      { ...base, sectionName: "B" },
      { ...base, subjectName: "Foreign subject" },
      { ...base, subjectName: "Archived subject" },
      { ...base, className: "Archived class" },
      { ...base, isClassTeacher: "false" },
      { ...base, employeeId: "CSV-ALTERNATE" },
    ];
    for (const actor of [actors.teacherA, actors.accountantA, actors.adminB]) {
      await expect(preview(rows, actor)).rejects.toMatchObject({ code: "42501" });
      await expect(importRows(rows, { actor })).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asStaffActor(db, null, previewSql, [actors.schoolA, A.year, JSON.stringify(rows)], "anon"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(preview(rows, actors.adminA, B.year)).rejects.toMatchObject({ code: "22023" });
    await expect(importRows(rows, { year: upcomingYear })).rejects.toMatchObject({ code: "22023" });
    await expect(preview(Array(51).fill(base))).rejects.toMatchObject({ code: "22023" });

    expect(await preview(rows, actors.principalA)).toEqual([
      expect.objectContaining({ row_number: 1, teacher_id: newTeacher, class_id: privateClassA, section_id: privateSectionA, subject_id: A.subject, error: null }),
      expect.objectContaining({ row_number: 2, teacher_id: null, error: expect.stringContaining("No teacher") }),
      expect.objectContaining({ row_number: 3, teacher_id: null, error: expect.stringContaining("No teacher") }),
      expect.objectContaining({ row_number: 4, section_id: null, error: expect.stringContaining("No section") }),
      expect.objectContaining({ row_number: 5, subject_id: null, error: expect.stringContaining("No active subject") }),
      expect.objectContaining({ row_number: 6, subject_id: null, error: expect.stringContaining("No active subject") }),
      expect.objectContaining({ row_number: 7, class_id: null, error: expect.stringContaining("No active class") }),
      expect.objectContaining({ row_number: 8, error: expect.stringContaining("true or false") }),
      expect.objectContaining({ row_number: 9, teacher_id: alternateTeacher, teacher_name: "CSV-ALTERNATE", error: null }),
    ]);
    expect((await db.query("select id from public.teacher_subject_assignments order by id")).rows).toEqual(original.rows);
  });

  it("detects duplicate tuples and class teacher conflicts across the batch and existing records", async () => {
    const gradeSixA: Input = { ...base, className: "Class 6", classId: A.class, sectionId: A.section };
    const linked: Input = { ...base, employeeId: "TEACHER-A", teacherId: A.teacher };
    const alternate: Input = { ...base, employeeId: "CSV-ALTERNATE", teacherId: alternateTeacher, subjectName: "English", subjectId: english };

    expect((await preview([base, { ...base, isClassTeacher: true }])).every(({ error }) => error?.includes("repeat in the CSV"))).toBe(true);
    expect((await preview([{ ...base, isClassTeacher: true }, { ...gradeSixA, isClassTeacher: true }]))
      .every(({ error }) => error?.includes("multiple class teacher duties"))).toBe(true);
    expect((await preview([{ ...base, isClassTeacher: true }, { ...alternate, isClassTeacher: true }]))
      .every(({ error }) => error?.includes("section has multiple class teachers"))).toBe(true);
    expect((await preview([{ ...gradeSixA, isClassTeacher: true }]))[0].error).toContain("section already has a class teacher");
    expect((await preview([{ ...linked, isClassTeacher: true }]))[0].error).toContain("teacher already has a class teacher duty");
    expect((await preview([{ ...gradeSixA, employeeId: linked.employeeId, teacherId: linked.teacherId }]))[0].error).toContain("assignment already exists");
    await expect(importRows([base, base])).rejects.toThrow("Assignment import row 1");
    expect(await history()).toEqual([]);
  });

  it("revalidates reviewed IDs and rolls back earlier writes when a later row fails", async () => {
    const second = { ...base, subjectName: "English", subjectId: english };
    await expect(importRows([base, { ...second, subjectId: B.subject }])).rejects.toThrow("row 2 changed since preview");
    expect((await db.query("select id from public.teacher_subject_assignments where teacher_id=$1", [newTeacher])).rows).toEqual([]);
    await db.exec(`
      create function app_private.test_reject_assignment_csv() returns trigger language plpgsql as $$
      begin
        if new.subject_id = '${english}' then raise exception 'Test second assignment failure'; end if;
        return new;
      end;
      $$;
      create trigger test_reject_assignment_csv before insert on public.teacher_subject_assignments
      for each row execute function app_private.test_reject_assignment_csv();
    `);
    try {
      await expect(importRows([base, second])).rejects.toThrow("Test second assignment failure");
      expect((await db.query("select id from public.teacher_subject_assignments where teacher_id=$1", [newTeacher])).rows).toEqual([]);
      expect(await history()).toEqual([]);
    } finally {
      await db.exec("drop trigger test_reject_assignment_csv on public.teacher_subject_assignments; drop function app_private.test_reject_assignment_csv()");
    }
  });

  it("replays one audited batch and exposes only each linked teacher's assignments", async () => {
    const request = randomUUID();
    const own: Input = {
      ...base, employeeId: "TEACHER-A", teacherId: A.teacher, className: "Class 6", classId: A.class,
      sectionName: "B", sectionId: gradeSixB, subjectName: "English", subjectId: english,
    };
    const rows = [{ ...base, isClassTeacher: true }, own];
    const result = await importRows(rows, { actor: actors.principalA, request });
    expect(result).toEqual({ request_id: request, assignment_count: 2 });
    expect(await importRows(rows, { actor: actors.principalA, request })).toEqual(result);
    await expect(importRows(rows, { actor: actors.adminA, request })).rejects.toMatchObject({ code: "23505" });
    await expect(importRows([...rows].reverse(), { actor: actors.principalA, request })).rejects.toMatchObject({ code: "23505" });
    await expect(importRows(rows)).rejects.toMatchObject({ code: "22023" });

    const audit = await history();
    expect(audit).toEqual([expect.objectContaining({ request_id: request, assignment_count: 2, actor_name: "principalA" })]);
    expect(audit[0].assignment_ids).toHaveLength(2);
    expect((await asStaffActor(db, actors.teacherA, "select id from public.teacher_subject_assignments where id=any($1)", [audit[0].assignment_ids])).rows)
      .toEqual([{ id: audit[0].assignment_ids[1] }]);
    expect((await asStaffActor(db, actors.adminB, "select id from public.teacher_subject_assignments where id=any($1)", [audit[0].assignment_ids])).rows)
      .toEqual([]);
    await expect(history(actors.adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(history(actors.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.adminA, "select * from app_private.teacher_assignment_imports")).rejects.toMatchObject({ code: "42501" });

    await db.query("update public.academic_years set is_current=false where id=$1", [A.year]);
    await db.query("update public.academic_years set is_current=true where id=$1", [upcomingYear]);
    expect(await importRows(rows, { actor: actors.principalA, request })).toEqual(result);
    expect(await history()).toEqual(audit);
    expect(await history(actors.adminA, upcomingYear)).toEqual([]);
    expect((await preview(rows, actors.adminA, upcomingYear)).every(({ error }) => error === null)).toBe(true);
    expect(await importRows(rows, { year: upcomingYear })).toMatchObject({ assignment_count: 2 });
  });
});
