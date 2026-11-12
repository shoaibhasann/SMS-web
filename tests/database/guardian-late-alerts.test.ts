// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite,day:string;
const principal=randomUUID(),finance=randomUUID(),peer=randomUUID(),peerParent=randomUUID(),replacement=randomUUID();
type Policy={user_id:string;school_id:string;enabled:boolean;version:number;history:{version:number;enabled:boolean;reason:string;actor_id:string;actor_name:string|null;created_at:string}[]};
type Ack={user_id:string;school_id:string;enabled:boolean;version:number;request_id:string;replayed:boolean};
type Item={id:string;kind:string;student_id:string;source_id:string;status:string;read_at:string|null;event_date:string;occurred_at:null;delayed:false;assessment_id:null};
type Cursor={created_at:string;kind:string;id:string};
type Inbox={user_id:string;role:string;notifications:Item[];unread_count:number;next_cursor:Cursor|null};
async function actor<T>(user:string|null,sql:string,args:unknown[]=[],options:{role?:"authenticated"|"anon"|"service_role";aal?:string;session?:string;metadata?:unknown}={},connection=db){
 await connection.exec("savepoint late_actor");
 try{
  await connection.exec(`set local role ${options.role??"authenticated"}`);
  await connection.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user??"",JSON.stringify({sub:user,session_id:options.session??user,aal:options.aal??([id.adminA,id.adminB,principal].includes(user??"")?"aal2":"aal1"),role:options.role??"authenticated",user_metadata:options.metadata})]);
  const result=await connection.query<{value:T}>(sql,args);await connection.exec("reset role;release savepoint late_actor");
  await connection.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");return result.rows[0]?.value;
 }catch(error){await connection.exec("rollback to savepoint late_actor;release savepoint late_actor");throw error}
}
const denied=(value:Promise<unknown>,code="42501")=>expect(value).rejects.toMatchObject({code});
async function rejectedTrusted(sql:string){
 await db.exec("savepoint late_trusted_test");
 try{await denied(db.query(sql))}finally{await db.exec("rollback to savepoint late_trusted_test;release savepoint late_trusted_test")}
}
const settings=(user=id.adminA,school=id.schoolA,options={})=>actor<Policy>(user,"select public.get_school_late_alert_settings($1)as value",[school],options);
const policy=(enabled=true,version=0,request=randomUUID(),user=id.adminA,school=id.schoolA,reason="Approved school Late alert policy")=>actor<Ack>(user,"select public.set_school_late_alert_settings($1,$2,$3,$4,$5)as value",[school,version,enabled,reason,request]);
const inbox=(user=id.guardianA,role="parent",unread=false,limit=30,cursor:Cursor|null=null,api="v3",options={})=>actor<Inbox>(user,
 `select public.get_family_notification_inbox${api?`_${api}`:""}($1,$2,$3,$4,$5,$6)as value`,[role,unread,limit,cursor?.created_at??null,cursor?.kind??null,cursor?.id??null],options);
const unread=(user=id.guardianA,role="parent",api="v3")=>actor<number>(user,`select public.get_family_notification_unread_count${api?`_${api}`:""}($1)::int as value`,[role]);
const mark=(item:Item,user=id.guardianA,role="parent",api="v3")=>actor<string|null>(user,`select public.mark_family_notification_read${api?`_${api}`:""}($1,$2,$3)::text as value`,[role,item.kind,item.id]);
const markAll=(user=id.guardianA,role="parent",api="v3")=>actor<number>(user,`select public.mark_all_family_notifications_read${api?`_${api}`:""}($1)::int as value`,[role]);
const lateItems=async(user=id.guardianA)=>(await inbox(user)).notifications.filter(row=>row.kind==="late");
const saveMark=(status="late",student=id.pupilA)=>actor<string>(id.adminA,`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
 values($1,$2,$3,$4,$5,$6,$7)on conflict(student_id,attendance_date)do update set status=excluded.status,marked_by=excluded.marked_by returning id::text as value`,[id.schoolA,id.yearA,id.sectionA,student,day,status,id.adminA]);
