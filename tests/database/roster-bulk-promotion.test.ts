// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

const principal = '79200000-0000-0000-0000-000000000001', reception = '79200000-0000-0000-0000-000000000002';
const nextYear = '79200000-0000-0000-0000-000000000020';
const class7 = '79200000-0000-0000-0000-000000000030';
const section7A = '79200000-0000-0000-0000-000000000040', section7B = '79200000-0000-0000-0000-000000000041';
const reason = 'Annual promotion to Class 7';
const pupilCount = 60;
let db: PGlite;
let enrollments: { id: string; student_id: string; admission_no: string }[];

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role] of [[principal, 'principal'], [reception, 'reception_staff']] as const) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${role}@promote.invalid`]);
    await db.query('update public.profiles set school_id=$2,full_name=$3 where id=$1', [user, id.schoolA, `Promote ${role}`]);
    await db.query('insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)', [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
    values($1,$2,'2027–28 Promotion','2027-04-01','2028-03-31',false)`, [nextYear, id.schoolA]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Recovery class 7')", [class7, id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'A'),($4,$2,$3,'B')", [section7A, id.schoolA, class7, section7B]);
  await db.query(`with pupil as (
      insert into public.students(school_id,admission_no,first_name)
      select $1, 'BULK-' || lpad(n::text, 3, '0'), 'Bulk pupil ' || n from generate_series(3, $4::int) n returning id
    ) insert into public.enrollments(student_id,academic_year_id,class_id,section_id) select id,$2,$3,$5 from pupil`,
  [id.schoolA, id.yearA, id.classA, pupilCount, id.sectionA]);
  enrollments = (await db.query<{ id: string; student_id: string; admission_no: string }>(`select e.id,e.student_id,s.admission_no
    from public.enrollments e join public.students s on s.id=e.student_id
    where e.academic_year_id=$1 and e.section_id=$2 and e.status='active' order by s.admission_no`, [id.yearA, id.sectionA])).rows;
}, 90_000);
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('begin');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('commit');
    return result.rows;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}
const stage = (ids: string[], { actor = id.adminA, key = randomUUID(), text = reason, section = section7A, year = nextYear } = {}) =>
  as<{ result: { staged: number; already_staged: number } }>(actor,
    'select public.stage_section_promotions($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9) as result',
    [id.schoolA, id.classA, id.sectionA, ids, year, class7, section, text, key]).then((rows) => rows[0].result);
const preview = async () => (await as<{ checks: { unplaced: number; destination_count: number } }>(id.adminA,
  'select public.preview_academic_year_activation($1,$2,$3) as checks', [id.schoolA, id.yearA, nextYear]))[0].checks;
const placementRows = async () => (await db.query<{ count: number }>(
  'select count(*)::int as count from app_private.roster_placement_changes where school_id=$1', [id.schoolA])).rows[0].count;
const staged = async () => (await db.query<{ student_id: string; section_id: string }>(
  "select student_id,section_id from public.enrollments where academic_year_id=$1 and status='staged'", [nextYear])).rows;

describe('bulk section promotion staging', () => {
  it('rejects a destination year that does not start after the source year', async () => {
    const earlierYear = randomUUID(), overlappingYear = randomUUID();
    await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values($1,$3,'2025–26 Earlier','2025-04-01','2026-03-31',false),($2,$3,'2027 Overlap','2027-03-01','2028-02-28',false)`,
    [earlierYear, overlappingYear, id.schoolA]);
    const ids = enrollments.map((row) => row.id);
    for (const year of [id.yearA, earlierYear, overlappingYear, id.yearB, randomUUID()]) {
      await expect(stage(ids, { year })).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('later academic year') });
    }
    expect(await placementRows()).toBe(0);
    await db.query('delete from public.academic_years where id in ($1,$2)', [earlierYear, overlappingYear]);
  }, 90_000);
  it('stages a reviewed section in one audited, all-or-nothing and idempotent call', async () => {
    expect(enrollments).toHaveLength(pupilCount);
    const ids = enrollments.map((row) => row.id);
    for (const actor of [id.teacherA, reception, id.adminB, id.guardianA]) {
      await expect(stage(ids, { actor })).rejects.toMatchObject({ code: '42501' });
    }
    await expect(stage([])).rejects.toMatchObject({ code: '22023' });
    await expect(stage(ids, { text: ' no ' })).rejects.toMatchObject({ code: '22023' });
    await expect(stage([...ids.slice(0, 2), randomUUID()])).rejects.toMatchObject({ code: '22023' });
    await expect(stage([id.paymentA])).rejects.toMatchObject({ code: '22023' });

    // A pending correction on one pupil blocks the whole batch and names that pupil.
    const blocked = enrollments[10];
    const correction = randomUUID();
    await db.query(`insert into app_private.attendance_corrections
      (id,school_id,academic_year_id,section_id,student_id,attendance_date,requested_by,request_reason,requested_status)
      values ($1,$2,$3,$4,$5,'2026-11-05',$6,'Review register','present')`,
    [correction, id.schoolA, id.yearA, id.sectionA, blocked.student_id, id.teacherA]);
    await expect(stage(ids)).rejects.toMatchObject({ code: '55000', message: expect.stringContaining(`Pupil ${blocked.admission_no}:`) });
    expect(await placementRows()).toBe(0);
    expect(await staged()).toEqual([]);
    await db.query('delete from app_private.attendance_corrections where id=$1', [correction]);

    // An individual decision made through Change placement is kept, not overwritten.
    const individual = enrollments[0];
    await as(principal, 'select public.change_roster_placement($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id.schoolA, individual.id, id.classA, id.sectionA, nextYear, class7, section7B, 'Placed in 7-B by request', randomUUID()]);

    const excluded = enrollments[pupilCount - 1];
    const key = randomUUID();
    const batch = ids.filter((row) => row !== excluded.id);
    expect(await stage(batch, { key, text: '  Annual   promotion to Class 7 ' })).toEqual({ staged: pupilCount - 2, already_staged: 1 });
    expect(await preview()).toMatchObject({ unplaced: 1, destination_count: pupilCount - 1 });
    const rows = await placementRows();
    expect(rows).toBe(pupilCount - 1);
    expect((await staged()).find((row) => row.student_id === individual.student_id)).toEqual({ student_id: individual.student_id, section_id: section7B });
    expect((await staged()).some((row) => row.student_id === excluded.student_id)).toBe(false);
    expect((await db.query('select distinct reason,changed_by,change_kind from app_private.roster_placement_changes where reason=$1', [reason])).rows)
      .toEqual([{ reason, changed_by: id.adminA, change_kind: 'promotion' }]);

    // A dropped response is retried with the same request id.
    expect(await stage(batch, { key })).toEqual({ staged: pupilCount - 2, already_staged: 1 });
    expect(await placementRows()).toBe(rows);
    await expect(stage(batch, { key, section: section7B })).rejects.toMatchObject({ code: '23505' });

    expect(await stage([excluded.id], { actor: principal })).toEqual({ staged: 1, already_staged: 0 });
    expect(await preview()).toMatchObject({ unplaced: 0, destination_count: pupilCount });
  }, 90_000);
});
