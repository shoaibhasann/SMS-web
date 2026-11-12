// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const proof = "a".repeat(64);
const fid = (n = 1) => `c${String(n).padStart(21,"0")}`;
type Device = {device_id:string;generation:number};
type Lease = {id:string;lease_id:string};
type PaymentReceipt = {payment_id:string;receipt_no:string};
type Settings = {preferences:{enabled:boolean;absence:boolean;result_published:boolean;leave_decision:boolean;version:number};devices:Record<string,unknown>[]};
type Prepared = {job_id:string;lease_id:string;device_fid:string;platform:string;kind:string;event_id:string;recipient_role:string;expires_at:string};

beforeAll(async()=>{
  db=await createRecoveryDatabase();await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users;begin");
  // Keep the baseline fees out of the due-today worker regardless of test date.
  await db.exec("update public.student_fees set due_date=null");
  await db.query("update public.teacher_assessments set status='completed' where id=$1",[id.assessmentA]);
  await actor(id.teacherA,"insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,0)",[id.assessmentA,id.unlinkedPupilA]);
  await db.exec("commit");
},60_000);
beforeEach(()=>db.exec("begin"));afterEach(()=>db.exec("rollback"));afterAll(()=>db?.close());
async function actor<T extends Record<string,unknown>=Record<string,unknown>>(user:string|null,sql:string,args:unknown[]=[],role="authenticated",session:string|null=user,connection=db,claimRole=role,aal?:string){
  await connection.exec("savepoint native_push_actor");
  try{
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user??"",JSON.stringify({sub:user,role:claimRole,session_id:session,aal})]);
    const result=await connection.query<T>(sql,args);
    await connection.exec("reset role");await connection.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await connection.exec("release savepoint native_push_actor");return result;
  }catch(error){await connection.exec("rollback to savepoint native_push_actor;release savepoint native_push_actor");throw error;}
}
const value=async<T>(user:string|null,sql:string,args:unknown[]=[],role="authenticated",session:string|null=user,connection=db,claimRole=role)=>(await actor<{value:T}>(user,sql,args,role,session,connection,claimRole)).rows[0].value;
const service=<T>(sql:string,args:unknown[]=[])=>value<T>(null,sql,args,"service_role");
const settings=(user=id.guardianA,role="parent")=>value<Settings>(user,"select public.get_my_family_push_settings($1) as value",[role]);
const preferences=(user=id.guardianA,role="parent",enabled=true,absence=true,result=true,leave=true,version=0)=>value<Settings>(user,"select public.set_my_family_push_preferences($1,$2,$3,$4,$5,$6) as value",[role,enabled,absence,result,leave,version]);
const register=(installation:string=randomUUID(),deviceFid=fid(),user=id.guardianA,role="parent",secret=proof,session:string|null=user)=>value<Device>(user,"select public.register_my_family_push_device($1,$2,$3,$4,'android','QA phone') as value",[role,installation,secret,deviceFid],"authenticated",session);
const revoke=(device:string,user=id.guardianA,role="parent")=>value<boolean>(user,"select public.revoke_my_family_push_device($1,$2) as value",[role,device]);
const claim=(batch=randomUUID(),limit=20)=>service<Lease[]>("select public.claim_family_push_jobs($1,$2) as value",[batch,limit]);
const prepare=(lease:Lease)=>service<Prepared|null>("select public.prepare_family_push_job($1,$2) as value",[lease.id,lease.lease_id]);
const finish=(lease:Lease,outcome="accepted",code:string|null=null,providerId:string|null=null,retry:number|null=null)=>service<boolean>("select public.finish_family_push_job($1,$2,$3,$4,$5,$6) as value",[lease.id,lease.lease_id,outcome,code,providerId,retry]);
const denied=(work:Promise<unknown>)=>expect(work).rejects.toMatchObject({code:"42501"});
const invalid=(work:Promise<unknown>)=>expect(work).rejects.toMatchObject({code:"22023"});
const countJobs=async()=>Number((await db.query<{amount:number}>("select count(*)::int as amount from app_private.family_push_jobs")).rows[0].amount);
const rows=async(table:string)=>(await db.query(`select to_jsonb(row) as row from ${table} row order by id`)).rows;
async function leave(start="2026-11-10",student=id.pupilA){
  const request=await value<string>(id.guardianA,"select public.submit_student_leave($1,$2::date,$2::date,'Private leave reason',$3) as value",[student,start,randomUUID()]);
  await value(id.adminA,"select public.review_student_leave($1,'approved','Private review reason') as value",[request]);return request;
}
async function publication(){
  const preview=await value<{source_token:string}>(id.teacherA,"select public.preview_assessment_publication($1) as value",[id.assessmentA]);
  const submission=await value<string>(id.teacherA,"select public.request_assessment_publication($1,$2,$3) as value",[id.assessmentA,preview.source_token,randomUUID()]);
  await value(id.adminA,"select public.review_assessment_publication($1,'published','Reviewed all marks') as value",[submission]);return submission;
}
async function absence(){
  await db.query("insert into public.attendance(id,school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,'2026-11-04','absent')",[randomUUID(),id.schoolA,id.yearA,id.sectionA,id.pupilA]);
}
async function scheduleExam(daysAhead = 1, section: string | null = id.sectionA, actorId = id.teacherA) {
  await db.query(`update public.academic_years set start_date=least(start_date,current_date-2),
    end_date=greatest(end_date,current_date+3) where id=$1`, [id.yearA]);
  return value<string>(actorId, `insert into public.teacher_assessments
    (school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,description,status)
    values($1,$2,$3,$4,$5,$6,'Private exam title',(statement_timestamp() at time zone 'Asia/Kolkata')::date+$7::int,50,'Private instructions','scheduled')
    returning id as value`, [id.schoolA,id.yearA,id.classA,section,id.subjectA,id.teacherRecordA,daysAhead]);
}
const noticeAudience = (roles: string[] = ["student", "parent"], sectionId: string = id.sectionA) =>
  JSON.stringify({ roles, class_id: id.classA, section_id: sectionId });
const saveNotice = (audience = noticeAudience(), published = true) => value<string>(id.adminA, `
  insert into public.notices(school_id,title,content,audience,published_at,created_by)
  values($1,'Private announcement title','Private announcement content',$2::jsonb,
    case when $3 then statement_timestamp() end,$4) returning id as value`, [id.schoolA,audience,published,id.adminA]);
const toggleNotice = (notice: string, publish: boolean) => actor(id.adminA, `update public.notices
  set published_at=case when $2 then statement_timestamp() end where id=$1`, [notice,publish]);
async function saveFee(daysFromToday: number | null, amount = 1000, student = id.pupilA) {
  const { rows: [{ id: fee }] } = await db.query<{id:string}>(`
    insert into public.student_fees(school_id,student_id,fee_structure_id,due_date,amount,status)
    values($1,$2,$3,(statement_timestamp() at time zone 'Asia/Kolkata')::date+$4::int,$5,'pending') returning id`,
  [id.schoolA,student,id.structureA,daysFromToday,amount]);
  return fee;
}
const payFee = (fee: string, amount: number, requestId = randomUUID()) => value<PaymentReceipt>(id.adminA,
  "select public.record_office_fee_payment($1,$2,$3,'cash',$4,null) as value", [id.schoolA,fee,amount,requestId]);
const paymentRead = (user: string, role: string, payment: string) => value<string|null>(user,
  "select public.mark_family_notification_read_v8($1,'fee_payment',$2)::text as value", [role,payment]);
const paymentDetail = (user: string, role: string, payment: string) => value(user,
  "select public.get_family_fee_payment($1,$2,$3) as value", [role,id.pupilA,payment]);