const preservedTables=["public.student_fees","public.fee_payments","public.student_parents","app_private.guardian_absence_alerts","app_private.family_notifications","app_private.gate_guardian_preferences","app_private.gate_guardian_notifications","app_private.family_push_jobs","app_private.family_push_preferences","app_private.family_push_devices"];
const snapshot=async(tables=preservedTables,connection=db)=>Promise.all(tables.map(async table=>(await connection.query(`select to_jsonb(row)as row from ${table} row order by to_jsonb(row)::text collate "C"`)).rows));
async function expireAfterActor(name="gate_office_actor",args="uuid"){
 const definition=(await db.query<{source:string}>(`select pg_get_functiondef('app_private.${name}(${args})'::regprocedure)as source`)).rows[0].source;
 expect(definition.match(/return actor;/g)).toHaveLength(1);
 await db.exec(definition.replace("return actor;","update auth.sessions set not_after=clock_timestamp()-interval '1 second'where id=(auth.jwt()->>'session_id')::uuid;return actor;"));
}
beforeAll(async()=>{
 db=await createRecoveryDatabase();await seedRecoveryData(db);
 for(const[user,role]of[[principal,"principal"],[finance,"accountant"],[peer,"parent"],[replacement,"parent"]]){
  await db.query("insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",[user,`${user}@late-alerts.invalid`]);
  await db.query("update public.profiles set school_id=$1 where id=$2",[id.schoolA,user]);
  await db.query("insert into public.user_roles(user_id,school_id,role)values($1,$2,$3)",[user,id.schoolA,role]);
 }
 await db.query("insert into public.parents(id,school_id,profile_id)values($1,$2,$3)",[peerParent,id.schoolA,peer]);
 await db.query("insert into public.student_parents(student_id,parent_id,relationship)values($1,$2,'guardian')",[id.pupilA,peerParent]);
 await db.exec("insert into auth.sessions(id,user_id,aal)select id,id,'aal1'from auth.users");
 for(const user of[id.adminA,id.adminB,principal]){
  const factor=randomUUID();await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status)values($1,$2,'totp','verified')",[factor,user]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2",[factor,user]);
 }
 day=(await db.query<{day:string}>("select(clock_timestamp()at time zone 'Asia/Kolkata')::date::text as day")).rows[0].day;
 await db.query("update public.academic_years set start_date=$1::date-30,end_date=$1::date+30",[day]);
},60_000);
beforeEach(async()=>{await db.exec("begin")});afterEach(async()=>{await db.exec("rollback")});afterAll(async()=>{await db?.close()});

