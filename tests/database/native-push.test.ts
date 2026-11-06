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
type Settings = {preferences:{enabled:boolean;absence:boolean;result_published:boolean;leave_decision:boolean;version:number};devices:Record<string,unknown>[]};
type Prepared = {job_id:string;lease_id:string;device_fid:string;platform:string;kind:string;event_id:string;recipient_role:string;expires_at:string};

beforeAll(async()=>{
  db=await createRecoveryDatabase();await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users;begin");
  await db.query("update public.teacher_assessments set status='completed' where id=$1",[id.assessmentA]);
  await actor(id.teacherA,"insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,0)",[id.assessmentA,id.unlinkedPupilA]);
  await db.exec("commit");
},60_000);
beforeEach(()=>db.exec("begin"));afterEach(()=>db.exec("rollback"));afterAll(()=>db?.close());
async function actor<T extends Record<string,unknown>=Record<string,unknown>>(user:string|null,sql:string,args:unknown[]=[],role="authenticated",session:string|null=user,connection=db,claimRole=role){
  await connection.exec("savepoint native_push_actor");
  try{
    await connection.exec(`set local role ${role}`);
    await connection.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user??"",JSON.stringify({sub:user,role:claimRole,session_id:session})]);
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
async function ready(){await preferences();const device=await register();await leave();return device;}
const job=async(jobId:string)=>(await db.query<Record<string,unknown>>("select * from app_private.family_push_jobs where id=$1",[jobId])).rows[0];

describe("native family push under the recovered application schema",()=>{
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