async function saveHomework(status: "draft" | "published", previousLog?: string, addedTitle?: string) {
  const previous = previousLog ? (await db.query<{ id: string; expected_updated_at: string; activity_id: string }>(`
    select log.id, log.updated_at::text as expected_updated_at, activity.id as activity_id
    from public.class_logs log join public.class_activities activity on activity.class_log_id = log.id
    where log.id = $1`, [previousLog])).rows[0] : null;
  const log = {
    id: previous?.id, expected_updated_at: previous?.expected_updated_at, status, school_id: id.schoolA,
    academic_year_id: id.yearA, class_id: id.classA, section_id: id.sectionA, subject_id: id.subjectA,
    log_date: "2026-11-09", topic: "Private lesson",
  };
  const activities = [{ id: previous?.activity_id, activity_type: "homework", title: "Private assignment" }];
  if (addedTitle) activities.push({ id: undefined, activity_type: "homework", title: addedTitle });
  const logId = await value<string>(id.teacherA, "select public.save_academic_log($1::jsonb,$2::jsonb) as value",
    [JSON.stringify(log), JSON.stringify(activities)]);
  const { rows: [activity] } = await db.query<{ id: string }>(
    "select id from public.class_activities where class_log_id=$1 and title=$2", [logId, addedTitle ?? activities[0].title]);
  return { logId, activityId: activity.id };
}
// Pin the 08:00 IST fee-reminder window so due-today cases do not depend on the wall clock.
const feeDueWindow = (open: boolean) => db.exec(`create or replace function app_private.family_fee_due_push_open(p_at timestamptz)
  returns boolean language sql immutable set search_path='' as $$ select ${open} $$`);
// The due-today scan runs at most once a minute; age the last run to let the next claim scan again.
const nextFeeDueScan = () => db.exec("update app_private.family_fee_due_push_scans set scanned_at=scanned_at-interval '61 seconds'");
async function ready(){await preferences();const device=await register();await leave();return device;}
const job=async(jobId:string)=>(await db.query<Record<string,unknown>>("select * from app_private.family_push_jobs where id=$1",[jobId])).rows[0];
const deliverySummary = async (user: string | null = id.adminA, school: string = id.schoolA, aal = "aal2",
  session = user, role = "authenticated") => (await actor(
  user, "select public.get_school_push_delivery_summary($1) as summary", [school], role, session, db, role, aal,
)).rows[0].summary;
async function verifyAuthenticator(user: string) {
  const factor = randomUUID();
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, user]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$2 where user_id=$1", [user, factor]);
}

