// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

let db: PGlite;
const extra = { wholeTeacher: randomUUID(), siblingTeacher: randomUUID(), sibling: randomUUID(), oldYear: randomUUID(), oldTeacher: randomUUID() };
type View = { user_id: string; role: string; school_id: string; student_id: string; class_name: string | null;
  section_name: string | null; academic_year_name: string | null; teachers: { id: string; name: string; subjects: string[]; is_class_teacher: boolean }[] };

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  await db.query("update public.teachers set registered_mobile='9000000000' where id=$1", [id.teacherRecordA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Sibling B')", [extra.sibling, id.schoolA, id.classA]);
  await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date) values($1,$2,'Previous year','2025-04-01','2026-03-31')", [extra.oldYear, id.schoolA]);
  for (const [teacherId, name, year, section] of [
    [extra.wholeTeacher, 'Whole class teacher', id.yearA, null],
    [extra.siblingTeacher, 'Sibling section teacher', id.yearA, extra.sibling],
    [extra.oldTeacher, 'Previous year teacher', extra.oldYear, id.sectionA],
  ]) {
    await db.query('insert into public.teachers(id,school_id,employee_id,full_name) values($1,$2,$3,$4)', [teacherId, id.schoolA, teacherId, name]);
    await db.query('insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id) values($1,$2,$3,$4,$5)',
      [teacherId, year, id.classA, section, id.subjectA]);
  }
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function teachers(actor: string | null = id.guardianA, familyRole = 'parent', pupil = id.pupilA,
  dbRole: 'authenticated' | 'anon' | 'service_role' = 'authenticated', session = actor) {
  await db.exec('savepoint family_class_teacher_actor');
  try {
    await db.exec(`set local role ${dbRole}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor ?? '', JSON.stringify({ sub: actor, session_id: session, aal: 'aal1' })]);
    const result = await db.query<{ value: View }>('select public.get_family_class_teachers($1,$2) as value', [familyRole, pupil]);
    await db.exec('reset role;release savepoint family_class_teacher_actor');
    return result.rows[0].value;
  } catch (error) {
    await db.exec('rollback to savepoint family_class_teacher_actor;release savepoint family_class_teacher_actor');
    throw error;
  }
}

describe('family classroom teaching assignments', () => {
  it('returns active section class teacher and whole-class subject assignments only with minimal labels', async () => {
    const parent = await teachers();
    expect(parent).toEqual({ user_id: id.guardianA, role: 'parent', school_id: id.schoolA, student_id: id.pupilA,
      academic_year_name: '2026–27 Recovery', class_name: 'Recovery class 6', section_name: 'Recovery A', teachers: [
        { id: id.teacherRecordA, name: 'Synthetic recovery teacher', is_class_teacher: true, subjects: ['Recovery science'] },
        { id: extra.wholeTeacher, name: 'Whole class teacher', is_class_teacher: false, subjects: ['Recovery science'] },
      ] });
    expect(await teachers(id.studentUserA, 'student')).toEqual({ ...parent, user_id: id.studentUserA, role: 'student' });
  });
  it('blocks other children, school, roles and missing sessions', async () => {
    for (const request of [
      () => teachers(id.guardianA, 'parent', id.unlinkedPupilA), () => teachers(id.guardianA, 'parent', id.pupilB),
      () => teachers(id.studentUserA, 'student', id.unlinkedPupilA), () => teachers(id.guardianA, 'student'),
      () => teachers(id.adminA, 'parent'),
      () => teachers(id.guardianA, 'parent', id.pupilA, 'authenticated', randomUUID()),
      () => teachers(null, 'parent', id.pupilA, 'anon'), () => teachers(id.guardianA, 'parent', id.pupilA, 'service_role'),
    ]) await expect(request()).rejects.toMatchObject({ code: '42501' });
    await expect(teachers(id.teacherA, 'teacher')).rejects.toMatchObject({ code: '22023' });
  });
  it('rejects revoked guardian links while the student can still read', async () => {
    await db.query('delete from public.student_parents where parent_id=$1 and student_id=$2', [id.parentA, id.pupilA]);
    await expect(teachers()).rejects.toMatchObject({ code: '42501' });
    expect((await teachers(id.studentUserA, 'student')).teachers).toHaveLength(2);
  });
  it('changes teacher eligibility when staff deactivate or classroom placement changes', async () => {
    await db.query('update public.profiles set is_active=false where id=$1', [id.teacherA]);
    expect((await teachers()).teachers.map(row => row.id)).toEqual([extra.wholeTeacher]);
    await db.query('update public.enrollments set section_id=$1 where student_id=$2 and academic_year_id=$3', [extra.sibling, id.pupilA, id.yearA]);
    expect((await teachers()).teachers.map(row => row.id)).toEqual([extra.siblingTeacher, extra.wholeTeacher]);
    await db.query('update public.enrollments set section_id=null where student_id=$1 and academic_year_id=$2', [id.pupilA, id.yearA]);
    expect(await teachers()).toMatchObject({ section_name: null, teachers: [{ id: extra.wholeTeacher, is_class_teacher: false }] });
    await db.query('update public.academic_years set is_current=false where id=$1', [id.yearA]);
    expect(await teachers()).toMatchObject({ academic_year_name: null, class_name: null, section_name: null, teachers: [] });
  });
});
