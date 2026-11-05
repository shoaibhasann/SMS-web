// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAcademicPermissionDatabase } from "./academic-permissions-fixture";
import { asStaffActor, STAFF_IDS as actor, STAFF_ROWS } from "./staff-scope-fixture";

const { A, B } = STAFF_ROWS;
const extraSubject = randomUUID();
const otherTeacher = randomUUID();
const invalidLog = randomUUID();
const invalidMaterial = randomUUID();
const logFields = (overrides: Record<string, unknown> = {}) => ({
  school_id: actor.schoolA, academic_year_id: A.year, class_id: A.class, section_id: A.section,
  subject_id: A.subject, log_date: "2026-11-06", topic: "QA daily work", summary: "QA summary", status: "draft", ...overrides,
});
const homework = (overrides: Record<string, unknown> = {}) => ({ activity_type: "homework", title: "QA homework", max_marks: 10, ...overrides });

describe("academic exact-assignment permissions and atomic work saves", () => {
  let db: Awaited<ReturnType<typeof createAcademicPermissionDatabase>>;
  const rpc = (log: Record<string, unknown>, activities: unknown[] = [], user: string = actor.teacherA) => asStaffActor<{ id: string }>(db,user,
    "select public.save_academic_log($1::jsonb,$2::jsonb) as id",[JSON.stringify(log),JSON.stringify(activities)]);
  const insertLog = (overrides: Record<string, unknown> = {}, user: string = actor.teacherA) => {
    const row = { ...logFields(), teacher_id: A.teacher, ...overrides };
    const keys = Object.keys(row);
    return asStaffActor(db,user,`insert into public.class_logs(${keys.join(",")}) values(${keys.map((_,i)=>`$${i+1}`).join(",")}) returning id`,Object.values(row));
  };
  const savedPayload = async (overrides: Record<string, unknown> = {}) => {
    const row = (await db.query<{ updated_at: string }>("select updated_at::text from public.class_logs where id=$1",[A.log])).rows[0];
    return logFields({ id:A.log,log_date:"2026-11-02",status:"published",expected_updated_at:row.updated_at,...overrides });
  };
  const submit = (overrides: Record<string, unknown> = {}, user: string = actor.studentA) => {
    const row = { activity_id:A.activity,student_id:A.student,text_response:"My own answer",status:"submitted",...overrides };
    const keys = Object.keys(row);
    return asStaffActor<{ id: string; status: string }>(db,user,`insert into public.activity_submissions(${keys.join(",")}) values(${keys.map((_,i)=>`$${i+1}`).join(",")}) returning id,status`,Object.values(row));
  };

  beforeAll(async () => {
    db=await createAcademicPermissionDatabase();
    await db.query("insert into public.subjects(id,school_id,name) values($1,$2,'Unassigned subject')",[extraSubject,actor.schoolA]);
    await db.query("update public.profiles set school_id=$2 where id=$1",[actor.outsider,actor.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')",[actor.outsider,actor.schoolA]);
    await db.query("insert into public.teachers(id,school_id,profile_id,employee_id,full_name) values($1,$2,$3,'ACADEMIC-OTHER','Other teacher')",[otherTeacher,actor.schoolA,actor.outsider]);
    await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status)
      values($1,$2,$3,$4,$5,$6,$7,'2026-11-02','Legacy out-of-assignment row','published')`,[invalidLog,actor.schoolA,A.year,STAFF_ROWS.privateClassA,STAFF_ROWS.privateSectionA,A.subject,A.teacher]);
    await db.query(`insert into public.study_materials(id,school_id,class_id,section_id,subject_id,teacher_id,title,published_at)
      values($1,$2,$3,$4,$5,$6,'Legacy out-of-assignment material',now())`,[invalidMaterial,actor.schoolA,STAFF_ROWS.privateClassA,STAFF_ROWS.privateSectionA,A.subject,A.teacher]);
  },30000);
  beforeEach(async () => {
    await db.exec("delete from public.activity_submissions");
    await db.query("delete from public.class_logs where id not in ($1,$2,$3,$4)",[A.log,B.log,STAFF_ROWS.draftLogA,invalidLog]);
    await db.query("delete from public.class_activities where id not in ($1,$2,$3)",[A.activity,B.activity,STAFF_ROWS.draftActivityA]);
    await db.query("update public.class_logs set topic='Published A',status='published' where id=$1",[A.log]);
    await db.query("update public.class_activities set title='Homework A',max_marks=10 where id=$1",[A.activity]);
    await db.query("update public.profiles set is_active=true where id=$1",[actor.teacherA]);
    await db.query("update public.academic_years set is_current=true where id=$1",[A.year]);
    await db.query("update public.classes set is_active=true where id=$1",[A.class]);
    await db.query("update public.subjects set is_active=true where id=$1",[A.subject]);
    if (!(await db.query("select id from public.teacher_subject_assignments where id=$1",[A.assignment])).rows.length) {
      await db.query("insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher) values($1,$2,$3,$4,$5,$6,true)",[A.assignment,A.teacher,A.year,A.class,A.section,A.subject]);
    }
  });
  afterAll(async () => { await db?.close(); });

  it("permits own assigned work but rejects wrong class, section, subject, teacher, year and cross-school forged scope",async () => {
    expect((await rpc(logFields(),[homework()])).rows[0].id).toEqual(expect.any(String));
    const denied = [
      { class_id:STAFF_ROWS.privateClassA,section_id:STAFF_ROWS.privateSectionA },
      { section_id:STAFF_ROWS.privateSectionA },{ section_id:null },{ subject_id:extraSubject },{ subject_id:null },
      { school_id:actor.schoolB,academic_year_id:B.year,class_id:B.class,section_id:B.section,subject_id:B.subject },
      { teacher_id:B.teacher },{ academic_year_id:B.year },
    ];
    for (const override of denied) await expect(insertLog(override)).rejects.toMatchObject({code:"42501"});
    await expect(rpc(logFields({teacher_id:B.teacher}),[])).rejects.toMatchObject({code:"42501"});
    expect((await asStaffActor(db,actor.teacherA,"select id from public.class_logs where id in ($1,$2)",[invalidLog,B.log])).rows).toEqual([]);
    expect((await asStaffActor(db,actor.teacherA,"select id from public.study_materials where id=$1",[invalidMaterial])).rows).toEqual([]);
    expect((await asStaffActor(db,actor.outsider,"select id from public.class_logs where id=$1",[A.log])).rows).toEqual([]);
  });

  it("rejects placement/owner/date mutation and direct activity reparenting while preserving the original rows",async () => {
    for (const [column,value] of [["class_id",STAFF_ROWS.privateClassA],["section_id",null],["subject_id",extraSubject],["teacher_id",otherTeacher],["log_date","2026-11-07"]]) {
      await expect(asStaffActor(db,actor.teacherA,`update public.class_logs set ${column}=$1 where id=$2`,[value,A.log])).rejects.toMatchObject({code:"42501"});
    }
    await expect(asStaffActor(db,actor.teacherA,"update public.class_activities set class_log_id=$1 where id=$2",[STAFF_ROWS.draftLogA,A.activity])).rejects.toMatchObject({code:"42501"});
    expect((await db.query("select teacher_id,section_id,log_date::text from public.class_logs where id=$1",[A.log])).rows)
      .toEqual([{teacher_id:A.teacher,section_id:A.section,log_date:"2026-11-02"}]);
    expect((await db.query("select class_log_id from public.class_activities where id=$1",[A.activity])).rows).toEqual([{class_log_id:A.log}]);
  });

  it("cuts off removed/inactive assignments and enforces locks even under simulated stale permissive RLS",async () => {
    await db.query("delete from public.teacher_subject_assignments where id=$1",[A.assignment]);
    expect((await asStaffActor(db,actor.teacherA,"select id from public.class_logs")).rows).toEqual([]);
    expect((await asStaffActor(db,actor.teacherA,"select id from public.class_activities")).rows).toEqual([]);
    expect((await asStaffActor(db,actor.teacherA,"select id from public.study_materials")).rows).toEqual([]);
    await db.exec("create policy qa_stale_log on public.class_logs for all to authenticated using(true) with check(true)");
    try { await expect(insertLog()).rejects.toMatchObject({code:"42501",message:"An active current-session teaching assignment is required."}); }
    finally { await db.exec("drop policy qa_stale_log on public.class_logs"); }
    await expect(asStaffActor(db,actor.teacherA,"insert into public.class_activities(class_log_id,activity_type,title) values($1,'homework','Blocked')",[A.log])).rejects.toMatchObject({code:"42501"});
  });

  it("keeps retained prior-session own history readable, makes it read-only, and denies inactive identities and disabled scope",async () => {
    await db.query("update public.academic_years set is_current=false where id=$1",[A.year]);
    expect((await asStaffActor(db,actor.teacherA,"select id from public.class_logs where id=$1",[A.log])).rows).toEqual([{id:A.log}]);
    expect((await asStaffActor(db,actor.teacherA,"update public.class_logs set topic='Blocked' where id=$1 returning id",[A.log])).rows).toEqual([]);
    expect((await asStaffActor(db,actor.teacherA,"delete from public.class_activities where id=$1 returning id",[A.activity])).rows).toEqual([]);
    await db.query("update public.academic_years set is_current=true where id=$1",[A.year]);
    await db.query("update public.profiles set is_active=false where id=$1",[actor.teacherA]);
    expect((await asStaffActor(db,actor.teacherA,"select id from public.class_logs")).rows).toEqual([]);
    await expect(insertLog()).rejects.toMatchObject({code:"42501"});
    await db.query("update public.profiles set is_active=true where id=$1",[actor.teacherA]);
    await db.query("update public.subjects set is_active=false where id=$1",[A.subject]);
    await expect(insertLog()).rejects.toMatchObject({code:"42501"});
  });

  it("preserves Admin/Principal coherent management and office read but removes financial/reception academic writes",async () => {
    for(const user of [actor.adminA,actor.principalA]) expect((await asStaffActor(db,user,"update public.class_logs set topic='Office edit' where id=$1 returning id",[A.log])).rows).toEqual([{id:A.log}]);
    for(const user of [actor.accountantA,actor.receptionA]) {
      expect((await asStaffActor(db,user,"select id from public.class_logs where id=$1",[A.log])).rows).toEqual([{id:A.log}]);
      expect((await asStaffActor(db,user,"update public.class_logs set topic='Blocked' where id=$1 returning id",[A.log])).rows).toEqual([]);
      await expect(insertLog({},user)).rejects.toMatchObject({code:"42501"});
    }
    await expect(insertLog({teacher_id:B.teacher},actor.adminA)).rejects.toMatchObject({code:"42501"});
    expect((await asStaffActor(db,actor.adminB,"select id from public.class_logs where id=$1",[A.log])).rows).toEqual([]);
  });

  it("keeps family published own-class work visible while hiding drafts and unrelated work",async () => {
    for(const user of [actor.parentA,actor.studentA]) {
      expect((await asStaffActor(db,user,"select id from public.class_logs order by id")).rows).toEqual([{id:A.log}]);
      expect((await asStaffActor(db,user,"select id from public.class_activities order by id")).rows).toEqual([{id:A.activity}]);
      expect((await asStaffActor(db,user,"select id from public.study_materials order by id")).rows).toEqual([{id:A.material}]);
    }
    await db.query("update public.study_materials set published_at=null where id=$1",[A.material]);
    try { expect((await asStaffActor(db,actor.parentA,"select id from public.study_materials")).rows).toEqual([]); }
    finally { await db.query("update public.study_materials set published_at=now() where id=$1",[A.material]); }
  });

  it("enforces exact current assignment and immutable placement for standalone study materials",async () => {
    const create=(section: string|null,subject: string|null=A.subject)=>asStaffActor(db,actor.teacherA,
      "insert into public.study_materials(school_id,class_id,section_id,subject_id,teacher_id,title) values($1,$2,$3,$4,$5,'QA material') returning id",
      [actor.schoolA,A.class,section,subject,A.teacher]);
    expect((await create(A.section)).rows[0].id).toEqual(expect.any(String));
    for(const [section,subject] of [[null,A.subject],[A.section,null],[A.section,extraSubject],[STAFF_ROWS.privateSectionA,A.subject]]) {
      await expect(create(section,subject)).rejects.toMatchObject({code:"42501"});
    }
    await expect(asStaffActor(db,actor.teacherA,"update public.study_materials set section_id=null where id=$1",[A.material])).rejects.toMatchObject({code:"42501"});
    expect((await asStaffActor(db,actor.outsider,"delete from public.study_materials where id=$1 returning id",[A.material])).rows).toEqual([]);
  });

  it("lets pupils submit only their own eligible work and assigned teachers grade without rewriting the response",async () => {
    for(const row of [{marks:10},{feedback:"Forged feedback"},{status:"graded"},{student_id:STAFF_ROWS.privateStudentA},{activity_id:STAFF_ROWS.draftActivityA}]) {
      await expect(submit(row)).rejects.toMatchObject({code:"42501"});
    }
    const saved=(await submit()).rows[0]; expect(saved.status).toBe("submitted");
    expect((await asStaffActor(db,actor.outsider,"select id from public.activity_submissions")).rows).toEqual([]);
    expect((await asStaffActor(db,actor.parentB,"select id from public.activity_submissions")).rows).toEqual([]);
    await expect(asStaffActor(db,actor.teacherA,"update public.activity_submissions set text_response='Teacher rewrite' where id=$1",[saved.id])).rejects.toMatchObject({code:"42501"});
    await expect(asStaffActor(db,actor.teacherA,"update public.activity_submissions set marks=11,status='graded' where id=$1",[saved.id])).rejects.toMatchObject({code:"22023"});
    expect((await asStaffActor(db,actor.teacherA,"update public.activity_submissions set marks=7,feedback='Reviewed',status='graded' where id=$1 returning id",[saved.id])).rows).toEqual([{id:saved.id}]);
    for(const user of [actor.studentA,actor.parentA]) expect((await asStaffActor(db,user,"select id,marks::text,status,text_response from public.activity_submissions")).rows)
      .toEqual([{id:saved.id,marks:"7",status:"graded",text_response:"My own answer"}]);
    await expect(asStaffActor(db,actor.studentA,"update public.activity_submissions set text_response='After review' where id=$1",[saved.id])).rejects.toMatchObject({code:"42501"});
    expect((await asStaffActor(db,actor.studentA,"delete from public.activity_submissions where id=$1 returning id",[saved.id])).rows).toEqual([]);
  });

  it("saves atomically, retains activity/submission identities, and rejects destructive omission without partial changes",async () => {
    const submitted=(await submit()).rows[0].id;
    expect((await rpc(await savedPayload({topic:"Updated published work"}),[homework({id:A.activity,title:"Updated homework"})])).rows[0].id).toBe(A.log);
    expect((await db.query("select id,activity_id from public.activity_submissions where id=$1",[submitted])).rows).toEqual([{id:submitted,activity_id:A.activity}]);
    const before=(await db.query("select topic,updated_at::text from public.class_logs where id=$1",[A.log])).rows;
    await expect(rpc(await savedPayload({topic:"Must roll back"}),[])).rejects.toMatchObject({code:"23503"});
    expect((await db.query("select topic,updated_at::text from public.class_logs where id=$1",[A.log])).rows).toEqual(before);
    await expect(asStaffActor(db,actor.teacherA,"delete from public.class_logs where id=$1",[A.log])).rejects.toMatchObject({code:"23503"});
    await expect(asStaffActor(db,actor.teacherA,"delete from public.class_activities where id=$1",[A.activity])).rejects.toMatchObject({code:"23503"});
    expect((await db.query("select id from public.activity_submissions")).rows).toEqual([{id:submitted}]);
  });

  it("hides legacy mismatched-cohort submissions and refuses responses to study-material entries",async () => {
    for(const pupil of [B.student,STAFF_ROWS.privateStudentA]) {
      const id=randomUUID();
      await db.query("insert into public.activity_submissions(id,activity_id,student_id,text_response) values($1,$2,$3,'Legacy mismatched response')",[id,A.activity,pupil]);
      for(const user of [actor.teacherA,actor.adminA,actor.parentA,actor.studentA]) {
        expect((await asStaffActor(db,user,"select id from public.activity_submissions where id=$1",[id])).rows).toEqual([]);
      }
    }
    const material=(await asStaffActor<{id:string}>(db,actor.teacherA,"insert into public.class_activities(class_log_id,activity_type,title) values($1,'study_material','Reference only') returning id",[A.log])).rows[0].id;
    await expect(submit({activity_id:material})).rejects.toMatchObject({code:"42501"});
  });

  it("rejects foreign activity payloads, duplicate new-log keys and stale full snapshots without deleting newer work",async () => {
    await expect(rpc(logFields(),[homework({id:B.activity})])).rejects.toMatchObject({code:"42501"});
    expect((await db.query("select id from public.class_logs where log_date='2026-11-06'")).rows).toEqual([]);
    await expect(rpc(logFields({log_date:"2026-11-02"}),[])).rejects.toMatchObject({code:"23505"});
    const stale=await savedPayload({topic:"Stale client content"});
    const added=(await asStaffActor<{id:string}>(db,actor.teacherA,"insert into public.class_activities(class_log_id,activity_type,title) values($1,'study_material','Concurrent material') returning id",[A.log])).rows[0].id;
    await expect(rpc(stale,[homework({id:A.activity})])).rejects.toMatchObject({code:"PT409"});
    expect((await db.query<{id:string}>("select id from public.class_activities where class_log_id=$1 order by id",[A.log])).rows.map(row=>row.id).sort()).toEqual([A.activity,added].sort());
    await expect(rpc(logFields({id:A.log,log_date:"2026-11-02"}),[homework({id:A.activity})])).rejects.toMatchObject({code:"22023"});
  });

  it("closes anonymous RPC calls and leaves no legacy permissive academic write policies",async () => {
    await expect(asStaffActor(db,null,"select public.save_academic_log('{}','[]')",[],"anon")).rejects.toMatchObject({code:"42501"});
    const names=(await db.query<{policyname:string}>("select policyname from pg_policies where schemaname='public' and tablename in ('class_logs','class_activities','study_materials','activity_submissions')")).rows.map(row=>row.policyname);
    expect(names.some(name=>name.startsWith("teachers_manage_own")||name.endsWith("_tenant")||name.endsWith("_staff_all"))).toBe(false);
  });

  it("denies actual anonymous/authenticated table truncation and non-DML grants without losing guarded DML or trusted service access",async () => {
    const sentinel=(await submit()).rows[0].id;
    for(const [user,role] of [[null,"anon"],[actor.studentA,"authenticated"]] as const) {
      await expect(asStaffActor(db,user,"truncate table public.activity_submissions",[],role)).rejects.toMatchObject({code:"42501"});
    }
    expect((await db.query("select id from public.activity_submissions")).rows).toEqual([{id:sentinel}]);
    for(const role of ["anon","authenticated"]) {
      for(const privilege of ["TRUNCATE","REFERENCES","TRIGGER","MAINTAIN"]) {
        expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'public.activity_submissions',$2) allowed",[role,privilege])).rows[0].allowed).toBe(false);
      }
    }
    for(const privilege of ["SELECT","INSERT","UPDATE","DELETE"]) {
      expect((await db.query<{allowed:boolean}>("select has_table_privilege('anon','public.activity_submissions',$1) allowed",[privilege])).rows[0].allowed).toBe(false);
      expect((await db.query<{allowed:boolean}>("select has_table_privilege('authenticated','public.activity_submissions',$1) allowed",[privilege])).rows[0].allowed).toBe(true);
    }
    expect((await db.query<{allowed:boolean}>("select has_table_privilege('service_role','public.activity_submissions','TRUNCATE') allowed")).rows[0].allowed).toBe(true);
    expect((await asStaffActor(db,actor.studentA,"select id from public.activity_submissions")).rows).toEqual([{id:sentinel}]);
    expect((await asStaffActor(db,actor.teacherA,"update public.activity_submissions set marks=5,status='graded' where id=$1 returning id",[sentinel])).rows).toEqual([{id:sentinel}]);
  });
});
