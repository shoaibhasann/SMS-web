import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecoveryDatabase } from '../database-recovery/replay.mjs';

if (process.argv.length > 2) throw new Error('This local seed check accepts no connection or output arguments.');
const sql = await readFile(new URL('./sms-design-qa.sql', import.meta.url), 'utf8');
const dryRunEnding = 'rollback; -- DRY RUN DEFAULT: replace only after root review/authorization.';
assert.ok(sql.trimEnd().endsWith(dryRunEnding), 'Seed must default to rollback.');
const commitSql = sql.replace(dryRunEnding, 'commit; -- Local synthetic verification only.');
const db = await createRecoveryDatabase({ applyPending: false });
const school = '7727a1bf-6330-4dbe-962e-b2bb50646c72';
const year = 'a1cc0cd2-ea75-4343-b500-049b4da4cc71';
const klass = '46eab875-8fd5-41f4-873e-766e605ca962';
const sectionA = 'b7d454e6-bbab-41fe-a0f5-e853b7d0b183', sectionB = '7f2a17dc-4a3a-4246-89a1-6245ba62c060';
const teacherRecord = 'd8a104e5-4134-414e-952d-a1dcdaf848a3', subject = 'd46fdddb-30d2-49a8-a02b-c77a5fa0cb10';
const admin = '139b388b-23b0-48f2-94ed-f3690ec0e17e', teacher = 'a0ec655b-0525-419f-953e-d8c2dfaaa678';
const guardian = '5dc6a52d-2184-4125-ab68-0bc0b057e8a4', student = '58f87936-9714-434d-8775-dbb2f6d88c51';
const pupil = 'a8f43624-20d6-41e1-90f7-ce6a2d5e9910', sibling = 'dd5ca9d8-934c-4c2b-9e51-efaffae70508', parent = '2529ac78-a0bb-434b-986f-7df87d4a36c8';
const count = async (table) => Number((await db.query(`select count(*) as count from ${table}`)).rows[0].count);
const snapshot = async () => {
  const tables = (await db.query(`select n.nspname as schema,c.relname as name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in('public','app_private','auth') order by 1,2`)).rows;
  const result = {};
  for (const table of tables) result[`${table.schema}.${table.name}`] = (await db.query(`select to_jsonb(r) as value from "${table.schema}"."${table.name}" r order by to_jsonb(r)::text`)).rows;
  return result;
};
try {
  await db.query("insert into public.schools(id,name,code) values($1,'Synthetic design fixture','ERP-FEE-CREDIT-QA-a852f1dc')", [school]);
  for (const [user, role] of [[admin, 'school_admin'], [teacher, 'teacher'], [guardian, 'parent'], [student, 'student']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [user, `${role}@design.invalid`]);
    await db.query('update public.profiles set school_id=$2,full_name=$3 where id=$1', [user, school, `Synthetic ${role}`]);
    await db.query('insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)', [user, school, role]);
  }
  await db.query(`insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
    values($1,$2,'Synthetic design year',(now()at time zone 'Asia/Kolkata')::date-180,(now()at time zone 'Asia/Kolkata')::date+180,true)`, [year, school]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Class6')", [klass, school]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$3,$4,'A'),($2,$3,$4,'B')", [sectionA, sectionB, school, klass]);
  await db.query("insert into public.subjects(id,school_id,name) values($1,$2,'Science')", [subject, school]);
  await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'DESIGN-TEACHER','Synthetic design teacher')", [teacherRecord, school, teacher]);
  await db.query(`insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
    values($1,$2,$3,$4,$5,true)`, [teacherRecord, year, klass, sectionA, subject]);
  for (const [pupilId, profileId, admission, section] of [[pupil, student, 'FCR-a852f1dc-001', sectionA], [sibling, null, 'FCR-a852f1dc-002', sectionB]]) {
    await db.query("insert into public.students(id,school_id,profile_id,admission_no,first_name) values($1,$2,$3,$4,'Existing QA pupil')", [pupilId, school, profileId, admission]);
    await db.query('insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)', [pupilId, year, klass, section]);
  }
  await db.query('insert into public.parents(id,school_id,profile_id) values($1,$2,$3)', [parent, school, guardian]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$3,'guardian'),($2,$3,'guardian')", [pupil, sibling, parent]);
  const structure = (await db.query("insert into public.fee_structures(school_id,academic_year_id,class_id,name,amount) values($1,$2,$3,'Existing fee',1000) returning id", [school, year, klass])).rows[0].id;
  await db.query("insert into public.student_fees(school_id,student_id,fee_structure_id,amount,due_date) values($1,$2,$3,1000,(now()at time zone 'Asia/Kolkata')::date+7)", [school, pupil, structure]);
  const before = await snapshot();
  await db.exec(sql);
  assert.deepEqual(await snapshot(), before, 'Default rollback must preserve every source row.');
  await db.exec(commitSql);
  const afterFirst = await snapshot();
  assert.equal(await count('public.students'), 42);
  assert.equal(await count('public.classes'), 3);
  assert.equal(await count('public.sections'), 6);
  assert.equal(await count('public.subjects'), 3);
  assert.equal(await count('public.teacher_subject_assignments'), 18);
  assert.equal(await count('public.attendance'), 42 * 30);
  const todayStatuses = (await db.query(`select a.status,count(*)::int as count from public.attendance a
    join public.students st on st.id=a.student_id where st.admission_no like 'SMS-DESIGN-QA-%'
      and a.attendance_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date group by a.status`)).rows;
  assert.equal(todayStatuses.reduce((sum, row) => sum + row.count, 0), 40);
  assert.deepEqual(new Set(todayStatuses.map((row) => row.status)), new Set(['present', 'absent', 'late', 'leave']));
  assert.equal(Number((await db.query(`select count(*) as count from public.attendance
    where student_id in($1,$2) and attendance_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date and status='present'`, [pupil, sibling])).rows[0].count), 2);

  assert.equal(await count('public.class_logs'), 6);
  assert.equal(await count('public.class_activities'), 14);
  assert.equal(await count('public.study_materials'), 2);
  assert.equal(await count('public.teacher_assessments'), 3);
  assert.equal(await count('public.teacher_assessment_marks'), 22);
  assert.equal(await count('public.notices'), 4);
  for (const table of ['auth.users', 'public.profiles', 'public.user_roles', 'public.parents', 'public.student_parents', 'public.student_fees', 'public.fee_payments', 'public.fee_refunds']) assert.deepEqual(afterFirst[table], before[table], `${table} must remain unchanged.`);
  await db.exec(commitSql);
  assert.deepEqual(await snapshot(), afterFirst, 'Second committed seed must not modify or duplicate any row.');
  await db.query("update public.schools set code='NOT-THIS-DEMO' where id=$1", [school]);
  const beforeDenied = await snapshot();
  await assert.rejects(db.exec(commitSql), /Expected founder demo school/);
  await db.exec('rollback');
  assert.deepEqual(await snapshot(), beforeDenied, 'Wrong-school preflight must fail without partial writes.');
  console.log(JSON.stringify({ passed: true, localOnly: true, checkpoint: true, newStudents: 40, classes: 3, sections: 6, subjects: 3,
    attendanceRows: 1260, todayDemoStatuses: todayStatuses, logs: 6, activities: 14, materials: 2, assessments: 3, marks: 22, notices: 4,
    dryRunPreservedAllRows: true, repeatPreservedAllRows: true, authLinksAndFinanceUnchanged: true, wrongSchoolRejected: true }));
} catch (error) { console.error(JSON.stringify({ passed: false, code: error.code, message: error.message, where: error.where })); process.exitCode=1; } finally { await db.close(); }
