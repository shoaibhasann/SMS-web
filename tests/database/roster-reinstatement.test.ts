// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

type AuditPage = { events: { id: string; action: string; actor_name: string | null }[] };
const principal = '79100000-0000-0000-0000-000000000001', reception = '79100000-0000-0000-0000-000000000002';
const nextYear = '79100000-0000-0000-0000-000000000020';
let db: PGlite;
let enrollment: string;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role] of [[principal, 'principal'], [reception, 'reception_staff']] as const) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${role}@reinstate.invalid`]);
    await db.query('update public.profiles set school_id=$2,full_name=$3 where id=$1', [user, id.schoolA, `Reinstate ${role}`]);
    await db.query('insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)', [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  enrollment = (await db.query<{ id: string }>('select id from public.enrollments where student_id=$1', [id.pupilA])).rows[0].id;
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('savepoint reinstate_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint reinstate_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint reinstate_actor;release savepoint reinstate_actor');
    throw error;
  }
}
const withdraw = (actor = principal, reason = 'Family relocation') => as(actor,
  'select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,$6) as id', [id.schoolA, id.yearA, id.classA, id.sectionA, id.pupilA, reason]);
const reinstate = (actor = id.adminA, reason = 'Withdrawn by mistake') => as<{ id: string }>(actor,
  'select public.reinstate_roster_enrollment($1,$2,$3) as id', [id.schoolA, enrollment, reason]);
const status = async (row = enrollment) => (await db.query<{ status: string }>('select status from public.enrollments where id=$1', [row])).rows[0].status;
async function roster() {
  const today = (await db.query<{ day: string }>("select (now() at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
  const [{ value }] = await as<{ value: AuditPage }>(id.adminA,
    "select public.list_school_audit_events($1,$2::date,$2::date,'roster') as value", [id.schoolA, today]);
  return value.events;
}

describe('reinstating a withdrawn pupil', () => {
  it('lets only a School Admin or Principal reinstate, with a reason', async () => {
    await withdraw();
    for (const user of [id.teacherA, reception, id.adminB, id.guardianA]) {
      await expect(reinstate(user)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(reinstate(id.adminA, ' no ')).rejects.toMatchObject({ code: '22023' });
    expect(await status()).toBe('withdrawn');
    await expect(as(id.adminA, "update public.enrollments set status='active' where id=$1", [enrollment])).rejects.toMatchObject({ code: '42501' });
  });

  it('restores the same enrollment, keeps the withdrawal evidence and retries idempotently', async () => {
    await expect(reinstate()).rejects.toMatchObject({ code: '22023' });
    await withdraw();
    expect(await reinstate(principal, '  Withdrawn   by mistake ')).toEqual([{ id: enrollment }]);
    expect(await reinstate(principal)).toEqual([{ id: enrollment }]);
    await expect(reinstate(principal, 'A different reason')).rejects.toMatchObject({ code: '22023' });
    expect(await status()).toBe('active');
    expect((await db.query('select 1 from app_private.enrollment_withdrawals where enrollment_id=$1', [enrollment])).rows).toEqual([]);
    expect((await db.query(`select student_id,withdrawal_reason,withdrawn_by,reason,reinstated_by
      from app_private.enrollment_reinstatements where enrollment_id=$1`, [enrollment])).rows).toEqual([{
      student_id: id.pupilA, withdrawal_reason: 'Family relocation', withdrawn_by: principal,
      reason: 'Withdrawn by mistake', reinstated_by: principal,
    }]);
    expect(await as(id.adminA, 'select * from public.list_roster_withdrawals($1,$2,$3,$4)', [id.schoolA, id.yearA, id.classA, id.sectionA])).toEqual([]);
    await expect(as(id.adminA, 'select * from app_private.enrollment_reinstatements')).rejects.toMatchObject({ code: '42501' });
  });

  it('shows the withdrawal and reinstatement in the audit history and allows a later withdrawal', async () => {
    await withdraw();
    await reinstate();
    await withdraw(id.adminA, 'Left the city');
    const events = await roster();
    expect(events.map(event => event.action).sort()).toEqual([
      'Student enrollment reinstated', 'Student enrollment withdrawn', 'Student enrollment withdrawn',
    ]);
    expect(new Set(events.map(event => event.id)).size).toBe(3);
    expect(events.find(event => event.action === 'Student enrollment reinstated')?.actor_name).toBe('Synthetic admin-a');
    expect(await status()).toBe('withdrawn');
  });

  it('brings back the staged next-year promotion that the withdrawal cancelled', async () => {
    await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values($1,$2,'2027-28 Recovery','2027-04-01','2028-03-31',false)`, [nextYear, id.schoolA]);
    const staged = randomUUID();
    await db.query("insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id,status) values($1,$2,$3,$4,$5,'staged')",
      [staged, id.pupilA, nextYear, id.classA, id.sectionA]);
    await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,
      source_year_id,source_class_id,source_section_id,destination_enrollment_id,destination_year_id,destination_class_id,
      destination_section_id,change_kind,effective_date,reason,changed_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$7,'promotion','2027-04-01','Annual promotion',$10)`,
    [id.schoolA, randomUUID(), id.pupilA, enrollment, id.yearA, id.classA, id.sectionA, staged, nextYear, id.adminA]);
    await withdraw();
    expect(await status(staged)).toBe('cancelled');
    await reinstate();
    expect(await status(staged)).toBe('staged');
  });

  it('rejects reinstating a withdrawal from a session that is no longer current', async () => {
    await withdraw();
    await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values($1,$2,'2027-28 Recovery','2027-04-01','2028-03-31',false)`, [nextYear, id.schoolA]);
    await db.query('update public.academic_years set is_current=false where id=$1', [id.yearA]);
    await db.query('update public.academic_years set is_current=true where id=$1', [nextYear]);
    await expect(reinstate()).rejects.toMatchObject({ code: '22023' });
    expect(await status()).toBe('withdrawn');
  });
});
