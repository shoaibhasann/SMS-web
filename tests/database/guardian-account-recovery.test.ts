// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db:PGlite;
const reviewer=randomUUID(), replacementC=randomUUID(), token="a".repeat(64),email="unlinked-claimant-a@recovery.invalid";
type Case={id:string;status:string;version:number;requires_mfa:boolean;token?:string};
async function actor<T=Record<string,unknown>>(user:string,sql:string,args:unknown[]=[],aal=user===id.adminA||user===id.adminB||user===reviewer?"aal2":"aal1"){
 await db.exec("savepoint recovery_actor");
 try{await db.exec("set local role authenticated");await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.path','/rpc/recovery',true)",[user,JSON.stringify({sub:user,session_id:user,aal})]);
  await db.query("select public.check_staff_mfa_request()");const r=await db.query<{value:T}>(sql,args);
  await db.exec("reset role");await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");await db.exec("release savepoint recovery_actor");return r.rows[0]?.value;
 }catch(e){await db.exec("rollback to savepoint recovery_actor;release savepoint recovery_actor");throw e;}
}
const rpc=<T>(user:string,name:string,args:unknown[]=[],aal?:string)=>actor<T>(user,`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) as value`,args,aal);
const request=(contact:string=email,channel:string="email",requestId:string=randomUUID(),parent:string=id.parentA,user:string=id.adminA)=>rpc<Case>(user,"request_guardian_account_recovery",[id.schoolA,parent,channel,contact,"School verified guardian identity",requestId]);
const review=(c:Case,decision:string="approve",who:string=reviewer,version:number=c.version,claimToken:string|null=decision==="approve"?token:null,requestId:string=randomUUID())=>rpc<Case>(who,"review_guardian_account_recovery",[c.id,version,decision,"Independent school identity review",requestId,claimToken]);
const claim=(user:string=id.claimantA,claimToken:string=token,requestId:string=randomUUID(),aal?:string)=>rpc<{school_id:string;parent_id:string;linked_children:number;replayed:boolean}>(user,"accept_guardian_account_recovery",[claimToken,requestId],aal);
const peek=(user=id.claimantA,claimToken=token,aal?:string)=>rpc<{school_name:string;status:string;requires_mfa:boolean;linked_children:number}>(user,"get_my_guardian_recovery_claim",[claimToken],aal);
const deny=(p:Promise<unknown>,code="42501")=>expect(p).rejects.toMatchObject({code});
async function factor(user:string){const f=randomUUID();await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')",[f,user]);await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1",[user,f]);return f;}
async function service<T>(name:string,args:unknown[]){
 await db.exec("savepoint recovery_service;set local role service_role");
 try{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:"service_role"})]);const r=await db.query<{value:T}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(",")}) as value`,args);await db.exec("reset role;release savepoint recovery_service");await db.query("select set_config('request.jwt.claims','{}',true)");return r.rows[0].value;
 }catch(e){await db.exec("rollback to savepoint recovery_service;release savepoint recovery_service");throw e;}
}
beforeAll(async()=>{db=await createRecoveryDatabase();await seedRecoveryData(db);
 for(const[user,label,school,role]of[[reviewer,"Recovery principal",id.schoolA,"principal"],[replacementC,"Replacement C",null,null]] as const){await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)",[user,`${user}@recovery.invalid`,JSON.stringify({full_name:label})]);await db.query("update public.profiles set school_id=$2 where id=$1",[user,school]);if(role)await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)",[user,school,role]);}
 await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");for(const u of[id.adminA,id.adminB,reviewer])await factor(u);
},60_000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db?.close();});

describe("reviewed guardian school-access recovery",()=>{
 it("requires native office AAL2, school membership and an exact admission search",async()=>{
  await deny(rpc(id.adminA,"get_guardian_recovery_workspace",[id.schoolA],"aal1"));
  for(const u of[id.teacherA,id.guardianA,id.claimantA,id.adminB])await deny(rpc(u,"get_guardian_recovery_workspace",[id.schoolA]));
  const empty=await rpc<{guardians:unknown[];cases_limit:number;total_cases:number}>(id.adminA,"get_guardian_recovery_workspace",[id.schoolA]);expect(empty).toMatchObject({guardians:[],cases_limit:50,total_cases:0});
  const found=await rpc<{guardians:{parent_id:string;linked_children:number}[]}>(reviewer,"get_guardian_recovery_workspace",[id.schoolA,"REC-A-001"]);expect(found.guardians).toMatchObject([{parent_id:id.parentA,linked_children:1}]);
 });
 it("requires an independent reviewer and snapshots the existing guardian scope",async()=>{
  const c=await request();expect(c).toMatchObject({status:"pending",version:1,requires_mfa:false});
  await deny(review(c,"approve",id.adminA));const approved=await review(c);expect(approved).toMatchObject({status:"approved",version:2,token});
  expect(await peek()).toMatchObject({status:"approved",linked_children:1,requires_mfa:false});
 });
 it("retains parent, child links, fees and attendance while removing old school access",async()=>{
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
  const before=await db.query("select to_jsonb(t) as row from public.student_parents t where parent_id=$1 order by student_id",[id.parentA]);
  const history=await db.query("select (select md5(jsonb_agg(to_jsonb(a) order by id)::text) from public.attendance a) as attendance,(select md5(jsonb_agg(to_jsonb(f) order by id)::text) from public.fee_payments f) as fees");
  await review(await request());expect(await claim()).toMatchObject({parent_id:id.parentA,school_id:id.schoolA,linked_children:2,replayed:false});
  expect((await db.query("select to_jsonb(t) as row from public.student_parents t where parent_id=$1 order by student_id",[id.parentA])).rows).toEqual(before.rows);
  expect((await db.query("select (select md5(jsonb_agg(to_jsonb(a) order by id)::text) from public.attendance a) as attendance,(select md5(jsonb_agg(to_jsonb(f) order by id)::text) from public.fee_payments f) as fees")).rows).toEqual(history.rows);
  expect((await db.query("select profile_id from public.parents where id=$1",[id.parentA])).rows).toEqual([{profile_id:id.claimantA}]);
  expect((await db.query("select is_active from public.profiles where id=$1",[id.guardianA])).rows).toEqual([{is_active:false}]);
  await deny(rpc(id.guardianA,"get_family_notification_unread_count",["parent"]));
  expect(await actor(id.claimantA,"select count(*)::int as value from public.attendance")).toBe(2);
 });
 it("idempotently accepts an exact uncertain retry and a fresh post-refresh request ID",async()=>{
  await review(await request());const r=randomUUID();await claim(id.claimantA,token,r);
  expect(await claim(id.claimantA,token,r)).toMatchObject({replayed:true});expect(await claim()).toMatchObject({replayed:true});expect(await peek()).toMatchObject({status:"accepted"});
  expect((await db.query<{n:number}>("select count(*)::int as n from app_private.guardian_recovery_recipient_history")).rows[0].n).toBe(1);
  expect((await db.query<{n:number}>("select count(*)::int as n from app_private.guardian_recovery_audit where action='accepted'")).rows[0].n).toBe(1);
 });
 it("never exposes or accepts a link under another verified account",async()=>{
  await review(await request());for(const user of[id.guardianA,id.studentUserA,replacementC]){await deny(peek(user));await deny(claim(user));}
  await deny(peek(id.claimantA,"b".repeat(64)));await deny(peek(id.claimantA,"bad"));
 });
 it("binds an existing destination UID and rejects its replacement after email recycling",async()=>{
  await review(await request());await db.query("update auth.users set email='retired@recovery.invalid' where id=$1",[id.claimantA]);
  await db.query("update auth.users set email=$2 where id=$1",[replacementC,email]);await deny(peek(replacementC));await deny(peek());
 });
 it("supports a genuinely new email without granting access before native confirmation",async()=>{
  const freshEmail="genuinely-new@recovery.invalid";await review(await request(freshEmail));
  const user=randomUUID();await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,null)",[user,freshEmail]);await db.query("insert into auth.sessions(id,user_id,aal) values($1,$1,'aal1')",[user]);
  await deny(peek(user));await db.query("update auth.users set email_confirmed_at=now() where id=$1",[user]);
  expect(await peek(user)).toMatchObject({status:"approved"});expect(await claim(user)).toMatchObject({parent_id:id.parentA});
 });
 it("supports verification progress on an already registered unverified replacement",async()=>{
  await db.query("update auth.users set email_confirmed_at=null where id=$1",[id.claimantA]);const c=await request();await review(c);
  await deny(peek());await db.query("update auth.users set email_confirmed_at=now() where id=$1",[id.claimantA]);expect(await claim()).toMatchObject({parent_id:id.parentA});
 });
 it("preserves opted-in MFA strength and accepts only a currently owned verified native factor",async()=>{
  await factor(id.guardianA);const c=await request();expect(c.requires_mfa).toBe(true);await review(c);
  await deny(claim());await factor(id.claimantA);await deny(claim());expect(await claim(id.claimantA,token,randomUUID(),"aal2")).toMatchObject({parent_id:id.parentA});
 });
 it("requires replacement TOTP even when the old verified factor is a different native type",async()=>{
  await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'phone','verified')",[randomUUID(),id.guardianA]);const c=await request();expect(c.requires_mfa).toBe(true);await review(c);await deny(claim());
 });
 it.each(["role","child","contact","mfa","mfa_verified"])("rejects a changed reviewed old-account snapshot: %s",async(change)=>{
  const pending=randomUUID();if(change==="mfa_verified")await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','unverified')",[pending,id.guardianA]);
  const c=await request();await review(c);
  if(change==="role")await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')",[id.guardianA,id.schoolA]);
  if(change==="child")await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')",[id.unlinkedPupilA,id.parentA]);
  if(change==="contact")await db.query("update public.parents set registered_mobile='+919876543210' where id=$1",[id.parentA]);
  if(change==="mfa")await factor(id.guardianA);
  if(change==="mfa_verified")await db.query("update auth.mfa_factors set status='verified' where id=$1",[pending]);
  await expect(claim()).rejects.toMatchObject({code:change==="role"?"42501":"PT409"});
  expect((await db.query<{profile_id:string}>("select profile_id from public.parents where id=$1",[id.parentA])).rows[0].profile_id).toBe(id.guardianA);
 });
 it.each([id.adminA,id.teacherA,id.studentUserA,id.guardianA])("rejects assigned/mixed replacement %s",async(user)=>{
  const email=(await db.query<{email:string}>("select email from auth.users where id=$1",[user])).rows[0].email;await deny(request(email));
 });
 it("rejects mixed-role, inactive and school-mismatched old guardian records",async()=>{
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')",[id.guardianA,id.schoolA]);await deny(request());
  await db.query("delete from public.user_roles where user_id=$1 and role='teacher'",[id.guardianA]);await db.query("update public.profiles set is_active=false where id=$1",[id.guardianA]);await deny(request());
 });
 it("makes stale review, changed retry input and an already-open recovery explicit HTTP conflicts",async()=>{
  const r=randomUUID(),c=await request(email,"email",r);expect(await request(email,"email",r)).toEqual(c);
  await deny(request("different@recovery.invalid","email",r),"PT409");await deny(request(),"PT409");
  const intent=randomUUID();const a=await review(c,"approve",reviewer,c.version,token,intent);expect(await review(c,"approve",reviewer,c.version,token,intent)).toEqual(a);
  await deny(review(c,"reject",reviewer,c.version,null,intent),"PT409");await deny(review(c),"PT409");
 });
 it("requires current officers at claim, and safely cancels/rejects/expires a link",async()=>{
  const c=await request();const a=await review(c);await db.query("delete from public.user_roles where user_id=$1",[reviewer]);await deny(peek());
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')",[reviewer,id.schoolA]);
  await review(a,"cancel",id.adminA);await deny(peek());
  const c2=await request();await review(c2,"reject");await deny(review(c2),"PT409");
  const c3=await request();await review(c3,"approve",reviewer,c3.version,"c".repeat(64));await db.query("update app_private.guardian_recovery_cases set expires_at=now()-interval '1 second' where id=$1",[c3.id]);await deny(peek(id.claimantA,"c".repeat(64)));
 });
 it("preserves absence inbox IDs/read timestamps and current child restrictions",async()=>{
  const old=await rpc<{notifications:{id:string;read_at:string|null}[]}>(id.guardianA,"get_family_notification_inbox",["parent",false,30,null,null,null]);
  expect(old.notifications).toHaveLength(1);await rpc(id.guardianA,"mark_family_notification_read",["parent","absence",old.notifications[0].id]);
  const read=(await db.query("select id,read_at from app_private.guardian_absence_alerts")).rows;
  await review(await request());await claim();
  const next=await rpc<{notifications:{id:string;read_at:string|null}[]}>(id.claimantA,"get_family_notification_inbox",["parent",false,30,null,null,null]);expect(next.notifications[0].id).toBe(old.notifications[0].id);expect(next.notifications[0].read_at).toBeTruthy();
  expect((await db.query("select id,read_at from app_private.guardian_absence_alerts")).rows).toEqual(read);
  await db.query("delete from public.student_parents where student_id=$1 and parent_id=$2",[id.pupilA,id.parentA]);
  expect(await rpc(id.claimantA,"get_family_notification_unread_count",["parent"])).toBe(0);
 });
 it("retains legacy mark-one and mark-all behavior for bounded historical recipients",async()=>{
  await review(await request());await claim();
  const alerts=await rpc<{rows:unknown[];unread_count:number}>(id.claimantA,"get_guardian_absence_inbox");expect(alerts.unread_count).toBe(1);
  expect(await rpc(id.claimantA,"mark_all_guardian_absence_alerts_read")).toBe(1);expect(await rpc(id.claimantA,"mark_all_guardian_absence_alerts_read")).toBe(0);
 });
 it("carries earlier bounded aliases across repeated recovery to a fresh login",async()=>{
  await review(await request());await claim();const nextEmail=`${replacementC}@recovery.invalid`;
  const c=await request(nextEmail);await review(c,"approve",reviewer,c.version,"b".repeat(64));await claim(replacementC,"b".repeat(64));
  expect((await db.query("select previous_user_id from app_private.guardian_recovery_recipient_history where parent_id=$1",[id.parentA])).rows).toHaveLength(2);
  expect(await rpc(replacementC,"get_family_notification_unread_count",["parent"])).toBe(1);await deny(rpc(id.claimantA,"get_family_notification_unread_count",["parent"]));
 });
 it("preserves old leave decisions and read states without leaking future events addressed to the retired login",async()=>{
  const leave=await rpc<string>(id.guardianA,"submit_student_leave",[id.pupilA,"2026-11-10","2026-11-10","Private family reason",randomUUID()]);await rpc(id.adminA,"review_student_leave",[leave,"approved","School approved reason"]);
  const before=(await db.query("select to_jsonb(n) as row from app_private.family_notifications n order by id")).rows;await review(await request());await claim();
  const inbox=await rpc<{notifications:{id:string;kind:string}[];unread_count:number}>(id.claimantA,"get_family_notification_inbox",["parent"]);expect(inbox.notifications.map(n=>n.kind).sort()).toEqual(["absence","leave_decision"]);
  expect((await db.query("select to_jsonb(n) as row from app_private.family_notifications n order by id")).rows).toEqual(before);
  await db.query("update app_private.family_notifications set created_at=(select through_at+interval '1 second' from app_private.guardian_recovery_recipient_history where parent_id=$1) where recipient_user_id=$2",[id.parentA,id.guardianA]);
  expect(await rpc(id.claimantA,"get_family_notification_unread_count",["parent"])).toBe(1);expect(await rpc(id.claimantA,"mark_all_family_notifications_read",["parent"])).toBe(1);
  expect((await db.query<{read_at:string|null}>("select read_at from app_private.family_notifications where recipient_user_id=$1",[id.guardianA])).rows[0].read_at).toBeNull();
 });
 it("revokes old devices, preferences and queued/leased pushes while retaining native Auth and peer delivery state",async()=>{
  for(const[user,role]of[[id.guardianA,"parent"],[id.studentUserA,"student"]] as const){await rpc(user,"set_my_family_push_preferences",[role,true,true,true,true,0]);await rpc(user,"register_my_family_push_device",[role,randomUUID(),"c".repeat(64),`c${randomUUID().replaceAll("-","").slice(0,21)}`,"android","QA device"]);}
  await db.query("insert into public.attendance(id,school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,'2026-11-04','absent')",[randomUUID(),id.schoolA,id.yearA,id.sectionA,id.pupilA]);
  await db.query("update app_private.family_push_jobs set status='leased',lease_id=$1,lease_until=now()+interval '5 minutes' where user_id=$2",[randomUUID(),id.guardianA]);
  const peer=(await db.query("select to_jsonb(d) as row from app_private.family_push_devices d where user_id=$1",[id.studentUserA])).rows;await review(await request());await claim();
  expect((await db.query<{revoked:boolean;generation:number}>("select revoked_at is not null as revoked,generation from app_private.family_push_devices where user_id=$1",[id.guardianA])).rows).toEqual([{revoked:true,generation:2}]);
  expect((await db.query<{status:string;result_code:string}>("select status,result_code from app_private.family_push_jobs where user_id=$1",[id.guardianA])).rows).toEqual([{status:"cancelled",result_code:"guardian_recovered"}]);
  expect((await db.query("select to_jsonb(d) as row from app_private.family_push_devices d where user_id=$1",[id.studentUserA])).rows).toEqual(peer);
  expect((await db.query<{enabled:boolean}>("select enabled from app_private.family_push_preferences where user_id=$1",[id.guardianA])).rows[0].enabled).toBe(false);
  expect((await db.query<{n:number}>("select count(*)::int n from auth.sessions where user_id=$1",[id.guardianA])).rows[0].n).toBe(1);
 });
 it("admits only a fresh approved coherent recovery contact into the existing SMS budget, without assigning a role",async()=>{
  const phone="+919876543210",native=randomUUID();const reserve=()=>service<{send:boolean;reason?:string}>("reserve_guardian_sms",[native,phone,randomUUID(),200,100,5]);
  expect(await reserve()).toMatchObject({send:false,reason:"ineligible"});const c=await request(phone,"phone");expect(await reserve()).toMatchObject({send:false,reason:"ineligible"});await review(c);
  await service("authorize_guardian_sms_request",[phone,createHash("sha256").update("qa-ip").digest("hex")]);expect(await reserve()).toMatchObject({send:true,school_id:id.schoolA});
  await db.query("insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,null)",[native,phone.slice(1)]);await db.query("insert into auth.sessions(id,user_id,aal) values($1,$1,'aal1')",[native]);
  expect((await db.query<{n:number}>("select count(*)::int n from public.user_roles where user_id=$1",[native])).rows[0].n).toBe(0);await deny(peek(native));
  await db.query("update auth.users set phone_confirmed_at=now() where id=$1",[native]);expect(await peek(native)).toMatchObject({status:"approved"});expect(await claim(native)).toMatchObject({parent_id:id.parentA});
 });
 it("denies unreviewed raw case/history access and guessed helper execution",async()=>{
  for(const table of["guardian_recovery_cases","guardian_recovery_audit","guardian_recovery_receipts","guardian_recovery_recipient_history"]){await deny(actor(id.adminA,`select count(*)::int as value from app_private.${table}`));}
  await deny(actor(id.adminA,"select app_private.guardian_recovery_snapshot($1,$2,$3,'email',$4) as value",[id.schoolA,id.parentA,id.claimantA,email]));
 });
 it("keeps token plaintext out of stored cases, receipts and audit rows",async()=>{
  await review(await request());const stored=await db.query("select (select jsonb_agg(to_jsonb(c)) from app_private.guardian_recovery_cases c)::text as cases,(select jsonb_agg(to_jsonb(r)) from app_private.guardian_recovery_receipts r)::text as receipts");expect(JSON.stringify(stored.rows)).not.toContain(token);
 });
});
