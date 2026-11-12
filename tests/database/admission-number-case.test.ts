// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRecoveryDatabase } from '../../scripts/database-recovery/replay.mjs';
import { recoveryIds as id, seedRecoveryData } from '../../scripts/database-recovery/synthetic-seed.mjs';

type PreviewRow = { row_number: number; admission_no: string; student_id: string | null; error: string | null };
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
  await db.exec('savepoint admission_case_actor');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [actor, JSON.stringify({ sub: actor, session_id: actor, aal: 'aal1', role: 'authenticated' })]);
    const result = await db.query<T>(sql, params);
    await db.exec('reset role;release savepoint admission_case_actor');
    return result.rows;
  } catch (error) {
    await db.exec('rollback to savepoint admission_case_actor;release savepoint admission_case_actor');
    throw error;
  }
}
async function owner(sql: string, params: unknown[] = []) {
  await db.exec('savepoint admission_case_owner');
  try { await db.query(sql, params); await db.exec('release savepoint admission_case_owner'); }
  catch (error) { await db.exec('rollback to savepoint admission_case_owner;release savepoint admission_case_owner'); throw error; }
}
const admit = (admission: string) =>
  as<{ id: string }>(id.adminA, "select public.admit_roster_student($1,$2,$3,$4,$5,'Case','Pupil') as id", [...scope(), admission]);
const count = async () => (await db.query<{ n: number }>('select count(*)::int n from public.students')).rows[0].n;
const preview = async (rows: unknown) => (await as<{ result: PreviewRow[] }>(id.adminA,
  'select public.preview_guardian_invitation_import($1,$2::jsonb) as result', [id.schoolA, JSON.stringify(rows)]))[0].result;
async function legacyDuplicate(admission: string) {
  const legacy = randomUUID();
  await db.exec('set local session_replication_role = replica');
  await db.query("insert into public.students(id,school_id,admission_no,first_name) values($1,$2,$3,'Legacy duplicate')", [legacy, id.schoolA, admission]);
  await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [legacy, id.yearA, id.classA, id.sectionA]);
  await db.exec('set local session_replication_role = origin');
  return legacy;
}

describe('case-insensitive admission numbers', () => {
  it('rejects an admission that differs from an existing one only by case or spacing', async () => {
    const before = await count();
    for (const admission of ['rec-a-001', ' Rec-A-002 ']) {
      await expect(admit(admission)).rejects.toMatchObject({ code: '23505', message: 'This admission number is already used in this school.' });
    }
    expect(await count()).toBe(before);
    expect((await admit('rec-b-001'))[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a CSV batch with case variants of one admission number and saves nothing', async () => {
    const before = await count();
    await expect(as(id.adminA, 'select public.import_roster_students($1,$2,$3,$4,$5,$6::jsonb)', [...scope(), randomUUID(), JSON.stringify([
      { admissionNumber: 'CASE-1', firstName: 'One', lastName: '' }, { admissionNumber: 'case-1', firstName: 'Two', lastName: '' },
    ])])).rejects.toMatchObject({ code: '23505' });
    expect(await count()).toBe(before);
  });

  it('takes CSV row locks in case-insensitive key order', async () => {
    // Byte order would process both 'B-1' rows before 'a-1'; lock-key order reaches 'A-1','a-1' first.
    await expect(as(id.adminA, 'select public.import_roster_students($1,$2,$3,$4,$5,$6::jsonb)', [...scope(), randomUUID(), JSON.stringify(
      ['B-1', 'a-1', 'B-1', 'A-1'].map(admissionNumber => ({ admissionNumber, firstName: 'Order', lastName: '' })),
    )])).rejects.toMatchObject({ code: '23505', message: 'Student 2 has an admission number already used in this school.' });
  });

  it('lets a class teacher register past a lowercase variant of the generated number', async () => {
    await admit('kc-st-001');
    const [row] = await as<{ admission_no: string }>(id.teacherA, "select * from public.register_student_for_class_teacher('Next Pupil')");
    expect(row.admission_no).toBe('KC-ST-002');
  });

  it('keeps legacy case collisions editable but blocks creating a new one by update', async () => {
    const legacy = await legacyDuplicate('rec-a-001');
    await owner("update public.students set first_name='Still editable', city='Delhi' where id=$1", [legacy]);
    await owner("update public.students set admission_no='REC-a-001' where id=$1", [legacy]);
    await expect(owner("update public.students set admission_no='rec-a-002' where id=$1", [legacy])).rejects.toMatchObject({ code: '23505' });
  });

  it('maps a mixed-case guardian CSV row to the pupil and imports it', async () => {
    const [row] = await preview([{ admissionNumber: ' rec-a-001 ', email: 'case-guardian@example.test' }]);
    expect(row).toMatchObject({ student_id: id.pupilA, error: null });
    const receipt = (await as<{ result: { invitations: { student_id: string }[] } }>(id.adminA,
      'select public.import_guardian_invitations($1,$2,$3,$4::jsonb) as result', [id.schoolA, randomUUID(), randomBytes(32).toString('hex'),
        JSON.stringify([{ admissionNumber: ' rec-a-001 ', email: 'case-guardian@example.test', studentId: id.pupilA }])]))[0].result;
    expect(receipt.invitations).toMatchObject([{ student_id: id.pupilA }]);
  });

  it('reports a legacy ambiguous admission number in the guardian preview without guessing a pupil', async () => {
    await legacyDuplicate('rec-a-001');
    const rows = await preview([{ admissionNumber: 'REC-A-001', email: 'ambiguous@example.test' }, { admissionNumber: 'rec-a-002', email: 'ok@example.test' }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ row_number: 1, student_id: null, error: 'This admission number matches more than one pupil. Ask the school office to correct the duplicate.' });
    expect(rows[1]).toMatchObject({ row_number: 2, student_id: id.unlinkedPupilA, error: null });
  });

  it('treats a repeated pupil/email pair as repeated regardless of admission case', async () => {
    const rows = await preview([{ admissionNumber: 'REC-A-001', email: 'pair@example.test' }, { admissionNumber: 'rec-a-001', email: 'pair@example.test' }]);
    expect(rows.map(row => row.error)).toEqual(['This student and email pair is repeated in the CSV.', 'This student and email pair is repeated in the CSV.']);
  });
});
