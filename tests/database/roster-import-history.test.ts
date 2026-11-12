// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

type ImportRow = { request_id: string; student_count: number; imported_by_name: string | null; imported_at: string | null };
type AuditPage = { events: { id: string; module: string; action: string; actor_name: string | null; record_label: string }[] };
const principal = '79000000-0000-0000-0000-000000000001', reception = '79000000-0000-0000-0000-000000000002';
let db: PGlite;
const scope = () => [id.schoolA, id.yearA, id.classA, id.sectionA];

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role] of [[principal, 'principal'], [reception, 'reception_staff']] as const) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${role}@history.invalid`]);
    await db.query('update public.profiles set school_id=$2,full_name=$3 where id=$1', [user, id.schoolA, `History ${role}`]);
    await db.query('insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)', [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('savepoint history_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint history_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint history_actor;release savepoint history_actor');
    throw error;
  }
}
const importBatch = (actor: string, request = randomUUID()) => as(actor, 'select public.import_roster_students($1,$2,$3,$4,$5,$6::jsonb)', [
  ...scope(), request, JSON.stringify([{ admissionNumber: `H-${request.slice(0, 6)}-1`, firstName: 'One', lastName: '' },
    { admissionNumber: `H-${request.slice(0, 6)}-2`, firstName: 'Two', lastName: '' }]),
]);
const history = (actor: string, school = id.schoolA) => as<ImportRow>(actor, 'select * from public.list_roster_imports($1)', [school]);

describe('student CSV import history', () => {
  it('records who imported each batch and when, newest first, with legacy receipts last', async () => {
    await db.query(`insert into app_private.roster_import_receipts(school_id,request_id,payload_hash,student_count)
      values($1,$2,'\\x00',3)`, [id.schoolA, '79000000-0000-0000-0000-0000000000aa']);
    await db.query('update app_private.roster_import_receipts set imported_by=null,imported_at=null');
    const first = randomUUID(), second = randomUUID();
    await importBatch(id.adminA, first);
    await importBatch(principal, second);
    await importBatch(principal, second);

    const rows = await history(id.adminA);
    expect(rows.map(row => [row.request_id, row.student_count, row.imported_by_name])).toEqual([
      [second, 2, 'History principal'], [first, 2, 'Synthetic admin-a'], ['79000000-0000-0000-0000-0000000000aa', 3, null],
    ]);
    expect(rows[0].imported_at).not.toBeNull();
    expect(rows[2].imported_at).toBeNull();
    expect((await history(principal)).length).toBe(3);
  });

  it.each([['teacher', id.teacherA], ['reception', reception], ['other school admin', id.adminB], ['guardian', id.guardianA]])(
    'denies the %s', async (_label, user) => {
      await importBatch(id.adminA);
      await expect(history(user)).rejects.toMatchObject({ code: '42501' });
    });

  it('records the actor of a single admission and shows it in the school audit history', async () => {
    const [{ id: student }] = await as<{ id: string }>(id.adminA,
      "select public.admit_roster_student($1,$2,$3,$4,'H-SINGLE-1','Single','Pupil') as id", scope());
    expect((await db.query('select admitted_by,school_id from app_private.student_admission_audit where student_id=$1', [student])).rows)
      .toEqual([{ admitted_by: id.adminA, school_id: id.schoolA }]);
    const today = (await db.query<{ day: string }>("select (now() at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
    const [{ value }] = await as<{ value: AuditPage }>(id.adminA,
      "select public.list_school_audit_events($1,$2::date,$2::date,'roster') as value", [id.schoolA, today]);
    expect(value.events).toEqual([expect.objectContaining({
      id: `student_admission:${student}:admitted`, module: 'roster', action: 'Student admitted',
      actor_name: 'Synthetic admin-a', record_label: `Student record ${student.slice(0, 8)}`,
    })]);
  });

  it('records CSV and class-teacher admissions but nothing for actor-less service inserts', async () => {
    await importBatch(id.adminA);
    await as(id.teacherA, "select * from public.register_student_for_class_teacher('Teacher Added')");
    // JWT settings are transaction-local, so clear them to model a service/seed insert with no signed-in actor.
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','',true)");
    await db.query("insert into public.students(school_id,admission_no,first_name) values($1,'H-SERVICE-1','Service')", [id.schoolA]);
    const rows = (await db.query<{ admitted_by: string; n: number }>(
      'select admitted_by,count(*)::int n from app_private.student_admission_audit group by admitted_by order by n desc')).rows;
    expect(rows).toEqual([{ admitted_by: id.adminA, n: 2 }, { admitted_by: id.teacherA, n: 1 }]);
  });

  it('keeps the new history private to its governed reader', async () => {
    for (const table of ['roster_import_receipts', 'student_admission_audit']) {
      await expect(as(id.adminA, `select * from app_private.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    const grants = (await db.query<{ nspname: string; definer: boolean; anon: boolean; client: boolean }>(`select n.nspname,p.prosecdef definer,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') client
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='list_roster_imports' order by 1`)).rows;
    expect(grants).toEqual([
      { nspname: 'app_private', definer: true, anon: false, client: true },
      { nspname: 'public', definer: false, anon: false, client: true },
    ]);
  });
});
