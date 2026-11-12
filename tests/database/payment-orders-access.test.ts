// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

let db: PGlite;
const order = { A: randomUUID(), unlinkedA: randomUUID(), B: randomUUID() };
const office = { principal: randomUUID(), accountant: randomUUID(), reception_staff: randomUUID() };

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [role, user] of Object.entries(office)) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${role}@orders.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  for (const [orderId, school, pupil, fee] of [
    [order.A, id.schoolA, id.pupilA, id.feeA],
    [order.unlinkedA, id.schoolA, id.unlinkedPupilA, id.feeUnlinkedA],
    [order.B, id.schoolB, id.pupilB, id.feeB],
  ]) await db.query("insert into public.payment_orders(id,school_id,student_id,student_fee_id,amount,provider_order_id) values($1,$2,$3,$4,1500,$5)",
    [orderId, school, pupil, fee, `order_${orderId}`]);
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string | null, sql: string, params: unknown[] = [], dbRole: 'authenticated' | 'anon' = 'authenticated',
  session: string | null = actor) {
  await db.exec('savepoint payment_orders_actor');
  try {
    await db.exec(`set local role ${dbRole}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor ?? '', JSON.stringify({ sub: actor, session_id: session, aal: 'aal1' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint payment_orders_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint payment_orders_actor;release savepoint payment_orders_actor');
    throw error;
  }
}
const visible = async (actor: string, session: string | null = actor) =>
  (await as<{ id: string }>(actor, 'select id from public.payment_orders order by id', [], 'authenticated', session)).map(row => row.id).sort();
const family = [['student', id.studentUserA], ['parent', id.guardianA]] as const;
const insert = (actor: string, school: string, pupil: string) => as<{ id: string }>(actor,
  'insert into public.payment_orders(school_id,student_id,amount) values($1,$2,99) returning id', [school, pupil]);

describe('payment_orders row access', () => {
  it('lets families read only their own or linked pupil orders', async () => {
    expect(await visible(id.guardianA)).toEqual([order.A]);
    expect(await visible(id.studentUserA)).toEqual([order.A]);
    expect(await visible(id.teacherA)).toEqual([]);
  });

  it.each(family)('ends order reads when the %s role is removed (link kept)', async (role, user) => {
    await db.query('delete from public.user_roles where user_id=$1 and role=$2', [user, role]);
    expect(await visible(user)).toEqual([]);
  });

  it.each(family)('ends order reads when the %s profile is disabled', async (_role, user) => {
    await db.query('update public.profiles set is_active=false where id=$1', [user]);
    expect(await visible(user)).toEqual([]);
  });

  it.each(family)('ends order reads for a %s whose session is revoked or missing', async (_role, user) => {
    expect(await visible(user, null)).toEqual([]);
    await db.query('delete from auth.sessions where user_id=$1', [user]);
    expect(await visible(user)).toEqual([]);
  });

  it('gives families and teachers no write path to any order', async () => {
    for (const actor of [id.guardianA, id.studentUserA, id.teacherA]) {
      for (const target of [order.A, order.unlinkedA]) {
        expect(await as(actor, "update public.payment_orders set status='paid' where id=$1 returning id", [target])).toEqual([]);
        expect(await as(actor, 'delete from public.payment_orders where id=$1 returning id', [target])).toEqual([]);
      }
      await expect(insert(actor, id.schoolA, id.pupilA)).rejects.toMatchObject({ code: '42501' });
      await expect(insert(actor, id.schoolA, id.unlinkedPupilA)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(as(id.guardianA, 'truncate public.payment_orders')).rejects.toMatchObject({ code: '42501' });
    const rows = await db.query<{ status: string }>('select status from public.payment_orders order by id');
    expect(rows.rows.every(row => row.status === 'created')).toBe(true);
  });

  it('lets same-school office roles manage coherent orders only', async () => {
    expect(await visible(id.adminA)).toEqual([order.A, order.unlinkedA].sort());
    expect(await visible(id.adminB)).toEqual([order.B]);
    expect(await as(id.adminA, "update public.payment_orders set status='paid' where id=$1 returning status", [order.unlinkedA])).toEqual([{ status: 'paid' }]);
    expect(await as(id.adminA, "update public.payment_orders set status='paid' where id=$1 returning status", [order.B])).toEqual([]);
    expect(await insert(id.adminA, id.schoolA, id.pupilA)).toHaveLength(1);
    await expect(insert(id.adminA, id.schoolA, id.pupilB)).rejects.toMatchObject({ code: '42501' });
    await expect(as(id.adminA, 'insert into public.payment_orders(school_id,student_id,student_fee_id,amount) values($1,$2,$3,1)',
      [id.schoolA, id.pupilA, id.feeUnlinkedA])).rejects.toMatchObject({ code: '42501' });
  });

  it.each(Object.entries(office))('lets a same-school %s manage school A orders only', async (_role, user) => {
    expect(await visible(user)).toEqual([order.A, order.unlinkedA].sort());
    expect(await as(user, "update public.payment_orders set status='paid' where id=$1 returning status", [order.A])).toEqual([{ status: 'paid' }]);
    expect(await as(user, "update public.payment_orders set status='paid' where id=$1 returning status", [order.B])).toEqual([]);
    expect(await as(user, 'delete from public.payment_orders where id=$1 returning id', [order.B])).toEqual([]);
    expect(await insert(user, id.schoolA, id.pupilA)).toHaveLength(1);
    await expect(insert(user, id.schoolB, id.pupilB)).rejects.toMatchObject({ code: '42501' });
    await expect(insert(user, id.schoolA, id.pupilB)).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps anonymous callers out', async () => {
    await expect(as(null, 'select id from public.payment_orders', [], 'anon')).rejects.toMatchObject({ code: '42501' });
  });
});