describe("school-controlled Late policy",()=>{
 it("starts implicit OFF with no seed, history row, attendance rewrite or recipient preference change",async()=>{
  const before=await snapshot();expect(await settings()).toEqual({user_id:id.adminA,school_id:id.schoolA,enabled:false,version:0,history:[]});
  await saveMark();expect(await lateItems()).toEqual([]);expect(await snapshot()).toEqual(before);
  expect((await db.query<{count:number}>("select count(*)::int as count from app_private.school_late_alert_policy_versions")).rows).toEqual([{count:0}]);
 });
 it("allows only native Admin/Principal, records reasons and preserves exact old retries without reactivating policy",async()=>{
  const request=randomUUID();const first=await policy(true,0,request);expect(first).toEqual({user_id:id.adminA,school_id:id.schoolA,enabled:true,version:1,request_id:request,replayed:false});
  const off=await policy(false,1,randomUUID(),principal);expect(off).toMatchObject({enabled:false,version:2,user_id:principal});
  expect(await policy(true,0,request)).toEqual({...first,replayed:true});expect(await settings()).toMatchObject({enabled:false,version:2});
  expect((await settings()).history).toMatchObject([{version:2,enabled:false,actor_id:principal},{version:1,enabled:true,actor_id:id.adminA}]);
  await denied(policy(false,0,request),"PT409");await denied(policy(true,0,randomUUID()),"PT409");await denied(policy(true,0,request,principal),"PT409");
 });
 it("names each policy actor from the same school and never only a UUID",async()=>{
  await db.query("update public.profiles set full_name='Priya Principal' where id=$1",[principal]);
  await policy(true,0);await policy(false,1,randomUUID(),principal);
  expect((await settings(principal)).history).toMatchObject([{actor_id:principal,actor_name:"Priya Principal"},{actor_id:id.adminA,actor_name:"Synthetic admin-a"}]);
  await db.query("update public.profiles set school_id=$1 where id=$2",[id.schoolB,id.adminA]);
  expect((await settings(principal)).history[1]).toMatchObject({actor_id:id.adminA,actor_name:null});
 });
 it("bounds immutable history at20 without losing the latest version",async()=>{
  for(let n=0;n<23;n++)await policy(n%2===0,n);
  const result=await settings();expect(result.version).toBe(23);expect(result.history).toHaveLength(20);expect(result.history.map(row=>row.version)).toEqual(Array.from({length:20},(_,n)=>23-n));
  await rejectedTrusted("update app_private.school_late_alert_policy_versions set enabled=false");await rejectedTrusted("delete from app_private.school_late_alert_policy_versions");
 });
 it.each([id.teacherA,id.guardianA,id.studentUserA,finance,id.adminB])("denies low/foreign role%s without accepting metadata authority",async user=>{
  await denied(settings(user));await denied(policy(true,0,randomUUID(),user));
 });
 it("denies stale sessions, forged AAL, removed actual roles and inactive school/profile",async()=>{
  await denied(settings(id.adminA,id.schoolA,{session:randomUUID()}));await denied(settings(id.adminA,id.schoolA,{aal:"aal1"}));
  await denied(settings(id.teacherA,id.schoolA,{aal:"aal2",metadata:{role:"school_admin"}}));
  await db.query("delete from public.user_roles where user_id=$1",[id.adminA]);await db.query("insert into public.user_roles(user_id,school_id,role)values($1,null,'super_admin')",[id.adminA]);await denied(settings());
  await db.query("update public.schools set is_active=false where id=$1",[id.schoolA]);await denied(settings(principal));
 });
 it("denies a genuinely native-AAL2 Teacher despite forged office metadata",async()=>{
  const factor=randomUUID();await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status)values($1,$2,'totp','verified')",[factor,id.teacherA]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2",[factor,id.teacherA]);
  await denied(settings(id.teacherA,id.schoolA,{aal:"aal2",metadata:{role:"school_admin"}}));
  await denied(actor(id.teacherA,"select public.set_school_late_alert_settings($1,0,true,'Spoofed policy request',$2)as value",[id.schoolA,randomUUID()],{aal:"aal2"}));
 });
 it.each([[null,true,"Valid reason"],[0,null,"Valid reason"],[-1,true,"Valid reason"],[9007199254740991,true,"Valid reason"],[0,true,"no"],[0,true,"x".repeat(301)],[0,true,"Bad\nreason"],[0,true,"Bad\u202ereason"]]as const)("validates policy input %s/%s/%s",async(version,enabled,reason)=>{
  await denied(actor(id.adminA,"select public.set_school_late_alert_settings($1,$2,$3,$4,$5)as value",[id.schoolA,version,enabled,reason,randomUUID()]),"22023");
 });
 it("rechecks native authority after waits and before returning policy reads",async()=>{
  await expireAfterActor();await denied(settings());await denied(policy());expect((await db.query<{count:number}>("select count(*)::int as count from app_private.school_late_alert_policy_versions")).rows[0].count).toBe(0);
 });
 it("rolls back policy append when native authority expires at the mutation boundary",async()=>{
  await db.exec(`create function app_private.expire_late_test_actor()returns trigger language plpgsql security definer set search_path=''as $$begin
   update auth.sessions set not_after=clock_timestamp()-interval '1 second'where id=(auth.jwt()->>'session_id')::uuid;return new;end;$$;
   create trigger expire_late_test_actor before insert on app_private.school_late_alert_policy_versions for each row execute function app_private.expire_late_test_actor()`);
  await denied(policy());expect(await settings()).toMatchObject({version:0,enabled:false,history:[]});
 });
});

