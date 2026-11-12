// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

let db: PGlite;
const scope = () => [id.schoolA, id.yearA, id.classA, id.sectionA];

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('savepoint identity_format_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint identity_format_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint identity_format_actor;release savepoint identity_format_actor');
    throw error;
  }
}
async function owner(sql: string, params: unknown[] = []) {
  await db.exec('savepoint identity_format_owner');
  try { await db.query(sql, params); await db.exec('release savepoint identity_format_owner'); }
  catch (error) { await db.exec('rollback to savepoint identity_format_owner;release savepoint identity_format_owner'); throw error; }
}
const admit = (admission: string, first: string, last = 'Khan') =>
  as<{ id: string }>(id.adminA, 'select public.admit_roster_student($1,$2,$3,$4,$5,$6,$7) as id', [...scope(), admission, first, last]);
const count = async () => (await db.query<{ n: number }>('select count(*)::int n from public.students')).rows[0].n;

describe('pupil identity text guard', () => {
  it('rejects invisible bidi and isolate marks in admitted names and admission numbers', async () => {
    const before = await count();
    await expect(admit('FMT-001', '\u2068Ayaan\u2069')).rejects.toMatchObject({ code: '22023' });
    await expect(admit('FMT\u200e-002', 'Ayaan')).rejects.toMatchObject({ code: '22023' });
    await expect(admit('FMT-003', 'Ayaan', 'Kh\u202ean')).rejects.toMatchObject({ code: '22023' });
    expect(await count()).toBe(before);
    expect((await admit('FMT-004', 'Ayaan'))[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a CSV batch containing one marked row without saving any row', async () => {
    const before = await count();
    await expect(as(id.adminA, 'select public.import_roster_students($1,$2,$3,$4,$5,$6::jsonb)', [...scope(), randomUUID(), JSON.stringify([
      { admissionNumber: 'FMT-010', firstName: 'Clean', lastName: 'Row' },
      { admissionNumber: 'FMT-011', firstName: '\u2066Marked', lastName: 'Row' },
    ])])).rejects.toMatchObject({ code: '22023' });
    expect(await count()).toBe(before);
  });

  it('rejects marked names from teacher self-registration', async () => {
    const before = await count();
    await expect(as(id.teacherA, 'select * from public.register_student_for_class_teacher($1)', ['\u2068Reyansh\u2069 Verma']))
      .rejects.toMatchObject({ code: '22023' });
    expect(await count()).toBe(before);
  });

  it('keeps existing marked rows maintainable and allows cleaning, but not a new bad value', async () => {
    await db.exec("set local session_replication_role = replica");
    await db.query("update public.students set first_name=$1 where id=$2", ['\u2068Legacy\u2069', id.unlinkedPupilA]);
    await db.exec("set local session_replication_role = origin");
    await db.query("update public.students set status='withdrawn', city='Delhi' where id=$1", [id.unlinkedPupilA]);
    await db.query("update public.students set last_name='Kept' where id=$1", [id.unlinkedPupilA]);
    await expect(owner("update public.students set first_name=$1 where id=$2", ['Leg\u200facy', id.unlinkedPupilA]))
      .rejects.toMatchObject({ code: '22023' });
    await db.query("update public.students set first_name='Legacy' where id=$1", [id.unlinkedPupilA]);
    expect((await db.query('select first_name,status from public.students where id=$1', [id.unlinkedPupilA])).rows)
      .toEqual([{ first_name: 'Legacy', status: 'withdrawn' }]);
  });
});
