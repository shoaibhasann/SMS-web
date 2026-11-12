// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

let db: PGlite;
const staff = { reception: randomUUID(), accountant: randomUUID(), principal: randomUUID() };
const roles: Record<keyof typeof staff, string> = { reception: 'reception_staff', accountant: 'accountant', principal: 'principal' };
const office = () => [id.adminA, staff.reception, staff.accountant, staff.principal];

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [key, userId] of Object.entries(staff) as [keyof typeof staff, string][]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [userId, `${key}@guard.invalid`]);
    await db.query(`insert into public.profiles(id,school_id,full_name,email) values($1,$2,$3,$4)
      on conflict(id) do update set school_id=excluded.school_id`, [userId, id.schoolA, `Guard ${key}`, `${key}@guard.invalid`]);
    await db.query('insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)', [userId, id.schoolA, roles[key]]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('savepoint student_guard_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint student_guard_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint student_guard_actor;release savepoint student_guard_actor');
    throw error;
  }
}

const pupil = async () => (await db.query<Record<string, unknown>>(
  'select school_id,admission_no,status,dob::text,registered_mobile,first_name,middle_name,last_name,city from public.students where id=$1',
  [id.unlinkedPupilA])).rows[0];

describe('governed pupil identity and status', () => {
  it('rejects direct office updates of status, admission number, names, DOB, mobile and school', async () => {
    const before = await pupil();
    for (const actor of office()) {
      for (const [column, value] of [
        ['status', 'withdrawn'], ['admission_no', 'HIJACK'], ['dob', '2015-01-01'], ['registered_mobile', '9999999999'],
        ['first_name', 'Renamed'], ['middle_name', 'Middle'], ['last_name', 'Changed'], ['school_id', id.schoolB],
      ]) {
        await expect(as(actor, `update public.students set ${column}=$1 where id=$2 returning id`, [value, id.unlinkedPupilA]),
          `${actor} ${column}`).rejects.toMatchObject({ code: '42501' });
      }
    }
    expect(await pupil()).toEqual(before);
  });

  it('does not reveal whether another school uses an admission number', async () => {
    for (const actor of office()) {
      for (const probe of ['rec-b-001', 'REC-B-001', 'definitely-not-there-999']) {
        await expect(as(actor, 'update public.students set school_id=$1,admission_no=$2 where id=$3 returning id',
          [id.schoolB, probe, id.unlinkedPupilA]), `${actor} ${probe}`).rejects.toMatchObject({ code: '42501' });
      }
    }
  });

  it('keeps other demographic edits, the account-binding guard and owner/definer writes working', async () => {
    expect(await as(staff.reception, "update public.students set city='Delhi' where id=$1 returning city", [id.unlinkedPupilA]))
      .toEqual([{ city: 'Delhi' }]);
    expect(await as(id.adminA, "update public.students set city='Pune' where id=$1 returning city", [id.unlinkedPupilA]))
      .toEqual([{ city: 'Pune' }]);
    await expect(as(id.adminA, 'update public.students set profile_id=$1 where id=$2', [id.claimantA, id.unlinkedPupilA]))
      .rejects.toMatchObject({ code: '42501' });
    await db.query("update public.students set status='withdrawn',first_name='Owner edit' where id=$1", [id.unlinkedPupilA]);
    expect(await pupil()).toMatchObject({ status: 'withdrawn', first_name: 'Owner edit' });
  });
});

describe('pupil hard delete', () => {
  const history = async () => (await db.query<{ s: number; a: number; e: number; f: number }>(`select
    (select count(*)::int from public.students where id=$1) s, (select count(*)::int from public.attendance where student_id=$1) a,
    (select count(*)::int from public.enrollments where student_id=$1) e, (select count(*)::int from public.student_fees where student_id=$1) f`,
  [id.unlinkedPupilA])).rows[0];

  it('rejects a raw DELETE from every office role and keeps the pupil history', async () => {
    expect(await history()).toEqual({ s: 1, a: 1, e: 1, f: 1 });
    for (const actor of office()) {
      await expect(as(actor, 'delete from public.students where id=$1 returning id', [id.unlinkedPupilA]), actor)
        .rejects.toMatchObject({ code: '42501' });
    }
    expect(await history()).toEqual({ s: 1, a: 1, e: 1, f: 1 });
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ ok: boolean }>("select has_table_privilege($1,'public.students','DELETE') or has_table_privilege($1,'public.students','TRUNCATE') ok", [role])).rows[0].ok).toBe(false);
    }
  });
});
