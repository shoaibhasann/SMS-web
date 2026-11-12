// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('savepoint pending_withdraw_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint pending_withdraw_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint pending_withdraw_actor;release savepoint pending_withdraw_actor');
    throw error;
  }
}
const withdraw = () => as<{ id: string }>(id.adminA, 'select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,$6) as id',
  [id.schoolA, id.yearA, id.classA, id.sectionA, id.pupilA, 'Family relocation']);
const status = async () => (await db.query<{ status: string }>(
  'select status from public.enrollments where student_id=$1 and academic_year_id=$2', [id.pupilA, id.yearA])).rows[0].status;
async function correction(yearId = id.yearA) {
  const correctionId = randomUUID();
  await db.query(`insert into app_private.attendance_corrections(id,school_id,academic_year_id,section_id,student_id,
    attendance_date,requested_by,request_reason,requested_status) values($1,$2,$3,$4,$5,current_date-1,$6,'Was present','present')`,
  [correctionId, id.schoolA, yearId, id.sectionA, id.pupilA, id.teacherA]);
  return correctionId;
}

describe('withdrawal with pending attendance corrections', () => {
  it('blocks the withdrawal until the correction is reviewed', async () => {
    const pending = await correction();
    await expect(withdraw()).rejects.toMatchObject({ code: '55000', message: expect.stringMatching(/pending attendance corrections/) });
    expect(await status()).toBe('active');
    await db.query(`update app_private.attendance_corrections set state='rejected',reviewed_by=$2,reviewed_at=now(),
      review_reason='Not needed' where id=$1`, [pending, id.adminA]);
    const [{ id: enrollment }] = await withdraw();
    expect(enrollment).toMatch(/^[0-9a-f-]{36}$/);
    expect(await status()).toBe('withdrawn');
    expect(await withdraw()).toEqual([{ id: enrollment }]);
  });

  it('ignores a pending correction from another academic year', async () => {
    const otherYear = randomUUID();
    await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values($1,$2,'2024-25 Recovery','2024-04-01','2025-03-31',false)`, [otherYear, id.schoolA]);
    await correction(otherYear);
    await withdraw();
    expect(await status()).toBe('withdrawn');
  });
});
