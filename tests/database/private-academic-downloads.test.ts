// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const log = randomUUID(), activity = randomUUID(), material = randomUUID(), draft = randomUUID();
const unassignedTeacher = randomUUID(), principal = randomUUID(), office = randomUUID();
let submission: string;
const materialPath = [id.schoolA,id.yearA,id.classA,id.sectionA,id.subjectA,id.teacherRecordA,`${randomUUID()}.txt`].join("/");
const homeworkPath = [id.schoolA,id.yearA,id.classA,id.sectionA,id.subjectA,activity,id.pupilA,`${randomUUID()}.pdf`].join("/");
type Grant = { user_id: string; school_id: string; kind: string; id: string; bucket: string; path: string;
  file_name: string; content_type: string; byte_size: number; version: string };

async function actor<T extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, sql: string, args: unknown[] = [],
  options: { session?: string | null; operation?: string; role?: "authenticated" | "anon" | "service_role"; claims?: object; headers?: object } = {},
) {
  await db.exec("savepoint file_probe");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),
      set_config('storage.operation',$3,true),set_config('request.headers',$4,true)`, [user ?? "",
      JSON.stringify({ sub:user,session_id:options.session === undefined ? user : options.session,...options.claims }),
      options.operation ?? "object.get_authenticated", JSON.stringify(options.headers ?? {})]);
    const result = await db.query<T>(sql,args);
    await db.exec("reset role");
    await db.exec("release savepoint file_probe");
    return result.rows;
  } catch (error) { await db.exec("rollback to savepoint file_probe; release savepoint file_probe"); throw error; }
}
const grant = async (user = id.studentUserA, kind = "submission", record = submission, options: Parameters<typeof actor>[3] = {}) =>
  (await actor<{ value: Grant }>(user,"select public.authorize_private_academic_file($1,$2) as value",[kind,record],options))[0].value;
const denied = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code:"42501" });
const invalid = (work: Promise<unknown>) => expect(work).rejects.toMatchObject({ code:"22023" });
const canonical = async () => (await db.query(`select jsonb_build_object(
  'attendance',(select jsonb_agg(to_jsonb(r) order by id) from public.attendance r),
  'fees',(select jsonb_agg(to_jsonb(r) order by id) from public.student_fees r),
  'payments',(select jsonb_agg(to_jsonb(r) order by id) from public.fee_payments r),
  'submissions',(select jsonb_agg(to_jsonb(r) order by id) from public.activity_submissions r),
  'links',(select jsonb_agg(to_jsonb(r) order by student_id,parent_id) from public.student_parents r)) as value`)).rows;

beforeAll(async () => {
  db=await createRecoveryDatabase(); await seedRecoveryData(db);
  for (const [user,role] of [[unassignedTeacher,"teacher"],[principal,"principal"],[office,"accountant"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",[user,`${user}@privatefile.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1",[user,id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)",[user,id.schoolA,role]);
  }
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users");
  await db.query(`insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,status)
    values($1,$2,$3,$4,$5,$6,$7,'2026-11-06','Private download regression','published')`,[log,id.schoolA,id.yearA,id.classA,id.sectionA,id.subjectA,id.teacherRecordA]);
  await db.query("insert into public.class_activities(id,class_log_id,activity_type,title,max_marks,attachment_url) values($1,$2,'homework','Private homework',10,$3)",[activity,log,materialPath]);
  for (const [record,published] of [[material,true],[draft,false]]) await db.query(`insert into public.study_materials(id,school_id,class_id,section_id,subject_id,teacher_id,title,file_url,published_at)
    values($1,$2,$3,$4,$5,$6,'Private class notes',$7,case when $8 then now() else null end)`,[record,id.schoolA,id.classA,id.sectionA,id.subjectA,id.teacherRecordA,materialPath,published]);
  await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('study-materials',$1,$2,'{\"size\":78,\"mimetype\":\"text/plain\"}')",[materialPath,id.teacherA]);
  await db.exec("begin");
  await actor(id.studentUserA,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('homework-submissions',$1,$2,'{\"size\":608,\"mimetype\":\"application/pdf\"}')",[homeworkPath,id.studentUserA],{ operation:"object.upload" });
  submission=(await actor<{ value: { id: string } }>(id.studentUserA,"select public.submit_homework($1,'Private answer',$2,null,$3,'answer.pdf') as value",[activity,homeworkPath,randomUUID()]))[0].value.id;
  await db.exec("commit");
},60_000);
beforeEach(async()=>{ await db.exec("begin"); });
afterEach(async()=>{ await db.exec("rollback"); });
afterAll(async()=>{ await db?.close(); });