describe("native family push under the recovered application schema",()=>{
  it("summarizes live leases, retryable work and recent completions by school without modifying queue rows", async () => {
    await verifyAuthenticator(id.adminA);
    await verifyAuthenticator(id.adminB);
    await db.query("update public.profiles set school_id=$2 where id=$1", [id.claimantA, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [id.claimantA, id.schoolA]);
    await verifyAuthenticator(id.claimantA);

    const summary = (counts: Record<string, number>) =>
      ({ counts: { queued: 0, leased: 0, accepted: 0, failed: 0, cancelled: 0, ...counts } });
    expect(await deliverySummary()).toEqual(summary({}));

    const guardian = await ready();
    expect(await deliverySummary()).toEqual(summary({ queued: 1 }));
    const [lease] = await claim();
    expect(await deliverySummary()).toEqual(summary({ leased: 1 }));
    expect(await prepare(lease)).not.toBeNull();
    expect(await finish(lease, "accepted", null, "projects/qa/messages/private-message-id")).toBe(true);
    const foreignStudent = await register(randomUUID(), fid(2), id.studentUserB, "student");

    await db.query(`
      insert into app_private.family_push_jobs
        (kind,event_id,device_id,device_generation,user_id,recipient_role,school_id,status,expires_at,lease_until,finished_at)
      select 'leave_decision',gen_random_uuid(),device.id,device.generation,device.user_id,device.recipient_role,
        device.school_id,fixture.status,now()+make_interval(days=>fixture.expiry),
        now()+make_interval(days=>fixture.lease),now()-make_interval(days=>fixture.finished)
      from (values
        ($1::uuid,'queued',1,null,null), ($1,'leased',1,-1,null), ($1,'leased',1,1,null),
        ($1,'queued',-1,null,null), ($1,'leased',-1,1,null),
        ($1,'accepted',-1,null,8), ($1,'failed',-1,null,2), ($1,'cancelled',-1,null,3),
        ($2,'queued',1,null,null)
      ) fixture(device_id,status,expiry,lease,finished)
      join app_private.family_push_devices device on device.id=fixture.device_id
    `, [guardian.device_id, foreignStudent.device_id]);

    const before = await rows("app_private.family_push_jobs");
    const schoolA = summary({ queued: 2, leased: 1, accepted: 1, failed: 1, cancelled: 1 });
    expect(await deliverySummary()).toEqual(schoolA);
    expect(await deliverySummary(id.claimantA)).toEqual(schoolA);
    expect(await deliverySummary(id.adminB, id.schoolB)).toEqual(summary({ queued: 1 }));
    expect(await rows("app_private.family_push_jobs")).toEqual(before);
  });

  it("requires current same-school office membership and a live native AAL2 session for delivery summaries", async () => {
    for (const user of [id.adminA, id.adminB, id.teacherA, id.guardianA, id.studentUserA]) {
      await verifyAuthenticator(user);
    }
    for (const user of [id.adminB, id.teacherA, id.guardianA, id.studentUserA]) {
      await denied(deliverySummary(user));
    }
    await denied(deliverySummary(id.adminA, id.schoolB));
    await denied(deliverySummary(id.adminA, id.schoolA, "aal1"));
    await denied(deliverySummary(id.adminA, id.schoolA, "aal2", id.adminB));
    await denied(deliverySummary(null, id.schoolA, "aal2", null, "anon"));
    await denied(deliverySummary(id.adminA, id.schoolA, "aal2", id.adminA, "service_role"));
    await denied(actor(id.adminA, "select * from app_private.family_push_jobs"));

    for (const mutation of [
      "update auth.sessions set aal='aal1' where user_id=$1",
      "update auth.sessions set not_after=now()-interval '1 second' where user_id=$1",
      "update auth.mfa_factors set status='unverified' where user_id=$1",
      "delete from public.user_roles where user_id=$1",
    ]) {
      await db.exec("savepoint invalid_delivery_identity");
      await db.query(mutation, [id.adminA]);
      await denied(deliverySummary());
      await db.exec("rollback to savepoint invalid_delivery_identity; release savepoint invalid_delivery_identity");
    }
  });

  it("defaults OFF without creating devices, queues, historical backfill or changing original history",async()=>{
    const tables=["public.attendance","public.student_fees","public.fee_payments","app_private.guardian_absence_alerts"];
    const before=await Promise.all(tables.map(rows));
    expect(await settings()).toEqual({preferences:{enabled:false,absence:true,result_published:true,leave_decision:true,version:0},devices:[]});
    await register();await preferences();expect(await countJobs()).toBe(0);
    expect(await Promise.all(tables.map(rows))).toEqual(before);
    const count=await value<number>(id.guardianA,"select public.get_family_notification_unread_count('parent')::int as value");expect(count).toBe(1);
  });
  it("applies over original notifications additively with no event backfill",async()=>{
    const prior=await createRecoveryDatabase({applyPending:false});
    try{
      const sources=await readRecoverySources(await readRecoveryManifest()),index=sources.findIndex(s=>s.version==="20261106153406");
      for(const source of sources.slice(0,index).filter(s=>s.kind==="pending"))await prior.exec(source.sql);
      await seedRecoveryData(prior);const original=await prior.query("select to_jsonb(a) as row from app_private.guardian_absence_alerts a order by id");
      await prior.exec(sources[index].sql);
      expect((await prior.query("select to_jsonb(a) as row from app_private.guardian_absence_alerts a order by id")).rows).toEqual(original.rows);
      expect((await prior.query("select count(*)::int as jobs from app_private.family_push_jobs")).rows).toEqual([{jobs:0}]);
    }finally{await prior.close();}
  },30_000);
  it("retains same-owner registration identity, hashes proof and returns only redacted settings",async()=>{
    const installation=randomUUID(),first=await register(installation);
    expect(await register(installation)).toEqual(first);
    const own=await settings();expect(own.devices).toHaveLength(1);expect(Object.keys(own.devices[0]).sort()).toEqual(["created_at","id","label","last_seen_at","platform","revoked_at"]);
    expect(JSON.stringify(own)).not.toContain(fid());expect(JSON.stringify(own)).not.toContain(proof);
    const stored=(await db.query<{hashed:boolean}>("select installation_hash=sha256(convert_to($1,'UTF8')) as hashed from app_private.family_push_devices where id=$2",[proof,first.device_id])).rows[0];expect(stored.hashed).toBe(true);
  });
  it("lets the app refresh a stale phone in place: same generation, fresh last_seen_at, delivery resumes, revoked stays revoked",async()=>{
    await preferences();const installation=randomUUID(),first=await register(installation);
    await db.query("update app_private.family_push_devices set last_seen_at=now()-interval '91 days' where id=$1",[first.device_id]);
    await leave();expect(await countJobs()).toBe(0);
    expect(await register(installation)).toEqual(first);
    expect((await db.query<{fresh:boolean}>("select last_seen_at>now()-interval '1 day' as fresh from app_private.family_push_devices where id=$1",[first.device_id])).rows[0].fresh).toBe(true);
    await leave("2026-11-11");expect(await countJobs()).toBe(1);
    expect(await revoke(first.device_id)).toBe(true);await denied(register(installation));
  });
  it("refuses installation/FID theft and any cross-user/role/school rebinding even with proof",async()=>{
    const installation=randomUUID();await register(installation);
    await denied(register(installation,fid(),id.studentUserA,"student"));await denied(register(randomUUID(),fid(),id.studentUserA,"student"));
    await denied(register(installation,fid(),id.guardianA,"parent","b".repeat(64)));
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')",[id.guardianA,id.schoolA]);
    await denied(register(installation,fid(),id.guardianA,"student"));
    await db.query("update public.profiles set school_id=$2 where id=$1",[id.guardianA,id.schoolB]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')",[id.guardianA,id.schoolB]);
    await denied(register(installation,fid(),id.guardianA,"parent"));
  });
  it("requires fresh native session, active verified profile and current exact family role",async()=>{
    for(const session of [null,randomUUID()])await denied(register(randomUUID(),fid(),id.guardianA,"parent",proof,session));
    await denied(register(randomUUID(),fid(),id.adminA,"parent"));await denied(settings(id.studentUserA,"parent"));
    for(const mutation of ["delete from auth.sessions where user_id=$1","update auth.sessions set not_after=now()-interval '1 second' where user_id=$1","update public.profiles set is_active=false where id=$1","update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1","delete from public.user_roles where user_id=$1"]){
      await db.exec("savepoint invalid_identity");await db.query(mutation,[id.guardianA]);await denied(register());await denied(settings());await db.exec("rollback to savepoint invalid_identity;release savepoint invalid_identity");
    }
  });
  it("validates FID, platform, proof and the ten active-device cap",async()=>{
    for(const candidate of ["short","x".repeat(23),"x".repeat(21)+"!","https://bad.example/fid"])await invalid(register(randomUUID(),candidate));
    await invalid(register(randomUUID(),fid(),id.guardianA,"parent","secret"));
    await invalid(value(id.guardianA,"select public.register_my_family_push_device('parent',$1,$2,$3,'web','Bad') as value",[randomUUID(),proof,fid()]));
    const devices:Device[]=[];for(let n=0;n<10;n++)devices.push(await register(randomUUID(),fid(n)));
    await invalid(register(randomUUID(),fid(100)));await revoke(devices[0].device_id);expect(await register(randomUUID(),fid(100))).toHaveProperty("device_id");
  });
  it("version-checks preferences, preserves independent role state and retries identical saved intents",async()=>{
    const current=await preferences();expect(current.preferences.version).toBe(1);
    expect((await preferences()).preferences.version).toBe(1);
    await expect(preferences(id.guardianA,"parent",true,false,true,true,0)).rejects.toMatchObject({code:"PT409"});
    expect((await settings(id.studentUserA,"student")).preferences.enabled).toBe(false);
    await invalid(value(id.guardianA,"select public.set_my_family_push_preferences('parent',null,true,true,true,1) as value"));
  });
  it("fans out only new eligible saved events; in-app rows/read state stay independent",async()=>{
    await preferences();await register();await register(randomUUID(),fid(2));
    await preferences(id.studentUserA,"student");await register(randomUUID(),fid(3),id.studentUserA,"student");
    await absence();await leave();await publication();
    expect(await countJobs()).toBe(8);
    const claimed=await claim();expect(claimed).toHaveLength(8);
    for(const leased of claimed){expect(await prepare(leased)).not.toBeNull();await finish(leased,"accepted",null,"projects/qa/messages/test");}
    expect(await value(id.guardianA,"select public.get_family_notification_unread_count('parent')::int as value")).toBe(4);
    expect(await value(id.studentUserA,"select public.get_family_notification_unread_count('student')::int as value")).toBe(2);
  });
  it("does not enqueue opted-out kinds and never backfills after enabling or registering",async()=>{
    await register();await leave();expect(await countJobs()).toBe(0);
    await preferences(id.guardianA,"parent",true,false,true,false);await leave("2026-11-11");await absence();expect(await countJobs()).toBe(0);
    await publication();expect(await countJobs()).toBe(1);
    await register(randomUUID(),fid(9));expect(await countJobs()).toBe(1);
  });
  it("queues each opted-in exam device once per revision, including Guardian siblings and a Student", async () => {
    await scheduleExam();
    await preferences(id.guardianA,"parent",true,false,false,false);
    const guardian = await register();
    const otherDevice = await register(randomUUID(),fid(2));
    await preferences(id.studentUserA,"student");
    const student = await register(randomUUID(),fid(3),id.studentUserA,"student");
    await preferences(id.studentUserB,"student");
    await register(randomUUID(),fid(4),id.studentUserB,"student");
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
    const peerSection = randomUUID();
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Other section')",[peerSection,id.schoolA,id.classA]);
    // Office exams must sit inside the teacher's assignment, so give the teacher the whole class.
    await db.query("insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id) values($1,$2,$3,null,$4)",[id.teacherRecordA,id.yearA,id.classA,id.subjectA]);
    await scheduleExam(1,peerSection,id.adminA);
    await scheduleExam(-1);
    expect(await countJobs()).toBe(0);

    const assessment = await scheduleExam(0,null,id.adminA);
    await actor(id.adminA,"update public.teacher_assessments set name=name,maximum_marks=60 where id=$1",[assessment]);
    const jobs = await db.query<{device_id:string;kind:string;event_id:string;before_midnight:boolean}>(`
      select job.device_id,job.kind,job.event_id,
        job.expires_at=(assessment.assessment_date+1)::timestamp at time zone 'Asia/Kolkata' as before_midnight
      from app_private.family_push_jobs job join app_private.family_exam_schedule_events event on event.id=job.event_id
      join public.teacher_assessments assessment on assessment.id=event.assessment_id where assessment.id=$1`, [assessment]);
    expect(jobs.rows.map(row=>row.device_id).sort()).toEqual([guardian.device_id,otherDevice.device_id,student.device_id].sort());
    expect(jobs.rows.every(row=>row.kind==="exam_schedule" && row.event_id!==assessment && row.before_midnight)).toBe(true);
    const claimed = await claim();
    expect(claimed).toHaveLength(3);
    for (const lease of claimed) {
      const prepared = await prepare(lease);
      expect(prepared).toMatchObject({kind:"exam_schedule",event_id:jobs.rows[0].event_id});
      expect(prepared).not.toHaveProperty("assessment_id");
      expect(JSON.stringify(prepared)).not.toContain("Private exam");
      expect(await finish(lease,"accepted","FCM_ACCEPTED","projects/qa/messages/exam")).toBe(true);
    }
  });

  it("suppresses stale exam revisions and only cancels the Guardian when the last eligible link is lost", async () => {
    await preferences(); await register();
    const assessment = await scheduleExam();
    const initial = (await claim())[0];
    await actor(id.teacherA,"update public.teacher_assessments set description='Updated instructions' where id=$1",[assessment]);
    expect(await prepare(initial)).toBeNull();
    const revised = (await claim())[0];
    expect(revised.id).not.toBe(initial.id);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
    await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2",[id.pupilA,id.parentA]);
    expect(await prepare(revised)).toMatchObject({kind:"exam_schedule"});
    expect(await finish(revised)).toBe(true);

    await actor(id.teacherA,"update public.teacher_assessments set description='Second revision' where id=$1",[assessment]);
    const unlinked = (await claim())[0];
    await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2",[id.unlinkedPupilA,id.parentA]);
    expect(await prepare(unlinked)).toBeNull();
    expect((await job(unlinked.id)).result_code).toBe("no_longer_eligible");
  });

  it("cancels exam push after completion or a switch off before the worker sends", async () => {
    await preferences(); await register();
    const assessment = await scheduleExam();
    await actor(id.teacherA,"update public.teacher_assessments set status='completed' where id=$1",[assessment]);
    expect(await claim()).toEqual([]);
    await scheduleExam();
    const leased = (await claim())[0];
    await preferences(id.guardianA,"parent",false,true,true,true,1);
    expect(await prepare(leased)).toBeNull();
    expect((await job(leased.id)).result_code).toBe("preferences_changed");
  });

  it("queues first-published announcements only for opted-in devices in the live audience", async () => {
    const existing = await saveNotice();
    await preferences(id.guardianA,"parent",true,false,false,false);
    const guardian = await register();
    const student = await register(randomUUID(),fid(2),id.studentUserA,"student");
    await preferences(id.studentUserB,"student");
    await register(randomUUID(),fid(3),id.studentUserB,"student");
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA,id.parentA]);
    const otherSection = randomUUID();
    await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Other notice section')", [otherSection,id.schoolA,id.classA]);
    const draft = await saveNotice(noticeAudience(),false);
    await saveNotice(noticeAudience(["student","parent"],otherSection));
    await saveNotice(noticeAudience(["student"]));
    expect(await countJobs()).toBe(0);

    await toggleNotice(draft,true);
    await preferences(id.studentUserA,"student");
    const published = await saveNotice();
    await actor(id.adminA,"update public.notices set content='Edited' where id=$1", [published]);
    const { rows: jobs } = await db.query<{event_id:string;device_id:string}>(`
      select event_id,device_id from app_private.family_push_jobs where kind='announcement'`);
    expect(jobs).toHaveLength(3);
    expect(jobs.filter(row => row.event_id===draft).map(row => row.device_id)).toEqual([guardian.device_id]);
    expect(jobs.filter(row => row.event_id===published).map(row => row.device_id).sort()).toEqual([guardian.device_id,student.device_id].sort());
    expect(jobs.some(row => row.event_id===existing)).toBe(false);
    const leases = await claim();
    expect(leases).toHaveLength(3);
    for (const lease of leases) {
      const prepared = await prepare(lease);
      expect(prepared).toMatchObject({kind:"announcement"});
      expect(JSON.stringify(prepared)).not.toContain("Private announcement");
      expect(await finish(lease)).toBe(true);
    }
    await toggleNotice(published,false);
    await toggleNotice(published,true);
    expect(await countJobs()).toBe(3);
    const inbox = await value<{notifications:{source_id:string;kind:string;read_at:string|null}[]}>(id.studentUserA,
      "select public.get_family_notification_inbox_v8('student') as value");
    expect(inbox.notifications).toContainEqual(expect.objectContaining({source_id:published,kind:"announcement",read_at:null}));
  });

  it("rechecks published announcement, current audience and guardian links after leasing", async () => {
    await preferences();
    await register();
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA,id.parentA]);
    const notice = await saveNotice();
    const [remainingSibling] = await claim();
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA,id.pupilA]);
    expect(await prepare(remainingSibling)).toMatchObject({kind:"announcement",event_id:notice});
    expect(await finish(remainingSibling)).toBe(true);

    await saveNotice();
    const [removedLink] = await claim();
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA,id.unlinkedPupilA]);
    expect(await prepare(removedLink)).toBeNull();

    await preferences(id.studentUserA,"student");
    await register(randomUUID(),fid(2),id.studentUserA,"student");
    const narrowed = await saveNotice();
    const [changedAudience] = await claim();
    await actor(id.adminA,"update public.notices set audience=$2::jsonb where id=$1", [narrowed,noticeAudience(["parent"])]);
    expect(await prepare(changedAudience)).toBeNull();

    const unpublished = await saveNotice();
    const [removedPublication] = await claim();
    await toggleNotice(unpublished,false);
    expect(await prepare(removedPublication)).toBeNull();
  });

  it("holds scheduled announcements until their current publication time", async () => {
    await preferences();
    await register();
    const scheduled = await saveNotice(noticeAudience(),false);
    await actor(id.adminA, `update public.notices set published_at=statement_timestamp()+interval '1 hour',
      expires_at=statement_timestamp()+interval '3 hours' where id=$1`, [scheduled]);
    expect(await claim()).toEqual([]);

    const getSchedule = async () => (await db.query<{id:string;at_publish_time:boolean;by_notice_expiry:boolean}>(`
      select job.id,job.next_attempt_at=notice.published_at as at_publish_time,
        job.expires_at=notice.expires_at as by_notice_expiry
      from app_private.family_push_jobs job join public.notices notice on notice.id=job.event_id
      where job.kind='announcement' and notice.id=$1`, [scheduled])).rows;
    const jobs = await getSchedule();
    expect(jobs).toEqual([{id:expect.any(String),at_publish_time:true,by_notice_expiry:true}]);
    await actor(id.adminA, "update public.notices set published_at=published_at+interval '1 hour' where id=$1", [scheduled]);
    expect(await getSchedule()).toEqual(jobs);
    await actor(id.adminA, "update public.notices set expires_at=expires_at+interval '1 hour' where id=$1", [scheduled]);
    expect(await getSchedule()).toEqual(jobs);
    expect(await claim()).toEqual([]);
    await toggleNotice(scheduled,true);
    const [lease] = await claim();
    expect(lease.id).toBe(jobs[0].id);
    expect(await prepare(lease)).toMatchObject({kind:"announcement",event_id:scheduled});
  });

  it("leases due-today fee reminders for opted-in families and keeps inbox read state independent", async () => {
    await feeDueWindow(true);
    const due = await saveFee(0);
    const partial = await saveFee(0);
    await payFee(partial,250);
    const settled = await saveFee(0);
    await payFee(settled,1000);
    const installation = randomUUID();
    await preferences(id.guardianA,"parent",true,false,false,false);
    const guardian = await register(installation);
    const student = await register(randomUUID(),fid(2),id.studentUserA,"student");
    await preferences(id.studentUserB,"student");
    await register(randomUUID(),fid(3),id.studentUserB,"student");
    await saveFee(-1);
    await saveFee(1);
    await saveFee(null);
    await saveFee(0,-50);
    await saveFee(0,1000,id.unlinkedPupilA);
    const mark = () => value<string>(id.guardianA,"select public.mark_family_notification_read_v8('parent','fee_due',$1)::text as value", [partial]);
    const readAt = await mark();
    expect(readAt).toEqual(expect.any(String));
    expect(await countJobs()).toBe(0);

    const batch = randomUUID();
    const guardianLeases = await claim(batch);
    expect(guardianLeases).toHaveLength(2);
    expect(await claim(batch)).toEqual(guardianLeases);
    expect(await claim()).toEqual([]);
    for (const lease of guardianLeases) {
      expect(await prepare(lease)).toMatchObject({kind:"fee_due",recipient_role:"parent"});
      expect(await finish(lease)).toBe(true);
    }
    expect(await register(installation,fid(4))).toMatchObject({device_id:guardian.device_id,generation:2});
    expect(await claim()).toEqual([]);

    await preferences(id.studentUserA,"student");
    expect(await claim()).toEqual([]);
    await nextFeeDueScan();
    const studentLeases = await claim();
    expect(studentLeases).toHaveLength(2);
    for (const lease of studentLeases) {
      const prepared = await prepare(lease);
      expect(prepared).toMatchObject({kind:"fee_due",recipient_role:"student"});
      expect(prepared).not.toHaveProperty("balance");
      expect(JSON.stringify(prepared)).not.toContain("Recovery tuition");
      expect(await finish(lease)).toBe(true);
    }
    expect(await mark()).toBe(readAt);
    const inbox = await value<{notifications:{source_id:string;kind:string;read_at:string|null}[]}>(id.studentUserA,
      "select public.get_family_notification_inbox_v8('student') as value");
    expect(inbox.notifications).toContainEqual(expect.objectContaining({source_id:partial,kind:"fee_due",read_at:null}));
    const { rows: jobs } = await db.query<{event_id:string;device_id:string;at_next_ist_midnight:boolean}>(`
      select job.event_id,job.device_id,job.expires_at=(fee.due_date+1)::timestamp at time zone 'Asia/Kolkata' as at_next_ist_midnight
      from app_private.family_push_jobs job join public.student_fees fee on fee.id=job.event_id where job.kind='fee_due'`);
    expect(jobs).toHaveLength(4);
    for (const device of [guardian,student]) {
      expect(jobs.filter(row => row.device_id===device.device_id).map(row => row.event_id).sort()).toEqual([due,partial].sort());
    }
    expect(jobs.every(row => row.at_next_ist_midnight)).toBe(true);
  });

  it("rechecks live ledger, links and native session before sending leased fee reminders", async () => {
    await feeDueWindow(true);
    await preferences();
    await register();
    await preferences(id.studentUserA,"student");
    await register(randomUUID(),fid(2),id.studentUserA,"student");
    const settled = await saveFee(0);
    const unlinked = await saveFee(0);
    const leases = await claim();
    expect(leases).toHaveLength(4);
    await payFee(settled,1000);
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA,id.pupilA]);
    for (const lease of leases) {
      const row = await job(lease.id);
      if (row.event_id===settled || row.recipient_role==="parent") {
        expect(await prepare(lease)).toBeNull();
        expect(await job(lease.id)).toMatchObject({status:"cancelled",result_code:"no_longer_eligible"});
      } else {
        await db.query("delete from auth.sessions where user_id=$1", [id.studentUserA]);
        expect(await prepare(lease)).toBeNull();
        expect(await job(lease.id)).toMatchObject({event_id:unlinked,status:"cancelled",result_code:"no_longer_eligible"});
      }
    }
    expect(await claim()).toEqual([]);
  });

  it("queues recorded fee payments once per opted-in family device and retains independent receipts", async () => {
    const demand = await saveFee(1);
    const earlier = await payFee(demand,100);
    await preferences();
    const guardian = await register();
    const guardianTablet = await register(randomUUID(),fid(2));
    const student = await register(randomUUID(),fid(3),id.studentUserA,"student");
    await preferences(id.studentUserB,"student");
    await register(randomUUID(),fid(4),id.studentUserB,"student");
    const request = randomUUID();
    const receipt = await payFee(demand,125.25,request);
    expect(await payFee(demand,125.25,request)).toEqual(receipt);
    expect(await paymentDetail(id.studentUserA,"student",receipt.payment_id)).toMatchObject({
      id:receipt.payment_id,status:"paid",receipt_no:receipt.receipt_no,amount:"125.25",
    });
    const guardianRead = await paymentRead(id.guardianA,"parent",receipt.payment_id);
    expect(guardianRead).toEqual(expect.any(String));
    await preferences(id.studentUserA,"student");
    const next = await payFee(demand,200);
    const { rows: publications } = await db.query<{payment_id:string}>(`
      select publication.payment_id from app_private.family_fee_payment_publications publication
      join public.fee_payments payment on payment.id=publication.payment_id where payment.student_fee_id=$1`, [demand]);
    expect(publications.map(row => row.payment_id).sort()).toEqual([earlier.payment_id,receipt.payment_id,next.payment_id].sort());
    const { rows: jobs } = await db.query<{event_id:string;device_id:string}>(`
      select event_id,device_id from app_private.family_push_jobs where kind='fee_payment'`);
    expect(jobs).toHaveLength(5);
    const guardianDevices = [guardian.device_id,guardianTablet.device_id];
    expect(jobs.filter(row => row.event_id===receipt.payment_id).map(row => row.device_id).sort()).toEqual(guardianDevices.sort());
    expect(jobs.filter(row => row.event_id===next.payment_id).map(row => row.device_id).sort()).toEqual([...guardianDevices,student.device_id].sort());
    expect(jobs.some(row => row.event_id===earlier.payment_id)).toBe(false);

    const leases = await claim();
    expect(leases).toHaveLength(5);
    for (const lease of leases) {
      const prepared = await prepare(lease);
      expect(prepared).toMatchObject({kind:"fee_payment"});
      expect(prepared).not.toHaveProperty("amount");
      expect(JSON.stringify(prepared)).not.toContain(receipt.receipt_no);
      expect(await finish(lease)).toBe(true);
    }
    expect(await paymentRead(id.guardianA,"parent",receipt.payment_id)).toBe(guardianRead);
    const inbox = await value<{notifications:{source_id:string;kind:string;read_at:string|null}[]}>(id.studentUserA,
      "select public.get_family_notification_inbox_v8('student') as value");
    expect(inbox.notifications).toContainEqual(expect.objectContaining({source_id:next.payment_id,kind:"fee_payment",read_at:null}));
    expect(await claim()).toEqual([]);
  });

  it("suppresses claimed payment push after independently approved reversal without losing the original receipt", async () => {
    await preferences();
    await register();
    await preferences(id.studentUserA,"student");
    await register(randomUUID(),fid(2),id.studentUserA,"student");
    const demand = await saveFee(1);
    const receipt = await payFee(demand,100);
    const guardianRead = await paymentRead(id.guardianA,"parent",receipt.payment_id);
    expect(guardianRead).toEqual(expect.any(String));
    const leases = await claim();
    expect(leases).toHaveLength(2);

    const principal = randomUUID();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [principal,`${principal}@fee-reversal.invalid`]);
    await db.query("update public.profiles set school_id=$1 where id=$2", [id.schoolA,principal]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')", [principal,id.schoolA]);
    await db.query("insert into auth.sessions(id,user_id,aal) values($1,$1,'aal1')", [principal]);
    const ledger = await value<{rows:{demand_id:string;financial_token:string}[]}>(id.adminA,
      "select public.get_office_fee_ledger($1,null,$2) as value", [id.schoolA,id.pupilA]);
    const token = ledger.rows.find(row => row.demand_id===demand)?.financial_token;
    expect(token).toEqual(expect.any(String));
    const reversal = await value<{id:string}>(id.adminA, `select public.request_office_fee_change(
      $1,$2,'payment_reversal',null,$3,'Synthetic receipt correction',$4,$5) as value`,
    [id.schoolA,demand,receipt.payment_id,token,randomUUID()]);
    const approved = await value<{state:string;reference:string}>(principal,
      "select public.review_office_fee_change($1,'approved','Synthetic independent review') as value", [reversal.id]);
    expect(approved.state).toBe("approved");
    for (const lease of leases) {
      expect(await prepare(lease)).toBeNull();
      expect(await job(lease.id)).toMatchObject({status:"cancelled",result_code:"no_longer_eligible"});
    }
    expect(await countJobs()).toBe(2);
    for (const [user,role] of [[id.guardianA,"parent"],[id.studentUserA,"student"]]) {
      expect(await paymentDetail(user,role,receipt.payment_id)).toMatchObject({
        id:receipt.payment_id,status:"reversed",receipt_no:receipt.receipt_no,
        amount:"100.00",net_amount:"0.00",reversal_reference:approved.reference,
      });
    }
    expect(await paymentRead(id.guardianA,"parent",receipt.payment_id)).toBe(guardianRead);
    const inbox = await value<{notifications:{source_id:string;kind:string;status:string;read_at:string|null}[]}>(id.studentUserA,
      "select public.get_family_notification_inbox_v8('student') as value");
    expect(inbox.notifications).toContainEqual(expect.objectContaining({source_id:receipt.payment_id,kind:"fee_payment",status:"reversed",read_at:null}));
  });

  it("queues only the first homework publication for opted-in eligible devices and deduplicates siblings", async () => {
    await preferences(id.guardianA,"parent",true,false,false,false);
    const guardian = await register();
    await preferences(id.studentUserA,"student");
    const student = await register(randomUUID(),fid(2),id.studentUserA,"student");
    await preferences(id.studentUserB,"student");
    await register(randomUUID(),fid(3),id.studentUserB,"student");
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);

    const draft = await saveHomework("draft");
    expect(await countJobs()).toBe(0);
    await saveHomework("published", draft.logId);
    await saveHomework("draft", draft.logId);
    await saveHomework("published", draft.logId);
    await register(randomUUID(),fid(4));
    expect(await countJobs()).toBe(2);

    const { rows: jobs } = await db.query<{ device_id: string; expires_in_one_day: boolean }>(`
      select job.device_id, job.expires_at = publication.published_at + interval '24 hours' as expires_in_one_day
      from app_private.family_push_jobs job
      join app_private.family_homework_publications publication on publication.activity_id = job.event_id
      where job.kind = 'homework_assigned' and job.event_id = $1`, [draft.activityId]);
    expect(jobs.map((item) => item.device_id).sort()).toEqual([guardian.device_id, student.device_id].sort());
    expect(jobs.every((item) => item.expires_in_one_day)).toBe(true);
    const leases = await claim();
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      const message = await prepare(lease);
      expect(message).toMatchObject({ kind: "homework_assigned", event_id: draft.activityId });
      expect(JSON.stringify(message)).not.toContain("Private assignment");
      expect(await finish(lease)).toBe(true);
    }
    const added = await saveHomework("published", draft.logId, "Additional assignment");
    const addedLeases = await claim();
    expect(addedLeases).toHaveLength(3);
    for (const lease of addedLeases) {
      expect(await prepare(lease)).toMatchObject({ kind: "homework_assigned", event_id: added.activityId });
    }
  });

  it("rechecks current homework access before sending an already leased notification", async () => {
    await preferences();
    await register();
    await register(randomUUID(),fid(3));
    await preferences(id.studentUserA,"student");
    await register(randomUUID(),fid(2),id.studentUserA,"student");
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
    const work = await saveHomework("published");
    const leases = await claim();
    expect(leases).toHaveLength(3);
    const { rows: [{ id: studentJobId }] } = await db.query<{ id: string }>(
      "select id from app_private.family_push_jobs where recipient_role='student'");
    const student = leases.find(({ id }) => id === studentJobId)!;
    const [parent, otherParent] = leases.filter(({ id }) => id !== studentJobId);

    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2",[id.parentA,id.pupilA]);
    expect(await prepare(parent)).toMatchObject({ kind: "homework_assigned", event_id: work.activityId });
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2",[id.parentA,id.unlinkedPupilA]);
    expect(await prepare(otherParent)).toBeNull();
    expect((await job(otherParent.id)).result_code).toBe("no_longer_eligible");
    // FCM already accepted the prepared send, so the outcome is recorded even though access changed.
    expect(await finish(parent)).toBe(true);
    expect(await job(parent.id)).toMatchObject({ status: "accepted", last_outcome: "accepted" });

    await saveHomework("draft", work.logId);
    expect(await prepare(student)).toBeNull();
    expect((await job(student.id)).result_code).toBe("no_longer_eligible");
  });

  it("fences batch/lease retries and rejects forged service context without exposing FIDs",async()=>{
    await ready();const batch=randomUUID(),first=await claim(batch);expect(first).toHaveLength(1);expect(await claim(batch)).toEqual(first);expect(await claim()).toEqual([]);
    expect(Object.keys(first[0]).sort()).toEqual(["id","lease_id"]);
    await denied(value(id.guardianA,"select public.claim_family_push_jobs($1) as value",[randomUUID()]));
    await denied(value(null,"select public.claim_family_push_jobs($1) as value",[randomUUID()],"service_role",null,db,"authenticated"));
    await denied(value(id.guardianA,"select public.claim_family_push_jobs($1) as value",[randomUUID()],"authenticated",id.guardianA,db,"service_role"));
    const prepared=await prepare(first[0]);expect(prepared?.device_fid).toBe(fid());expect(await prepare(first[0])).toBeNull();
    expect(await prepare({id:first[0].id,lease_id:randomUUID()})).toBeNull();
    expect(await finish(first[0],"accepted",null,"projects/qa/messages/accepted")).toBe(true);expect(await finish(first[0])).toBe(true);expect(await finish(first[0],"retry")).toBe(false);
    expect((await job(first[0].id)).status).toBe("accepted");
  });
  it("reclaims expired leases with a new fence and never reuses an expired batch",async()=>{
    await ready();const batch=randomUUID(),first=(await claim(batch))[0];await prepare(first);
    await db.query("update app_private.family_push_jobs set lease_until=now()-interval '1 second' where id=$1",[first.id]);
    await db.query("update app_private.family_push_batches set expires_at=now()-interval '1 second' where id=$1",[batch]);
    expect(await claim(batch)).toEqual([]);const next=(await claim())[0];expect(next.id).toBe(first.id);expect(next.lease_id).not.toBe(first.lease_id);
    expect(await finish(first)).toBe(false);expect(await prepare(next)).not.toBeNull();expect((await job(next.id)).attempts).toBe(2);
  });
  it("rechecks revoked links and sibling eligibility between claim and send",async()=>{
    await ready();
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
    await leave("2026-11-11",id.unlinkedPupilA);const leases=await claim();expect(leases).toHaveLength(2);
    const references=(await db.query<{id:string;student_id:string}>("select j.id,e.student_id from app_private.family_push_jobs j join app_private.family_notifications e on e.id=j.event_id")).rows;
    const revoked=leases.find(l=>references.find(r=>r.id===l.id)?.student_id===id.pupilA)!;
    const sibling=leases.find(l=>l.id!==revoked.id)!;
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2",[id.parentA,id.pupilA]);
    expect(await prepare(revoked)).toBeNull();expect((await job(revoked.id)).status).toBe("cancelled");
    expect(await prepare(sibling)).not.toBeNull();
    expect((await db.query<{count:number}>("select count(*)::int as count from app_private.family_notifications")).rows[0].count).toBe(3);
  });
  it("rechecks preferences, current role/profile/session, TTL and stale-device age before send",async()=>{
    const mutations=["update app_private.family_push_preferences set enabled=false","delete from auth.sessions where user_id=$1","delete from public.user_roles where user_id=$1","update public.profiles set is_active=false where id=$1","update app_private.family_push_devices set last_seen_at=now()-interval '91 days'","update app_private.family_push_jobs set expires_at=now()-interval '1 second'"];
    for(const mutation of mutations){
      await db.exec("savepoint dispatch_recheck");await ready();const lease=(await claim())[0];await db.query(mutation,mutation.includes("$1")?[id.guardianA]:[]);
      expect(await prepare(lease)).toBeNull();expect((await job(lease.id)).status).toBe("cancelled");await db.exec("rollback to savepoint dispatch_recheck;release savepoint dispatch_recheck");
    }
  });
  it("suppresses old generation jobs on FID/session refresh and prevents late invalid-token acks revoking new generation",async()=>{
    await preferences();const installation=randomUUID(),first=await register(installation);await leave();const lease=(await claim())[0];await prepare(lease);
    const refreshed=await register(installation,fid(2));expect(refreshed).toEqual({device_id:first.device_id,generation:2});
    expect(await finish(lease,"invalid_token","unregistered")).toBe(false);
    const device=(await settings()).devices[0];expect(device.revoked_at).toBeNull();
    const session=randomUUID();await db.query("insert into auth.sessions(id,user_id) values($1,$2)",[session,id.guardianA]);
    expect((await register(installation,fid(2),id.guardianA,"parent",proof,session)).generation).toBe(3);
  });
  it("revokes only own devices idempotently and retains read/source history",async()=>{
    const device=await ready(),before=await rows("app_private.family_notifications");
    expect(await revoke(device.device_id,id.studentUserA,"student")).toBe(false);expect(await revoke(device.device_id)).toBe(true);expect(await revoke(device.device_id)).toBe(true);
    expect(await claim()).toEqual([]);expect(await rows("app_private.family_notifications")).toEqual(before);
    expect((await settings()).devices[0].revoked_at).toBeTruthy();
    await denied(register((await db.query<{installation_id:string}>("select installation_id from app_private.family_push_devices where id=$1",[device.device_id])).rows[0].installation_id));
  });
  it("revokes the caller's own registration by installation id idempotently, never another user's",async()=>{
    await preferences();const installation=randomUUID(),device=await register(installation);await leave();
    const byInstallation=(user:string,role:string,installationId:string|null=installation)=>value<boolean>(user,"select public.revoke_my_family_push_installation($1,$2) as value",[role,installationId]);
    expect(await byInstallation(id.studentUserA,"student")).toBe(false);
    expect(await byInstallation(id.guardianA,"parent",randomUUID())).toBe(false);
    await denied(actor(null,"select public.revoke_my_family_push_installation('parent',$1)",[installation],"anon"));
    expect((await settings()).devices[0].revoked_at).toBeNull();
    expect(await byInstallation(id.guardianA,"parent")).toBe(true);expect(await byInstallation(id.guardianA,"parent")).toBe(true);
    const {rows:[row]}=await db.query<{generation:number;revoked:boolean}>("select generation,revoked_at is not null as revoked from app_private.family_push_devices where id=$1",[device.device_id]);
    expect(row).toEqual({generation:device.generation+1,revoked:true});
    expect(await claim()).toEqual([]);
    await invalid(byInstallation(id.guardianA,"parent",null));
  });
  it("honors retry backoff/max-attempts and terminal invalid-FID cleanup without touching in-app read state",async()=>{
    await ready();const first=(await claim())[0];await prepare(first);expect(await finish(first,"retry","unavailable",null,120)).toBe(true);expect(await claim()).toEqual([]);
    expect((await job(first.id)).status).toBe("queued");
    await db.query("update app_private.family_push_jobs set next_attempt_at=now()-interval '1 second' where id=$1",[first.id]);
    const second=(await claim())[0];await prepare(second);expect(await finish(second,"invalid_token","unregistered")).toBe(true);
    expect((await job(first.id)).status).toBe("failed");expect((await settings()).devices[0].revoked_at).toBeTruthy();
    expect(await value(id.guardianA,"select public.get_family_notification_unread_count('parent')::int as value")).toBe(2);
  });
  it("does not resurrect exhausted attempts, terminal failures or expired jobs",async()=>{
    await ready();await db.exec("update app_private.family_push_jobs set attempts=5");expect(await claim()).toEqual([]);
    expect((await db.query("select status,result_code from app_private.family_push_jobs")).rows).toEqual([{status:"failed",result_code:"attempts_exhausted"}]);
  });
  it("validates trusted claim bounds/outcome code fields and denies every raw private/helper path",async()=>{
    for(const limit of [0,21])await invalid(claim(randomUUID(),limit));
    await ready();const lease=(await claim())[0];await prepare(lease);
    await invalid(finish(lease,"bogus"));await invalid(finish(lease,"failed","provider raw text"));await invalid(finish(lease,"accepted",null,"<script>private</script>"));
    for(const role of ["anon","authenticated","service_role"]){
      for(const table of ["family_push_preferences","family_push_devices","family_push_jobs","family_push_batches"])await denied(actor(role==="authenticated"?id.guardianA:null,`select * from app_private.${table}`,[],role));
      await denied(actor(role==="authenticated"?id.guardianA:null,"select app_private.family_push_service()",[],role));
    }
  });
  it("keeps every active device visible ahead of bounded revoked history",async()=>{
    const active=await register();
    await db.query(`insert into app_private.family_push_devices(installation_id,installation_hash,user_id,recipient_role,school_id,session_id,device_fid,fid_hash,platform,label,created_at,revoked_at)
      select gen_random_uuid(),sha256(convert_to('proof','UTF8')),$1,'parent',$2,$1,'c'||lpad(n::text,21,'0'),sha256(convert_to('c'||lpad(n::text,21,'0'),'UTF8')),
      'android','Old revoked phone',statement_timestamp()+make_interval(secs=>n),statement_timestamp() from generate_series(100,159)n`,[id.guardianA,id.schoolA]);
    const own=await settings();expect(own.devices).toHaveLength(50);expect(own.devices[0].id).toBe(active.device_id);
    expect(own.devices.filter(d=>d.revoked_at===null)).toHaveLength(1);
  });
  it("caps new registration churn even when every previous device was revoked",async()=>{
    await db.query(`insert into app_private.family_push_devices(installation_id,installation_hash,user_id,recipient_role,school_id,session_id,device_fid,fid_hash,platform,label,revoked_at)
      select gen_random_uuid(),sha256(convert_to('proof','UTF8')),$1,'parent',$2,$1,'c'||lpad(n::text,21,'0'),sha256(convert_to('c'||lpad(n::text,21,'0'),'UTF8')),
      'android','Old revoked phone',statement_timestamp() from generate_series(100,199)n`,[id.guardianA,id.schoolA]);
    await invalid(register());expect((await db.query<{count:number}>("select count(*)::int as count from app_private.family_push_devices")).rows[0].count).toBe(100);
  });
  it("isolates partial device failure and accepts real opaque provider message-id characters",async()=>{
    await preferences();await register();await register(randomUUID(),fid(2));await leave();const leases=await claim();expect(leases).toHaveLength(2);
    expect(await prepare(leases[0])).not.toBeNull();expect(await finish(leases[0],"invalid_token","UNREGISTERED")).toBe(true);
    expect(await prepare(leases[1])).not.toBeNull();expect(await finish(leases[1],"accepted","FCM_ACCEPTED","projects/qa/messages/0:123%abc-Def_+/x~")).toBe(true);
    expect((await job(leases[1].id)).status).toBe("accepted");
    const devices=(await settings()).devices;expect(devices.filter(d=>d.revoked_at===null)).toHaveLength(1);
  });
  it("rolls source decisions, inbox events and push jobs back in one transaction",async()=>{
    await preferences();await register();const before=await rows("app_private.family_notifications");await db.exec("savepoint source_rollback");await leave();expect(await countJobs()).toBe(1);
    await db.exec("rollback to savepoint source_rollback;release savepoint source_rollback");expect(await countJobs()).toBe(0);expect(await rows("app_private.family_notifications")).toEqual(before);
  });

  it("honors provider Retry-After beyond one hour and retains exponential minimum backoff",async()=>{
    await ready();const first=(await claim())[0];await prepare(first);expect(await finish(first,"retry","UNAVAILABLE",null,7200)).toBe(true);
    expect((await db.query<{delay:number}>("select extract(epoch from next_attempt_at-finished_at)::int as delay from app_private.family_push_jobs where id=$1",[first.id])).rows[0].delay).toBe(7200);
    await db.query("update app_private.family_push_jobs set next_attempt_at=now()-interval '1 second' where id=$1",[first.id]);
    const second=(await claim())[0];await prepare(second);expect(await finish(second,"retry","UNAVAILABLE",null,60)).toBe(true);
    expect((await db.query<{delay:number}>("select extract(epoch from next_attempt_at-finished_at)::int as delay from app_private.family_push_jobs where id=$1",[first.id])).rows[0].delay).toBe(120);
  });

  it("keeps remote revocation effective against ordinary registration refresh and requires a fresh native installation",async()=>{
    await preferences();const installation=randomUUID(),device=await register(installation);await leave();await revoke(device.device_id);
    const devices=await rows("app_private.family_push_devices"),jobs=await rows("app_private.family_push_jobs");
    await denied(register(installation));
    await denied(register(installation,fid(2)));
    await denied(register(randomUUID(),fid()));
    expect(await rows("app_private.family_push_devices")).toEqual(devices);expect(await rows("app_private.family_push_jobs")).toEqual(jobs);
    const fresh=await register(randomUUID(),fid(2),id.guardianA,"parent","c".repeat(64));expect(fresh.device_id).not.toBe(device.device_id);
    expect(await rows("app_private.family_push_jobs")).toEqual(jobs);expect((await settings()).devices.filter(d=>d.revoked_at===null).map(d=>d.id)).toEqual([fresh.device_id]);
  });

});