describe("canonical Late creation, corrections and current guardian scope",()=>{
 it("creates exactly one current-day canonical alert per linked guardian while gate choices stayOFF",async()=>{
  await policy();const markId=await saveMark();await saveMark();
  await db.query("update public.attendance set remarks='Unchanged Late remarks'where id=$1",[markId]);
  const alerts=await lateItems();expect(alerts).toHaveLength(1);expect(alerts[0]).toMatchObject({kind:"late",status:"late",source_id:markId,student_id:id.pupilA,event_date:day,read_at:null,assessment_id:null,occurred_at:null,delayed:false});
  expect((await lateItems(peer))).toHaveLength(1);expect((await lateItems(peer))[0].id).not.toBe(alerts[0].id);
  expect((await inbox()).user_id).toBe(id.guardianA);expect((await inbox()).role).toBe("parent");
  expect((await db.query<{arrival_enabled:boolean;exit_enabled:boolean}>("select arrival_enabled,exit_enabled from app_private.gate_guardian_preferences")).rows.every(row=>row.arrival_enabled===false&&row.exit_enabled===false)).toBe(true);
 });
 it("does not backfill marks on enable, existingLate/remark saves or new relationship creation",async()=>{
  await saveMark();await policy();await saveMark();
  await db.query("insert into public.student_parents(student_id,parent_id,relationship)values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
  await db.query("update public.attendance set remarks='Historical Late stays historical'where id=$1",[id.attendanceUnlinkedA]);
  expect(await lateItems()).toEqual([]);expect(await lateItems(peer)).toEqual([]);
 });
 it("school disable prevents new creation and retains existing alerts and their read state",async()=>{
  await policy();await saveMark();const first=(await lateItems())[0],readAt=await mark(first);
  await policy(false,1);expect((await lateItems())[0].id).toBe(first.id);expect(Date.parse((await lateItems())[0].read_at!)).toBe(Date.parse(readAt!));
  await db.query("insert into public.student_parents(student_id,parent_id,relationship)values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
  await saveMark("late",id.unlinkedPupilA);expect((await lateItems())).toHaveLength(1);
 });
 it("retains ID/read across Late correction and same-link restoration without duplicates",async()=>{
  await policy();const markId=await saveMark(),first=(await lateItems())[0],readAt=await mark(first);
  await saveMark("present");expect(await lateItems()).toEqual([]);expect(await mark(first)).toBeNull();
  expect((await db.query("select id,read_at from app_private.guardian_late_alerts where attendance_id=$1 and recipient_user_id=$2",[markId,id.guardianA])).rows[0]).toMatchObject({id:first.id});
  await saveMark();expect((await lateItems())[0].id).toBe(first.id);expect(Date.parse((await lateItems())[0].read_at!)).toBe(Date.parse(readAt!));
  expect((await db.query<{count:number}>("select count(*)::int as count from app_private.guardian_late_alerts")).rows[0].count).toBe(2);
 });
 it("never creates historical/future alerts or alerts from rejected/held gate receipts",async()=>{
  await policy();await db.query("update public.attendance set status='late'where id=$1",[id.attendanceA]);
  await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status)values($1,$2,$3,$4,$5::date+1,'late')",[id.schoolA,id.yearA,id.sectionA,id.pupilA,day]);
  const device=randomUUID(),secret=randomBytes(32).toString("base64url");await actor(id.adminA,"select public.create_gate_device($1,$2,'Late QA gate',$3,'00:00',array[0,1,2,3,4,5,6])as value",[id.schoolA,device,secret]);
  await actor(null,"select public.ingest_gate_attendance_event($1,$2,'held-late','unknown','IN',clock_timestamp())as value",[device,secret],{role:"service_role"});
  expect(await lateItems()).toEqual([]);
 });
 it("gate-owned current Late uses the canonical source once and OUT leaves it intact",async()=>{
  await policy();const device=randomUUID(),secret=randomBytes(32).toString("base64url");
  await actor(id.adminA,"select public.create_gate_device($1,$2,'Late QA gate',$3,'00:00',array[0,1,2,3,4,5,6])as value",[id.schoolA,device,secret]);
  await actor(id.adminA,"select public.map_gate_student($1,$2,'late-card',$3)as value",[device,randomUUID(),id.pupilA]);
  for(const[event,direction]of[["late-in","IN"],["late-repeat","IN"],["late-out","OUT"]])await actor(null,"select public.ingest_gate_attendance_event($1,$2,$3,'late-card',$4,clock_timestamp()-interval '1 minute')as value",[device,secret,event,direction],{role:"service_role"});
  expect((await lateItems())).toHaveLength(1);expect((await lateItems(peer))).toHaveLength(1);
 });
 it("removal deletes only that relationship'sLate receipts and re-link never revives the old alert",async()=>{
  await policy();await saveMark();const old=(await lateItems())[0],other=(await lateItems(peer))[0];
  await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2",[id.pupilA,id.parentA]);
  expect(await lateItems()).toEqual([]);expect((await lateItems(peer))[0].id).toBe(other.id);expect(await mark(old)).toBeNull();
  await db.query("insert into public.student_parents(student_id,parent_id,relationship)values($1,$2,'guardian')",[id.pupilA,id.parentA]);await saveMark();expect(await lateItems()).toEqual([]);
  await saveMark("present");await saveMark();expect((await lateItems())[0].id).not.toBe(old.id);
 });
 it.each(["permission","inactive-profile","banned","unverified","removed-role"])("rechecks recipient entitlement for creation: %s",async state=>{
  await policy();
  if(state==="permission")await db.query("delete from public.role_permissions where role='parent'and permission_id=(select id from public.permissions where code='attendance.view')");
  if(state==="inactive-profile")await db.query("update public.profiles set is_active=false where id=$1",[id.guardianA]);
  if(state==="banned")await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour'where id=$1",[id.guardianA]);
  if(state==="unverified")await db.query("update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1",[id.guardianA]);
  if(state==="removed-role")await db.query("delete from public.user_roles where user_id=$1 and role='parent'",[id.guardianA]);
  await saveMark();expect((await db.query<{count:number}>("select count(*)::int as count from app_private.guardian_late_alerts where recipient_user_id=$1",[id.guardianA])).rows[0].count).toBe(0);
 });
 it("preserves governed recovery history for the new owner without exposing it to the old login",async()=>{
  await policy();await saveMark();const first=(await lateItems())[0],request=randomUUID();
  await db.query("insert into app_private.guardian_recovery_cases(id,school_id,parent_id,old_user_id,new_user_id,channel,contact,requires_mfa,snapshot_hash,snapshot,requester_id,expires_at,status,reviewer_id,token_hash)values($1,$2,$3,$4,$5,'email','replacement@late.invalid',false,'test','{}',$6,clock_timestamp()+interval '1 hour','accepted',$7,sha256(convert_to('local-test-token','UTF8')))",[request,id.schoolA,id.parentA,id.guardianA,replacement,id.adminA,principal]);
  await db.query("insert into app_private.guardian_recovery_recipient_history(parent_id,school_id,previous_user_id,through_at,case_id)values($1,$2,$3,clock_timestamp(),$4)",[id.parentA,id.schoolA,id.guardianA,request]);
  await db.query("update public.parents set profile_id=$1 where id=$2",[replacement,id.parentA]);
  expect(await lateItems()).toEqual([]);expect((await lateItems(replacement))[0].id).toBe(first.id);
  const readAt=await mark(first,replacement);expect(readAt).not.toBeNull();expect(Date.parse((await lateItems(replacement))[0].read_at!)).toBe(Date.parse(readAt!));expect(await mark(first)).toBeNull();
 });
});

describe("v3 versioned inbox/read semantics and closed delivery boundary",()=>{
 it("preserves exact v1/v2 shapes/counts/read behavior and keeps unseen Late unread",async()=>{
  await policy();const prior1=await inbox(id.guardianA,"parent",false,30,null,""),prior2=await inbox(id.guardianA,"parent",false,30,null,"v2");await saveMark();
  expect(await inbox(id.guardianA,"parent",false,30,null,"")).toEqual(prior1);expect(await inbox(id.guardianA,"parent",false,30,null,"v2")).toEqual(prior2);
  expect(await unread(id.guardianA,"parent","")).toBe(1);expect(await unread(id.guardianA,"parent","v2")).toBe(1);expect(await unread()).toBe(2);
  expect(await markAll(id.guardianA,"parent","v2")).toBe(1);expect((await lateItems())[0].read_at).toBeNull();
  await denied(mark((await lateItems())[0],id.guardianA,"parent","v2"),"22023");
 });
 it("keeps per-recipient reads idempotent and Student/foreign accounts cannot touch Late",async()=>{
  await policy();await saveMark();const first=(await lateItems())[0],readAt=await mark(first);expect(await mark(first)).toBe(readAt);expect((await lateItems(peer))[0].read_at).toBeNull();
  expect(await mark(first,peer)).toBeNull();expect(await mark(first,id.studentUserA,"student")).toBeNull();expect((await inbox(id.studentUserA,"student")).notifications).toEqual([]);
  expect((await inbox(id.studentUserB,"student")).notifications).toEqual([]);await denied(inbox(id.teacherA));
 });
 it("paginates all sources with deterministic keyset cursors and bulk marks beyond the displayed page",async()=>{
  await policy();await db.query("insert into public.students(school_id,admission_no,first_name,dob,registered_mobile)select $1,'LATE-PAGE-'||n,'Late page '||n,'2014-01-01','0000000000'from generate_series(1,31)n",[id.schoolA]);
  await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id)select id,$1,$2,$3 from public.students where admission_no like'LATE-PAGE-%'",[id.yearA,id.classA,id.sectionA]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship)select id,$1,'guardian'from public.students where admission_no like'LATE-PAGE-%'",[id.parentA]);
  await actor(id.adminA,"insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)select $1,$2,$3,id,$4,'late',$5 from public.students where admission_no like'LATE-PAGE-%'returning id as value",[id.schoolA,id.yearA,id.sectionA,day,id.adminA]);
  const first=await inbox(id.guardianA,"parent",false,30),second=await inbox(id.guardianA,"parent",false,30,first.next_cursor);expect(first.notifications).toHaveLength(30);expect(second.notifications).toHaveLength(2);expect(second.next_cursor).toBeNull();
  expect(new Set([...first.notifications,...second.notifications].map(row=>row.id)).size).toBe(32);expect(await markAll()).toBe(32);expect(await unread()).toBe(0);expect((await inbox(id.guardianA,"parent",true)).notifications).toEqual([]);expect(await markAll()).toBe(0);
 });
 it.each([[null,30,null,null,null],[false,0,null,null,null],[false,51,null,null,null],[false,30,null,"late",null],[false,30,"infinity","late",null],[false,30,"2026-11-07T00:00:00Z","unknown",randomUUID()]]as const)("rejects invalid v3 page input%s/%s",async(unreadOnly,limit,before,kind,key)=>{
  await denied(actor(id.guardianA,"select public.get_family_notification_inbox_v3('parent',$1,$2,$3,$4,$5)as value",[unreadOnly,limit,before,kind,key]),"22023");
 });
 it("requires native family session/MFA and rechecks after returning source data",async()=>{
  await denied(inbox(id.guardianA,"parent",false,30,null,"v3",{session:randomUUID()}));
  await expireAfterActor("gate_notification_actor","text");await denied(inbox());await denied(unread());await denied(markAll());
 });
 it("never creates push jobs or changes provider/device preferences when Late is created or corrected",async()=>{
  const tables=["app_private.family_push_jobs","app_private.family_push_preferences","app_private.family_push_devices","app_private.gate_guardian_preferences"];
  const before=await snapshot(tables);await policy();await saveMark();await saveMark("present");await saveMark();expect(await snapshot(tables)).toEqual(before);
 });
 it("keeps raw tables and unchecked helpers denied and new public wrappers invoker-only",async()=>{
  for(const role of["anon","authenticated","service_role"]as const)for(const table of["school_late_alert_policy_versions","guardian_late_alerts"])await denied(actor(id.guardianA,`select to_jsonb(row)as value from app_private.${table} row`,[],{role}));
  await denied(actor(id.guardianA,"select * from app_private.eligible_guardian_late_alerts()"));
  for(const role of["anon","service_role"]as const)await denied(actor(null,"select public.get_family_notification_inbox_v3('parent')as value",[],{role}));
  const wrappers=(await db.query<{proname:string;prosecdef:boolean;browser:boolean;anonymous:boolean;server:boolean}>("select p.proname,p.prosecdef,has_function_privilege('authenticated',p.oid,'EXECUTE')as browser,has_function_privilege('anon',p.oid,'EXECUTE')as anonymous,has_function_privilege('service_role',p.oid,'EXECUTE')as server from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in('get_school_late_alert_settings','set_school_late_alert_settings','get_family_notification_inbox_v3','get_family_notification_unread_count_v3','mark_family_notification_read_v3','mark_all_family_notifications_read_v3')")).rows;
  expect(wrappers).toHaveLength(6);expect(wrappers.every(row=>row.prosecdef===false&&row.browser===true&&row.anonymous===false&&row.server===false)).toBe(true);
 });
 it("replays additively without backfill, modifying old routine definitions or historical rows",async()=>{
  const prior=await createRecoveryDatabase({applyPending:false});try{
   const sources=await readRecoverySources(await readRecoveryManifest()),upgrade=sources.find(source=>source.version==="20261107164255")!;
   for(const source of sources.slice(0,sources.indexOf(upgrade)).filter(source=>source.kind==="pending"))await prior.exec(source.sql);
   await seedRecoveryData(prior);const before=await snapshot([...preservedTables,"public.attendance"],prior);
   const routines=()=>prior.query<{oid:number;nspname:string;proname:string;prosrc:string;prosecdef:boolean;provolatile:string;proconfig:string[]|null;proacl:string|null}>("select n.nspname,p.proname,p.oid,p.prosrc,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app_private')order by p.oid");
   const original=(await routines()).rows;await prior.exec(upgrade.sql);
   expect(await snapshot([...preservedTables,"public.attendance"],prior)).toEqual(before);const after=(await routines()).rows;
   expect(after.filter(row=>original.some(old=>old.oid===row.oid))).toEqual(original);
   expect((await prior.query("select(select count(*)from app_private.school_late_alert_policy_versions)::int as policies,(select count(*)from app_private.guardian_late_alerts)::int as alerts")).rows).toEqual([{policies:0,alerts:0}]);
  }finally{await prior.close()}
 },30_000);
});
