// @vitest-environment node
import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {createHomeworkSubmissionDatabase} from "./homework-submissions-fixture";
import {asStaffActor,STAFF_IDS as actor,STAFF_ROWS as rows} from "./staff-scope-fixture";

type Result={id:string;revision:number;status:string};
const A=rows.A;
describe("private homework responses and optimistic grading",()=>{
  let db:Awaited<ReturnType<typeof createHomeworkSubmissionDatabase>>;
  const submit=(options:{activity?:string;text?:string|null;path?:string|null;name?:string|null;revision?:number|null;request?:string;user?:string}={})=>asStaffActor<{result:Result}>(db,options.user??actor.studentA,
    "select public.submit_homework($1,$2,$3,$4,$5,$6) result",[options.activity??A.activity,options.text===undefined?"My own response":options.text,options.path??null,options.revision??null,options.request??randomUUID(),options.name??null]);
  const grade=(id:string,options:{marks?:number|string|null;feedback?:string|null;revision?:number|null;request?:string;user?:string}={})=>asStaffActor<{result:Result}>(db,options.user??actor.teacherA,
    "select public.grade_homework($1,$2,$3,$4,$5) result",[id,options.marks===undefined?7:options.marks,options.feedback===undefined?"Reviewed":options.feedback,options.revision??0,options.request??randomUUID()]);
  const own=(user:string=actor.studentA)=>asStaffActor<{result:Record<string,unknown>[]}>(db,user,"select public.list_my_homework_submissions($1) result",[[A.activity,rows.B.activity]]);
  const path=(student:string=A.student,activity:string=A.activity)=>[actor.schoolA,A.year,A.class,A.section,A.subject,activity,student,`${randomUUID()}.pdf`].join("/");
  const upload=async(name:string,options:{owner?:string;size?:number|string;mime?:string}={})=>db.query(
    "insert into storage.objects(bucket_id,name,owner_id,metadata) values('homework-submissions',$1,$2,$3::jsonb)",
    [name,options.owner??actor.studentA,JSON.stringify({size:options.size??32,mimetype:options.mime??"application/pdf"})]);

  beforeAll(async()=>{
    db=await createHomeworkSubmissionDatabase();
    await db.query("update public.profiles set school_id=$2 where id=$1",[actor.outsider,actor.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')",[actor.outsider,actor.schoolA]);
    await db.query("update public.students set profile_id=$2 where id=$1",[rows.privateStudentA,actor.outsider]);
    await db.query("update public.enrollments set class_id=$2,section_id=$3 where id=$1",[rows.privateEnrollmentA,A.class,A.section]);
  },30000);
  beforeEach(async()=>{
    await db.exec("delete from app_private.homework_write_receipts; delete from public.activity_submissions; delete from storage.objects");
    await db.query("update public.class_logs set status='published' where id=$1",[A.log]);
    await db.query("update public.class_activities set max_marks=10 where id=$1",[A.activity]);
    await db.query("update public.profiles set is_active=true where id=$1",[actor.studentA]);
    await db.query("update public.enrollments set status='active' where id=$1",[A.enrollment]);
  });
  afterAll(async()=>{await db?.close();});

  it("submits an own response, exposes only its class roster to the assigned teacher, and preserves account isolation",async()=>{
    const saved=(await submit()).rows[0].result; expect(saved).toMatchObject({revision:0,status:"submitted"});
    const mine=(await own()).rows[0].result; expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({id:saved.id,text_response:"My own response",revision:0});
    expect((await own(actor.outsider)).rows[0].result).toEqual([]);
    expect((await own(actor.studentB)).rows[0].result).toEqual([]);
    const list=(await asStaffActor<{result:{students:{student_id:string;submission:Result|null}[]}}>(db,actor.teacherA,"select public.list_homework_submissions_for_grading($1) result",[A.activity])).rows[0].result;
    expect(list.students).toHaveLength(2); expect(list.students.find(row=>row.student_id===A.student)?.submission).toMatchObject({id:saved.id,revision:0});
    expect(list.students.find(row=>row.student_id===rows.privateStudentA)?.submission).toBeNull();
    await expect(asStaffActor(db,actor.teacherB,"select public.list_homework_submissions_for_grading($1)",[A.activity])).rejects.toMatchObject({code:"42501"});
    await expect(grade(saved.id,{user:actor.outsider})).rejects.toMatchObject({code:"42501"});
    await expect(submit({activity:rows.B.activity})).rejects.toMatchObject({code:"42501"});
    expect((await asStaffActor(db,actor.parentA,"select id from public.activity_submissions")).rows).toEqual([{id:saved.id}]);
    expect((await asStaffActor(db,actor.parentB,"select id from public.activity_submissions")).rows).toEqual([]);
  });

  it("persists idempotent submit and grade receipts without replaying or overwriting later state",async()=>{
    const request=randomUUID(); const first=(await submit({request})).rows[0].result;
    expect((await submit({request})).rows[0].result).toEqual(first);
    await expect(submit({request,text:"Different payload"})).rejects.toMatchObject({code:"23505"});
    await expect(submit({request,user:actor.outsider})).rejects.toMatchObject({code:"23505"});
    const gradeRequest=randomUUID(); const graded=(await grade(first.id,{request:gradeRequest})).rows[0].result;
    expect(graded).toMatchObject({id:first.id,revision:1,status:"graded"});
    expect((await grade(first.id,{request:gradeRequest})).rows[0].result).toEqual(graded);
    expect((await submit({request})).rows[0].result).toEqual(first);
    await expect(grade(first.id,{request:gradeRequest,marks:8})).rejects.toMatchObject({code:"23505"});
    const current=(await own()).rows[0].result[0]; expect(current).toMatchObject({revision:1,status:"graded",marks:7,text_response:"My own response"});
    expect((await db.query("select id from public.activity_submissions")).rows).toHaveLength(1);
    await expect(submit({revision:1,text:"Post-grade edit"})).rejects.toMatchObject({code:"42501"});
  });

  it("uses exact revisions for response edits and grades, rejecting stale devices without partial writes",async()=>{
    const first=(await submit()).rows[0].result;
    const edited=(await submit({revision:0,text:"Revised answer"})).rows[0].result; expect(edited).toMatchObject({id:first.id,revision:1});
    await expect(submit({revision:0,text:"Stale answer"})).rejects.toMatchObject({code:"PT409"});
    await expect(grade(first.id,{revision:0})).rejects.toMatchObject({code:"PT409"});
    const graded=(await grade(first.id,{revision:1})).rows[0].result; expect(graded.revision).toBe(2);
    await expect(grade(first.id,{revision:1,marks:6})).rejects.toMatchObject({code:"PT409"});
    expect((await own()).rows[0].result[0]).toMatchObject({revision:2,text_response:"Revised answer",marks:7});
  });

  it("requires meaningful responses and bounded grades, including qualitative feedback without a maximum",async()=>{
    await expect(submit({text:"   "})).rejects.toMatchObject({code:"22023"});
    const id=(await submit()).rows[0].result.id;
    for(const marks of [-1,11,"NaN","Infinity"]) await expect(grade(id,{marks})).rejects.toMatchObject({code:"22023"});
    await expect(grade(id,{marks:null,feedback:" "})).rejects.toMatchObject({code:"22023"});
    await db.query("update public.class_activities set max_marks=null where id=$1",[A.activity]);
    await expect(grade(id,{marks:1})).rejects.toMatchObject({code:"22023"});
    expect((await grade(id,{marks:null,feedback:"Good explanation"})).rows[0].result.status).toBe("graded");
    expect((await own()).rows[0].result[0]).toMatchObject({marks:null,feedback:"Good explanation"});
  });

  it("attaches only a real owned private object with the exact homework tuple and preserves its filename",async()=>{
    const file=path(); await upload(file);
    const saved=(await submit({text:null,path:file,name:"../../answer\n.pdf"})).rows[0].result;
    expect((await own()).rows[0].result[0]).toMatchObject({id:saved.id,file_path:file,file_name:"answer.pdf",text_response:null});
    expect((await db.query<{parts:string[]}>("select app_private.homework_file_scope($1) parts",[file])).rows[0].parts).toHaveLength(8);
  });

  it("rejects missing, stolen, mis-scoped, oversized and mismatched MIME attachments atomically",async()=>{
    const cases:[string,{owner?:string;size?:number|string;mime?:string}|null,string][]=[
      [path(),null,"42501"],[path(),{owner:actor.outsider},"42501"],
      [path(rows.privateStudentA),{},"42501"],[path(A.student,rows.B.activity),{},"42501"],
      [path(),{size:10485761},"22023"],[path(),{size:0},"22023"],[path(),{size:"bad"},"22023"],
      [path(),{mime:"text/html"},"22023"],["https://example.invalid/answer.pdf",null,"42501"],
    ];
    for(const [file,metadata,code] of cases) {
      if(metadata) await upload(file,metadata);
      await expect(submit({text:null,path:file,name:"answer.pdf"})).rejects.toMatchObject({code});
    }
    expect((await db.query("select id from public.activity_submissions")).rows).toEqual([]);
    expect((await db.query("select request_id from app_private.homework_write_receipts")).rows).toEqual([]);
  });

  it("keeps submitted attachment evidence immutable while allowing an ungraded text correction",async()=>{
    const firstFile=path(); const otherFile=path(); await upload(firstFile); await upload(otherFile);
    const saved=(await submit({path:firstFile,name:"original.pdf"})).rows[0].result;
    expect((await submit({revision:0,text:"Corrected text",path:firstFile,name:"original.pdf"})).rows[0].result.revision).toBe(1);
    for(const options of [{path:otherFile,name:"other.pdf"},{path:null,name:null},{path:firstFile,name:"renamed.pdf"}]) {
      await expect(submit({...options,revision:1})).rejects.toMatchObject({code:"42501"});
    }
    expect((await own()).rows[0].result[0]).toMatchObject({id:saved.id,file_path:firstFile,file_name:"original.pdf",revision:1});
  });

  it("allows an initial text-only response to attach its first private file without replacing the response identity",async()=>{
    const first=(await submit()).rows[0].result; const file=path(); await upload(file);
    const attached=(await submit({revision:0,path:file,name:"attachment.pdf"})).rows[0].result;
    expect(attached).toMatchObject({id:first.id,revision:1});
    expect((await own()).rows[0].result[0]).toMatchObject({file_path:file,text_response:"My own response"});
  });

  it("rechecks publication, enrollment and role eligibility on every new action and receipt retry",async()=>{
    const request=randomUUID(); const saved=(await submit({request})).rows[0].result;
    await db.query("update public.enrollments set status='withdrawn' where id=$1",[A.enrollment]);
    expect((await own()).rows[0].result[0].id).toBe(saved.id);
    await expect(submit({revision:0,text:"Withdrawn edit"})).rejects.toMatchObject({code:"42501"});
    await db.query("update public.enrollments set status='active' where id=$1",[A.enrollment]);
    await db.query("update public.class_logs set status='draft' where id=$1",[A.log]);
    expect((await own()).rows[0].result).toEqual([]);
    await expect(submit({request})).rejects.toMatchObject({code:"42501"});
    await db.query("update public.class_logs set status='published' where id=$1",[A.log]);
    await db.query("update public.profiles set is_active=false where id=$1",[actor.studentA]);
    await expect(submit({request})).rejects.toMatchObject({code:"42501"});
  });

  it("denies raw mutation, anonymous RPCs and private receipt access while retaining guarded reads",async()=>{
    const saved=(await submit()).rows[0].result;
    for(const user of [actor.studentA,actor.teacherA,actor.adminA]) {
      await expect(asStaffActor(db,user,"update public.activity_submissions set marks=10 where id=$1",[saved.id])).rejects.toMatchObject({code:"42501"});
      await expect(asStaffActor(db,user,"delete from public.activity_submissions where id=$1",[saved.id])).rejects.toMatchObject({code:"42501"});
      await expect(asStaffActor(db,user,"select * from app_private.homework_write_receipts")).rejects.toMatchObject({code:"42501"});
    }
    await expect(asStaffActor(db,null,"select public.list_my_homework_submissions($1)",[[A.activity]],"anon")).rejects.toMatchObject({code:"42501"});
    for(const privilege of ["INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","MAINTAIN"]) {
      expect((await db.query<{allowed:boolean}>("select has_table_privilege('authenticated','public.activity_submissions',$1) allowed",[privilege])).rows[0].allowed).toBe(false);
    }
    expect((await asStaffActor(db,actor.teacherA,"select id from public.activity_submissions")).rows).toEqual([{id:saved.id}]);
  });
});