describe("source-ID academic file grants and proxy-only private byte access",()=>{
  it.each([id.studentUserA,id.guardianA,id.teacherA,id.adminA,principal,office])("authorizes existing row visibility for live identity %s without returning a URL or secret",async(user)=>{
    const before=await canonical();
    const value=await grant(user);
    expect(Object.keys(value).sort()).toEqual(["user_id","school_id","kind","id","bucket","path","file_name","content_type","byte_size","version"].sort());
    expect(value).toMatchObject({ user_id:user,school_id:id.schoolA,kind:"submission",id:submission,bucket:"homework-submissions",path:homeworkPath,file_name:"answer.pdf",content_type:"application/pdf",byte_size:608 });
    expect(value.version).toMatch(/^[0-9a-f]{64}$/);
    for(const kind of ["material","activity"]) expect(await grant(user,kind,kind==="material"?material:activity))
      .toMatchObject({ user_id:user,school_id:id.schoolA,bucket:"study-materials",path:materialPath,content_type:"text/plain",byte_size:78 });
    expect(await canonical()).toEqual(before);
  });

  it.each(["object.get_authenticated","object.get_authenticated_info","object.head_authenticated_info","object.list","object.list_v2","object.sign","object.sign_many","object.sign_upload_url","render.image_authenticated","object.copy","object.move",""])("denies direct object reads for every role including administrators through %s",async(operation)=>{
    for(const user of [id.studentUserA,id.guardianA,id.teacherA,id.adminA,principal,office])
      expect(await actor(user,"select name from storage.objects where bucket_id in ('study-materials','homework-submissions')",[],{ operation })).toEqual([]);
  });

  it("rejects fabricated internal-operation claims and headers on direct GET",async()=>{
    expect(await actor(id.studentUserA,"select name from storage.objects",[],{
      claims:{ "storage.operation":"object.academic_file_grant",storage:{ operation:"object.academic_file_grant" } },
      headers:{ "storage.operation":"object.academic_file_grant","x-storage-operation":"object.academic_file_grant" },
    })).toEqual([]);
  });

  it.each([id.studentUserB,id.adminB,unassignedTeacher])("denies other-school or same-school unassigned identity %s for all source kinds",async(user)=>{
    await denied(grant(user)); await denied(grant(user,"activity",activity)); await denied(grant(user,"material",material));
  });

  it("never declassifies a hidden draft by reusing an otherwise readable physical file",async()=>{
    expect(await grant(id.guardianA,"material",material)).toMatchObject({ path:materialPath });
    await denied(grant(id.guardianA,"material",draft));
    await denied(grant(id.studentUserA,"material",draft));
    expect(await grant(id.teacherA,"material",draft)).toMatchObject({ id:draft,path:materialPath });
  });

  it("normalizes legacy stored material URLs into exact private keys without following external URLs",async()=>{
    await db.query("update public.study_materials set file_url=$2 where id=$1",[material,`https://bjecfuixgqgyohttrdfr.supabase.co/storage/v1/object/authenticated/study-materials/${materialPath}`]);
    expect(await grant(id.studentUserA,"material",material)).toMatchObject({ bucket:"study-materials",path:materialPath });
    const legacyActivity=randomUUID(),legacySubmission=randomUUID();
    await db.query("insert into public.class_activities(id,class_log_id,activity_type,title) values($1,$2,'homework','Retained legacy homework')",[legacyActivity,log]);
    await db.query("insert into public.activity_submissions(id,activity_id,student_id,text_response,file_url) values($1,$2,$3,'Retained answer',$4)",[legacySubmission,legacyActivity,id.pupilA,materialPath]);
    expect(await grant(id.studentUserA,"submission",legacySubmission)).toMatchObject({ bucket:"study-materials",path:materialPath });
    await denied(grant(unassignedTeacher,"submission",legacySubmission));
  });

  it("retains office-published shared material audiences without granting an unassigned teacher",async()=>{
    const sharedPath=`${id.schoolA}/shared/${randomUUID()}.txt`,sharedMaterial=randomUUID();
    await actor(id.adminA,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('study-materials',$1,$2,'{\"size\":20,\"mimetype\":\"text/plain\"}')",[sharedPath,id.adminA],{ operation:"object.upload" });
    await db.query("insert into public.study_materials(id,school_id,title,file_url,published_at) values($1,$2,'Office-published shared notes',$3,now())",[sharedMaterial,id.schoolA,sharedPath]);
    for(const user of [id.studentUserA,id.guardianA,id.adminA,principal,office])
      expect(await grant(user,"material",sharedMaterial)).toMatchObject({ path:sharedPath,school_id:id.schoolA });
    await denied(grant(unassignedTeacher,"material",sharedMaterial));
  });

  it.each([id.studentUserA,id.guardianA,id.teacherA,id.adminA,principal,office])("denies revoked session %s with all stored source facts unchanged",async(user)=>{
    const before=await canonical(); await db.query("delete from auth.sessions where user_id=$1",[user]);
    await denied(grant(user)); await denied(grant(user,"activity",activity)); await denied(grant(user,"material",material));
    expect(await canonical()).toEqual(before);
  });

  it("applies fresh child-link, role and teaching-assignment revocation without stale grants",async()=>{
    const before=await grant(id.guardianA);
    await db.query("delete from public.student_parents where parent_id=$1",[id.parentA]);
    await denied(grant(id.guardianA));
    await db.query("delete from public.teacher_subject_assignments where id=$1",[id.assignmentA]);
    await denied(grant(id.teacherA)); await denied(grant(id.teacherA,"material",material));
    await db.query("delete from public.user_roles where user_id=$1",[id.studentUserA]);
    await denied(grant(id.studentUserA));
    expect(before.path).toBe(homeworkPath);
  });

  it.each([null,"invalid",randomUUID(),id.guardianA])("denies absent, malformed and other-user native sessions %s",async(session)=>{
    await denied(grant(id.studentUserA,"submission",submission,{ session }));
  });

  it("preserves permitted pending upload/delete and material replacement metadata probes",async()=>{
    const path=homeworkPath.replace(homeworkPath.split("/").at(-1)!,`${randomUUID()}.pdf`);
    expect(await actor(id.studentUserA,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('homework-submissions',$1,$2,'{\"size\":40,\"mimetype\":\"application/pdf\"}') returning name",[path,id.studentUserA],{ operation:"object.upload" })).toEqual([{ name:path }]);
    expect(await actor(id.studentUserA,"delete from storage.objects where name=$1 returning name",[path],{ operation:"object.delete_many" })).toEqual([{ name:path }]);
    const pending=[id.schoolA,id.yearA,id.classA,id.sectionA,id.subjectA,id.teacherRecordA,`${randomUUID()}.txt`].join("/");
    await actor(id.teacherA,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('study-materials',$1,$2,'{\"size\":20,\"mimetype\":\"text/plain\"}')",[pending,id.teacherA],{ operation:"object.upload" });
    expect(await actor(id.teacherA,"update storage.objects set metadata='{\"size\":21,\"mimetype\":\"text/plain\"}' where name=$1 returning name",[pending],{ operation:"object.upload_update" })).toEqual([{ name:pending }]);
    expect(await actor(id.teacherA,"delete from storage.objects where name=$1 returning name",[pending],{ operation:"object.delete_many" })).toEqual([{ name:pending }]);
    expect(await actor(id.studentUserA,"delete from storage.objects where name=$1 returning name",[homeworkPath],{ operation:"object.delete_many" })).toEqual([]);
  });

  it("restores the original Storage operation after success and denial",async()=>{
    for(const record of [submission,randomUUID()]) {
      await db.exec("savepoint operation_restore; set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('storage.operation','object.delete_many',true)",[id.studentUserA,JSON.stringify({ sub:id.studentUserA,session_id:id.studentUserA })]);
      if(record===submission) await db.query("select public.authorize_private_academic_file('submission',$1)",[record]);
      else {
        // Catch the function's exception inside SQL to observe transaction-local state.
        await db.exec(`do $probe$ begin perform public.authorize_private_academic_file('submission','${record}'::uuid); exception when insufficient_privilege then null; end $probe$`);
      }
      expect((await db.query("select current_setting('storage.operation') as operation")).rows).toEqual([{ operation:"object.delete_many" }]);
      await db.exec("rollback to savepoint operation_restore; release savepoint operation_restore");
    }
  });

  it("changes the version on provider metadata replacement and normalizes unsafe material MIME to attachment bytes",async()=>{
    const original=await grant(id.studentUserA,"material",material);
    await db.query("update storage.objects set metadata='{\"size\":79,\"mimetype\":\"text/html\"}',updated_at=clock_timestamp() where name=$1",[materialPath]);
    const fresh=await grant(id.studentUserA,"material",material);
    expect(fresh.version).not.toBe(original.version); expect(fresh).toMatchObject({ byte_size:79,content_type:"application/octet-stream" });
  });

  it.each([null,0,-1,20971521,"not-a-size"])("fails closed on invalid/unbounded material size %s",async(size)=>{
    await db.query("update storage.objects set metadata=$2::jsonb where name=$1",[materialPath,JSON.stringify({ size,mimetype:"text/plain" })]);
    await invalid(grant(id.studentUserA,"material",material));
  });

  it("honors a tighter live bucket size limit without widening the twenty-MiB material cap",async()=>{
    await db.query("update storage.buckets set file_size_limit=77 where id='study-materials'");
    await invalid(grant(id.studentUserA,"material",material));
    await db.query("update storage.buckets set file_size_limit=209715200 where id='study-materials'");
    await db.query("update storage.objects set metadata='{\"size\":20971521,\"mimetype\":\"text/plain\"}' where name=$1",[materialPath]);
    await invalid(grant(id.studentUserA,"material",material));
  });

  it("rejects missing source/object, custom URL and mismatched physical scope without accepting paths",async()=>{
    await denied(grant(id.studentUserA,"material",randomUUID()));
    await db.query("update public.study_materials set file_url='https://example.invalid/private.pdf' where id=$1",[material]);
    await denied(grant(id.studentUserA,"material",material));
    await db.query("update public.study_materials set file_url=$2 where id=$1",[material,materialPath.replace(id.schoolA,id.schoolB)]);
    await denied(grant(id.studentUserA,"material",material));
    await db.query("update public.study_materials set file_url=$2 where id=$1",[material,materialPath.replace(materialPath.split('/').at(-1)!,`${randomUUID()}.txt`)]);
    await denied(grant(id.studentUserA,"material",material));
    await invalid(grant(id.studentUserA,"bucket-path",material));
  });

  it("pins the RPC invoker context and function grants, never exposing a service/anonymous metadata API",async()=>{
    expect((await db.query(`select prosecdef,proconfig,
      has_function_privilege('authenticated',oid,'execute') as member,
      has_function_privilege('anon',oid,'execute') as anonymous,
      has_function_privilege('service_role',oid,'execute') as worker
      from pg_proc where oid='public.authorize_private_academic_file(text,uuid)'::regprocedure`)).rows)
      .toEqual([{ prosecdef:false,proconfig:['search_path=""'],member:true,anonymous:false,worker:false }]);
    await denied(actor(null,"select public.authorize_private_academic_file('submission',$1)",[submission],{ role:"anon" }));
    await denied(actor(null,"select public.authorize_private_academic_file('submission',$1)",[submission],{ role:"service_role" }));
  });
});
