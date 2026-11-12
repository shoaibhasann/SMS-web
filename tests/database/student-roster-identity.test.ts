// @vitest-environment node
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

type AuditPage = { events: { id: string; action: string; record_label: string }[] };
const principal = '79200000-0000-0000-0000-000000000001', reception = '79200000-0000-0000-0000-000000000002';
let db: PGlite;
const scope = () => [id.schoolA, id.yearA, id.classA, id.sectionA];

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const [user, role] of [[principal, 'principal'], [reception, 'reception_staff']] as const) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${role}@identity.invalid`]);
    await db.query('update public.profiles set school_id=$2,full_name=$3 where id=$1', [user, id.schoolA, `Identity ${role}`]);
    await db.query('insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)', [user, id.schoolA, role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

async function as<T>(actor: string, sql: string, params: unknown[] = []) {
  await db.exec('savepoint identity_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint identity_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint identity_actor;release savepoint identity_actor');
    throw error;
  }
}
const admit = (admission: string, dob: string | null = null, mobile: string | null = null, actor = id.adminA) =>
  as<{ id: string }>(actor, 'select public.admit_roster_student($1,$2,$3,$4,$5,$6,$7,$8::date,$9) as id',
    [...scope(), admission, 'Identity', 'Pupil', dob, mobile]).then(rows => rows[0].id);
const edit = (student: string, fields: { first?: string; middle?: string | null; last?: string | null; dob?: string | null; mobile?: string | null }, actor = id.adminA) =>
  as<{ id: string }>(actor, 'select public.update_roster_student_details($1,$2,$3,$4,$5,$6::date,$7) as id', [
    id.schoolA, student, fields.first ?? 'Identity', fields.middle ?? null, fields.last ?? 'Pupil', fields.dob ?? null, fields.mobile ?? null,
  ]);
const activate = (admission: string, dob: string, mobile: string) =>
  as<{ id: string }>(id.claimantA, 'select public.activate_student($1,$2::date,$3) as id', [admission, dob, mobile]);
const pupil = async (student: string) => (await db.query<{ first_name: string; middle_name: string | null; dob: string | null; registered_mobile: string | null }>(
  "select first_name,middle_name,dob::text as dob,registered_mobile from public.students where id=$1", [student])).rows[0];

describe('pupil DOB and registered mobile for Student activation', () => {
  it('stores DOB and a normalised mobile at admission so the pupil can activate', async () => {
    const student = await admit('ID-001', '2014-06-15', '+91 98765-43210');
    expect(await pupil(student)).toMatchObject({ dob: '2014-06-15', registered_mobile: '9876543210' });
    expect(await activate('id-001', '2014-06-15', '9876543210')).toEqual([{ id: student }]);
  });

  it('activates with the registered mobile typed in any normal Indian format', async () => {
    const student = await admit('ID-005', '2014-06-15', '9876543210');
    for (const typed of ['+91 98765 43210', '+919876543210', '919876543210', '09876543210', '98765-43210']) {
      expect(await activate('id-005', '2014-06-15', typed)).toEqual([{ id: student }]);
    }
  });

  it('keeps the generic failure for a wrong number, DOB or admission number and blocks linked pupils', async () => {
    await admit('ID-006', '2014-06-15', '9876543210');
    for (const [admission, dob, mobile] of [
      ['ID-006', '2014-06-15', '+91 98765 43211'], ['ID-006', '2014-06-15', '919876543210 1'],
      ['ID-006', '2014-06-16', '+919876543210'], ['ID-007', '2014-06-15', '09876543210'],
    ]) {
      await expect(activate(admission, dob, mobile)).rejects.toMatchObject({ message: 'Student verification failed' });
    }
    // REC-A-001 is already linked to another pupil account; the legacy stored number still matches exactly.
    await expect(activate('REC-A-001', '2014-06-15', '0000000000')).rejects
      .toMatchObject({ message: 'This account cannot activate this student. Contact the school office' });
  });

  it('rejects an invalid DOB or mobile without admitting', async () => {
    const tomorrow = (await db.query<{ day: string }>("select ((now() at time zone 'Asia/Kolkata')::date + 1)::text as day")).rows[0].day;
    await expect(admit('ID-002', tomorrow)).rejects.toMatchObject({ code: '22023', message: 'Enter a valid date of birth.' });
    await expect(admit('ID-002', '1899-12-31')).rejects.toMatchObject({ code: '22023' });
    for (const mobile of ['12345', '5876543210', 'call 9876543210']) {
      await expect(admit('ID-002', null, mobile)).rejects.toMatchObject({ code: '22023', message: 'Enter a valid 10-digit mobile number.' });
    }
    expect((await db.query("select 1 from public.students where admission_no='ID-002'")).rows).toEqual([]);
    expect(await pupil(await admit('ID-003', null, '  '))).toMatchObject({ dob: null, registered_mobile: null });
  });

  it('lets the office add DOB and mobile later, audited by field name only', async () => {
    const student = await admit('ID-010');
    await expect(activate('ID-010', '2015-01-20', '9123456780')).rejects.toThrow(/verification failed/);
    expect(await edit(student, { middle: ' Kumar ', dob: '2015-01-20', mobile: '09123456780' }, principal)).toEqual([{ id: student }]);
    expect(await pupil(student)).toMatchObject({ middle_name: 'Kumar', dob: '2015-01-20', registered_mobile: '9123456780' });
    expect(await edit(student, { middle: 'Kumar', dob: '2015-01-20', mobile: '9123456780' })).toEqual([{ id: student }]);
    expect((await db.query('select changed_fields,changed_by from app_private.student_detail_changes where student_id=$1', [student])).rows)
      .toEqual([{ changed_fields: ['middle_name', 'dob', 'registered_mobile'], changed_by: principal }]);
    const today = (await db.query<{ day: string }>("select (now() at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
    const [{ value }] = await as<{ value: AuditPage }>(id.adminA,
      "select public.list_school_audit_events($1,$2::date,$2::date,'roster') as value", [id.schoolA, today]);
    expect(value.events.filter(event => event.action === 'Student details updated'))
      .toEqual([expect.objectContaining({ record_label: `Student record ${student.slice(0, 8)}` })]);
    expect(await activate('ID-010', '2015-01-20', '9123456780')).toEqual([{ id: student }]);
  });

  it('keeps editing to School Admin and Principal of the same school, with valid names', async () => {
    const student = await admit('ID-020');
    for (const user of [id.teacherA, reception, id.guardianA, id.adminB, id.studentUserA]) {
      await expect(edit(student, { first: 'Changed' }, user)).rejects.toMatchObject({ code: '42501' });
      await expect(admit('ID-021', null, null, user)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(edit(student, { first: ' ' })).rejects.toMatchObject({ code: '22023' });
    await expect(edit(student, { first: 'A⁦B' })).rejects.toMatchObject({ code: '22023' });
    await expect(edit(id.pupilB, { first: 'Other school' })).rejects.toMatchObject({ code: '22023' });
    await expect(edit(student, { mobile: '123' })).rejects.toMatchObject({ code: '22023' });
    expect((await pupil(student)).first_name).toBe('Identity');
    await expect(as(id.adminA, 'update public.students set dob=$2 where id=$1', [student, '2014-01-01'])).rejects.toMatchObject({ code: '42501' });
    await expect(as(id.adminA, 'select * from app_private.student_detail_changes')).rejects.toMatchObject({ code: '42501' });
  });

  it('imports DOB and mobile from the student CSV and rejects a bad date for the whole batch', async () => {
    const importRows = (rows: object[]) => as<{ count: number }>(id.adminA, 'select public.import_roster_students($1,$2,$3,$4,$5,$6::jsonb) as count',
      [...scope(), randomUUID(), JSON.stringify(rows)]);
    await expect(importRows([
      { admissionNumber: 'ID-030', firstName: 'Csv', lastName: 'One', dateOfBirth: '2013-02-28', registeredMobile: '9988776655' },
      { admissionNumber: 'ID-031', firstName: 'Csv', lastName: 'Two' },
    ])).resolves.toEqual([{ count: 2 }]);
    const saved = (await db.query("select admission_no,dob::text as dob,registered_mobile from public.students where admission_no like 'ID-03%' order by 1")).rows;
    expect(saved).toEqual([
      { admission_no: 'ID-030', dob: '2013-02-28', registered_mobile: '9988776655' },
      { admission_no: 'ID-031', dob: null, registered_mobile: null },
    ]);
    for (const dateOfBirth of ['2013-02-30', '28/02/2013', 20130228]) {
      await expect(importRows([{ admissionNumber: 'ID-040', firstName: 'Bad', lastName: '', dateOfBirth }]))
        .rejects.toMatchObject({ code: '22023' });
    }
    expect((await db.query("select 1 from public.students where admission_no='ID-040'")).rows).toEqual([]);
  });

  it('fixes a name on a legacy-format mobile or out-of-range DOB without touching them, but validates changed values', async () => {
    const student = await admit('ID-050');
    // Legacy rows predate the format checks; write one directly past the student guards.
    await db.exec('set local session_replication_role = replica');
    await db.query("update public.students set registered_mobile='98765 43210',dob='1890-05-01' where id=$1", [student]);
    await db.exec('set local session_replication_role = origin');
    expect(await edit(student, { first: 'Idenity', dob: '1890-05-01', mobile: '98765 43210' })).toEqual([{ id: student }]);
    expect(await edit(student, { first: 'Identity', dob: '1890-05-01', mobile: '+91 98765-43210' })).toEqual([{ id: student }]);
    expect(await pupil(student)).toMatchObject({ first_name: 'Identity', dob: '1890-05-01', registered_mobile: '9876543210' });
    expect((await db.query('select changed_fields from app_private.student_detail_changes where student_id=$1 order by changed_at', [student])).rows)
      .toEqual([{ changed_fields: ['first_name'] }, { changed_fields: ['first_name'] }]);
    await expect(edit(student, { dob: '1890-05-01', mobile: '12345' })).rejects.toMatchObject({ code: '22023', message: 'Enter a valid 10-digit mobile number.' });
    await expect(edit(student, { dob: '1891-05-01', mobile: '98765 43210' })).rejects.toMatchObject({ code: '22023', message: 'Enter a valid date of birth.' });
    expect(await edit(student, { dob: '2014-05-01', mobile: '' })).toEqual([{ id: student }]);
    expect(await pupil(student)).toMatchObject({ dob: '2014-05-01', registered_mobile: null });
  });

  it('rewrites an unchanged legacy-format mobile to 10 digits without an audit row', async () => {
    // activate_student now normalises the stored mobile too (20261111191800), so legacy formats no longer
    // block activation before this rewrite; the rewrite still canonicalises the stored value.
    for (const [admission, legacy, sent] of [['ID-060', '+91 98765 43210', '9876543210'], ['ID-061', '09876543210', '09876543210']]) {
      const student = await admit(admission, '2014-06-15');
      await db.exec('set local session_replication_role = replica');
      await db.query('update public.students set registered_mobile=$2 where id=$1', [student, legacy]);
      await db.exec('set local session_replication_role = origin');
      expect(await edit(student, { dob: '2014-06-15', mobile: sent })).toEqual([{ id: student }]);
      expect((await pupil(student)).registered_mobile).toBe('9876543210');
      expect((await db.query('select 1 from app_private.student_detail_changes where student_id=$1', [student])).rows).toEqual([]);
    }
    // One claimant account activates one pupil, so prove the round trip on the first.
    expect(await activate('ID-060', '2014-06-15', '9876543210')).toEqual([expect.objectContaining({ id: expect.any(String) })]);
  });

  it('activates a pupil whose stored mobile is still in a legacy format, before any edit', async () => {
    const student = await admit('ID-062', '2014-06-15');
    await db.exec('set local session_replication_role = replica');
    await db.query("update public.students set registered_mobile='+91 98765 43210' where id=$1", [student]);
    await db.exec('set local session_replication_role = origin');
    expect(await activate('ID-062', '2014-06-15', '098765 43210')).toEqual([expect.objectContaining({ id: student })]);
  });
});

describe('school audit history in migration replay order', () => {
  it('lists roster events with migrations applied only through 20261111190202', async () => {
    const prior = await createRecoveryDatabase({ applyPending: false });
    try {
      const sources = await readRecoverySources(await readRecoveryManifest());
      const index = sources.findIndex(source => source.version === '20261111190202');
      expect(index).toBeGreaterThan(0);
      for (const source of sources.slice(0, index + 1).filter(source => source.kind === 'pending')) await prior.exec(source.sql);
      await seedRecoveryData(prior);
      await prior.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users on conflict do nothing");
      await prior.exec('begin;set local role authenticated');
      await prior.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
        [id.adminA, JSON.stringify({ sub: id.adminA, session_id: id.adminA, aal: 'aal1', role: 'authenticated' })]);
      const rows = (await prior.query<{ value: AuditPage }>(
        "select public.list_school_audit_events($1,d,d,'roster') as value from (select (now() at time zone 'Asia/Kolkata')::date as d) today", [id.schoolA])).rows;
      expect(Array.isArray(rows[0].value.events)).toBe(true);
      await prior.exec('rollback');
    } finally { await prior.close(); }
  }, 60_000);
});