describe("native push dispatch timing, fairness, retention and provider outcomes", () => {
  const rawDevice = async (user: string, role: string, school: string) => (await db.query<{ id: string }>(`
    insert into app_private.family_push_devices(installation_id,installation_hash,user_id,recipient_role,school_id,session_id,device_fid,fid_hash,platform,label)
    values(gen_random_uuid(),sha256(convert_to('proof','UTF8')),$1,$2,$3,$1,$4,sha256(convert_to($4,'UTF8')),'android','Raw phone') returning id`,
  [user, role, school, `r${randomUUID().replaceAll("-", "").slice(0, 21)}`])).rows[0].id;
  const rawJob = async (device: string, kind: string, readyAgo: string) => (await db.query<{ id: string }>(`
    insert into app_private.family_push_jobs(kind,event_id,device_id,device_generation,user_id,recipient_role,school_id,expires_at,next_attempt_at,created_at)
    select $2,gen_random_uuid(),device.id,device.generation,device.user_id,device.recipient_role,device.school_id,
      now()+interval '1 day',now()-$3::interval,now()-$3::interval
    from app_private.family_push_devices device where device.id=$1 returning id`, [device, kind, readyAgo])).rows[0].id;
  const touched = async () => (await db.query<{ id: string }>(
    "select id from app_private.family_push_jobs where status<>'queued' order by id")).rows.map(row => row.id).sort();

  it("opens due-today fee reminders at 08:00 IST", async () => {
    const { rows: [gate] } = await db.query(`select app_private.family_fee_due_push_open('2026-12-10 00:30+05:30'::timestamptz) as midnight,
      app_private.family_fee_due_push_open('2026-12-10 07:59:59+05:30'::timestamptz) as early,
      app_private.family_fee_due_push_open('2026-12-10 08:00+05:30'::timestamptz) as open,
      app_private.family_fee_due_push_open('2026-12-10 23:59:59+05:30'::timestamptz) as late`);
    expect(gate).toEqual({ midnight: false, early: false, open: true, late: true });
  });

  it("queues nothing for a due-today fee before 08:00 IST and exactly one reminder per device afterwards", async () => {
    await preferences();
    const guardian = await register();
    const fee = await saveFee(0);
    await feeDueWindow(false);
    expect(await claim()).toEqual([]);
    expect(await countJobs()).toBe(0);
    await feeDueWindow(true);
    const [lease, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(await job(lease.id)).toMatchObject({ kind: "fee_due", event_id: fee, device_id: guardian.device_id });
    expect(await claim()).toEqual([]);
  });

  it("asks the fee ledger only about due-today fees of pupils who have a device", async () => {
    await preferences();
    const guardian = await register();
    const own = await saveFee(0);
    await saveFee(0, 1000, id.unlinkedPupilA);
    // Record every fee the scan asks the ledger about; the real check still decides.
    await db.exec(`alter function app_private.family_fee_due_push_position(uuid,uuid,uuid) rename to family_fee_due_push_position_checked;
      create table app_private.fee_due_ledger_calls(fee_id uuid);
      create function app_private.family_fee_due_push_position(p_school_id uuid,p_fee_id uuid,p_student_id uuid)
      returns boolean language plpgsql volatile set search_path='' as $$
      begin
        insert into app_private.fee_due_ledger_calls values(p_fee_id);
        return app_private.family_fee_due_push_position_checked(p_school_id,p_fee_id,p_student_id);
      end $$`);
    await feeDueWindow(true);
    const [lease, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(await job(lease.id)).toMatchObject({ kind: "fee_due", event_id: own, device_id: guardian.device_id });
    const { rows: asked } = await db.query<{ fee_id: string }>("select distinct fee_id from app_private.fee_due_ledger_calls");
    expect(asked.map(row => row.fee_id)).toEqual([own]);
  });

  it("takes turns across schools so one school's backlog does not hold back another", async () => {
    const deviceA = await rawDevice(id.guardianA, "parent", id.schoolA);
    const deviceB = await rawDevice(id.studentUserB, "student", id.schoolB);
    const oldestA = await rawJob(deviceA, "leave_decision", "3 hours");
    await rawJob(deviceA, "leave_decision", "2 hours");
    await rawJob(deviceA, "leave_decision", "1 hour");
    const newestB = await rawJob(deviceB, "leave_decision", "1 minute");
    await claim(randomUUID(), 2);
    expect(await touched()).toEqual([oldestA, newestB].sort());
  });

  it("claims a school's absence alerts ahead of its older bulk notifications", async () => {
    const device = await rawDevice(id.guardianA, "parent", id.schoolA);
    await rawJob(device, "announcement", "2 hours");
    const absent = await rawJob(device, "absence", "1 minute");
    await claim(randomUUID(), 1);
    expect(await touched()).toEqual([absent]);
  });

  it("prunes long-expired batches and old terminal jobs in bounded chunks while keeping live state", async () => {
    const live = randomUUID();
    await ready();
    const leases = await claim(live);
    expect(leases).toHaveLength(1);
    const [stale, recent] = [randomUUID(), randomUUID()];
    await db.query(`insert into app_private.family_push_batches(id,expires_at,jobs) values
      ($1,now()-interval '2 days','[]'),($2,now()-interval '1 minute','[]')`, [stale, recent]);
    const device = await rawDevice(id.guardianA, "parent", id.schoolA);
    const ancient = await rawJob(device, "leave_decision", "91 days");
    const tenDays = await rawJob(device, "leave_decision", "10 days");
    await db.query(`update app_private.family_push_jobs set status='accepted',finished_at=next_attempt_at,expires_at=next_attempt_at
      where id = any($1)`, [[ancient, tenDays]]);
    const waiting = await rawJob(device, "leave_decision", "-1 hour");
    expect(await claim()).toEqual([]);
    const { rows: batches } = await db.query<{ id: string }>("select id from app_private.family_push_batches where id = any($1)", [[live, stale, recent]]);
    expect(batches.map(row => row.id).sort()).toEqual([live, recent].sort());
    expect(await claim(live)).toEqual(leases);
    const { rows: kept } = await db.query<{ id: string }>("select id from app_private.family_push_jobs where id = any($1)", [[ancient, tenDays, waiting]]);
    expect(kept.map(row => row.id).sort()).toEqual([tenDays, waiting].sort());
  });

  it("records an FCM-accepted send even if the job expired after preparation", async () => {
    await ready();
    const [lease] = await claim();
    expect(await prepare(lease)).not.toBeNull();
    await db.query("update app_private.family_push_jobs set expires_at=now()-interval '1 second' where id=$1", [lease.id]);
    expect(await finish(lease, "accepted", "FCM_ACCEPTED", "projects/qa/messages/late")).toBe(true);
    expect(await job(lease.id)).toMatchObject({ status: "accepted", last_outcome: "accepted", provider_id: "projects/qa/messages/late" });
  });

  it("still revokes an UNREGISTERED device when preferences changed after preparation", async () => {
    const device = await ready();
    const [lease] = await claim();
    expect(await prepare(lease)).not.toBeNull();
    await db.query("update app_private.family_push_preferences set enabled=false where user_id=$1", [id.guardianA]);
    expect(await finish(lease, "invalid_token", "UNREGISTERED")).toBe(true);
    expect((await db.query("select generation,revoked_at is not null as revoked from app_private.family_push_devices where id=$1", [device.device_id])).rows[0])
      .toEqual({ generation: device.generation + 1, revoked: true });
  });

  it("cancels instead of requeueing a retry for a job that is no longer eligible", async () => {
    await ready();
    const [lease] = await claim();
    expect(await prepare(lease)).not.toBeNull();
    await db.query("update app_private.family_push_preferences set enabled=false where user_id=$1", [id.guardianA]);
    // null confirms the outcome but tells the dispatcher the job was cancelled, so it is counted as suppressed.
    expect(await finish(lease, "retry", "PROVIDER_UNAVAILABLE", null, 120)).toBeNull();
    expect(await job(lease.id)).toMatchObject({ status: "cancelled", result_code: "no_longer_eligible", last_outcome: "retry" });
    expect(await finish(lease, "retry", "PROVIDER_UNAVAILABLE", null, 120)).toBeNull();
  });

  it("skips row-locked prune candidates instead of waiting behind an overlapping claim", async () => {
    // PGlite has one connection, so a second session cannot hold the lock; assert both prune selections skip locked rows.
    const { rows: [{ body }] } = await db.query<{ body: string }>(
      "select pg_get_functiondef('app_private.claim_family_push_jobs(uuid,integer)'::regprocedure) as body");
    expect(body.match(/limit (1000|500) for update skip locked\)/g)).toEqual(["limit 1000 for update skip locked)", "limit 500 for update skip locked)"]);
  });

  it("scans due-today fees at most once a minute across back-to-back claims", async () => {
    await preferences();
    await register();
    await feeDueWindow(true);
    const first = await saveFee(0);
    const [lease] = await claim();
    expect(await job(lease.id)).toMatchObject({ kind: "fee_due", event_id: first });
    const second = await saveFee(0, 500);
    expect(await claim()).toEqual([]);
    await nextFeeDueScan();
    const [next, ...rest] = await claim();
    expect(rest).toEqual([]);
    expect(await job(next.id)).toMatchObject({ kind: "fee_due", event_id: second });
  });
});
