// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal=randomUUID(),accountant=randomUUID(),reception=randomUUID(),globalAdmin=randomUUID();
const staff=[id.adminA,id.teacherA,principal,accountant,reception];
type Status={user_id:string;profile_school_id:string|null;roles:{role:string;school_id:string|null}[];required:boolean;allowed:boolean;action:string;current_aal:string;verified_totp_count:number;staff:boolean;policy_required:boolean};
type Policy={school_id:string;required:boolean;revision:number;can_manage:boolean;staff_count:number;enrolled_staff_count:number;enrollment_required_count:number;history:unknown[]};
async function actor<T extends Record<string,unknown>=Record<string,unknown>>(user:string|null,sql:string,args:unknown[]=[],options:{aal?:unknown;session?:string|null;path?:string;http?:boolean;role?:"authenticated"|"anon"|"service_role"}={}){
  await db.exec("savepoint mfa_actor");
  try{
    await db.exec(`set local role ${options.role??"authenticated"}`);
    await db.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),
      set_config('request.path',$3,true),set_config('request.method','POST',true)`,[user??"",JSON.stringify({sub:user,session_id:options.session===undefined?user:options.session,aal:options.aal}),options.path??"/rpc/example"]);
    if(options.http)await db.query("select public.check_staff_mfa_request()");
    const result=await db.query<T>(sql,args);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true),set_config('request.path','',true)");
    await db.exec("release savepoint mfa_actor");return result.rows;
  }catch(error){await db.exec("rollback to savepoint mfa_actor; release savepoint mfa_actor");throw error;}
}
const value=async<T>(user:string,sql:string,args:unknown[]=[],options:Parameters<typeof actor>[3]={})=>(await actor<{value:T}>(user,sql,args,options))[0].value;
const status=(user:string,options:Parameters<typeof actor>[3]={})=>value<Status>(user,"select public.get_my_staff_mfa_status() as value",[],{http:true,path:"/rpc/get_my_staff_mfa_status",...options});
const load=(user=id.adminA,aal?:string)=>value<Policy>(user,"select public.get_school_staff_mfa_policy($1) as value",[id.schoolA],{aal,http:true});
const save=(required:boolean,revision=0,request=randomUUID(),reason="Reviewed staff readiness",user=id.adminA,aal="aal2")=>
  value<{revision:number;required:boolean;changed:boolean;replayed:boolean}>(user,"select public.save_school_staff_mfa_policy($1,$2,$3,$4,$5) as value",[id.schoolA,revision,required,request,reason],{aal,http:true});
async function enroll(user:string,{elevate=true,verified=true,type="totp"}:{elevate?:boolean;verified?:boolean;type?:string}={}){
  const factor=randomUUID();await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,$3,$4)",[factor,user,type,verified?"verified":"unverified"]);
  if(elevate)await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1",[user,factor]);return factor;
}
const deny=(promise:Promise<unknown>,code="42501")=>expect(promise).rejects.toMatchObject({code});
async function enable(){for(const user of staff)await enroll(user);return save(true);}
beforeAll(async()=>{
  db=await createRecoveryDatabase();await seedRecoveryData(db);
  const emailOtpMigration = new URL("../../supabase/migrations/20261109112234_admin_email_otp_eligibility.sql", import.meta.url);
  await db.exec(await readFile(emailOtpMigration, "utf8"));
  for(const[user,role]of[[principal,"principal"],[accountant,"accountant"],[reception,"reception_staff"],[globalAdmin,"super_admin"]]){
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",[user,`${user}@mfa.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1",[user,role==="super_admin"?null:id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)",[user,role==="super_admin"?null:id.schoolA,role]);
  }
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
},60_000);
beforeEach(async()=>{await db.exec("begin");});afterEach(async()=>{await db.exec("rollback");});afterAll(async()=>{await db?.close();});

describe("admin email OTP eligibility", () => {
  const email = "admin-a@recovery.invalid";
  const lookup = (address: string) => value<string | null>(
    id.adminA, "select public.find_admin_email_otp_user($1) as value", [address], { role: "service_role", http: true },
  );

  it("only lets the server resolve a confirmed, active, same-school admin with verified TOTP", async () => {
    await enroll(id.adminA, { verified: false });
    expect(await lookup(email)).toBeNull();
    const factor = await enroll(id.adminA);
    expect(await lookup(`  ${email.toUpperCase()}  `)).toBe(id.adminA);
    await enroll(id.teacherA);
    expect(await lookup("teacher-a@recovery.invalid")).toBeNull();
    expect(await lookup("unknown@recovery.invalid")).toBeNull();
    for (const role of ["anon", "authenticated"] as const) {
      await deny(value(id.adminA, "select public.find_admin_email_otp_user($1) as value", [email], { role, aal: "aal2" }));
    }
    await db.query("delete from auth.mfa_factors where id=$1", [factor]);
    expect(await lookup(email)).toBeNull();
  });

  it.each([
    ["unconfirmed email", "update auth.users set email_confirmed_at=null, phone_confirmed_at=now() where id=$1", id.adminA],
    ["banned identity", "update auth.users set banned_until=now() + interval '1 day' where id=$1", id.adminA],
    ["deleted identity", "update auth.users set deleted_at=now() where id=$1", id.adminA],
    ["inactive profile", "update public.profiles set is_active=false where id=$1", id.adminA],
    ["inactive school", "update public.schools set is_active=false where id=$1", id.schoolA],
    ["mismatched school", "update public.profiles set school_id=(select id from public.schools where code='RECOVERY-B') where id=$1", id.adminA],
    ["ambiguous email", "update auth.users set email='ADMIN-A@recovery.invalid' where id=$1", id.claimantA],
  ])("rejects %s", async (_case, sql, target) => {
    await enroll(id.adminA);
    expect(await lookup(email)).toBe(id.adminA);
    await db.query(sql, [target]);
    expect(await lookup(email)).toBeNull();
  });

  it("keeps an admin OTP session gated through verification and factor removal", async () => {
    await db.query("insert into auth.mfa_amr_claims values($1,'otp',now())", [id.adminA]);
    expect(await status(id.adminA)).toMatchObject({ required: true, allowed: false, action: "sign_in" });
    const factor = await enroll(id.adminA);
    await db.query("insert into auth.mfa_amr_claims values($1,'totp',now() + interval '1 second')", [id.adminA]);
    expect(await status(id.adminA)).toMatchObject({ required: true, allowed: false, action: "challenge" });
    expect(await actor(id.adminA, "select id from public.students")).toEqual([]);
    expect(await status(id.adminA, { aal: "aal2" })).toMatchObject({ allowed: true, action: "none" });
    expect(await actor(id.adminA, "select id from public.students", [], { aal: "aal2" })).toHaveLength(2);
    await db.query("delete from auth.mfa_factors where id=$1", [factor]);
    expect(await status(id.adminA)).toMatchObject({ required: true, allowed: false, action: "sign_in" });
    expect(await actor(id.adminA, "select id from public.students")).toEqual([]);
  });

  it.each([
    [id.adminA, "password"],
    [id.adminA, "oauth"],
    [id.adminA, "recovery"],
    [id.guardianA, "otp"],
  ])("preserves optional MFA for %s signing in with %s", async (user, method) => {
    await db.query("insert into auth.mfa_amr_claims values($1,$2,now())", [user, method]);
    expect(await status(user)).toMatchObject({ required: false, allowed: true, action: "none" });
  });
});

describe("native TOTP account authority and safe enrollment bootstrap",()=>{
  it("defaults policy OFF, preserves ordinary AAL1 and includes every actual staff role",async()=>{
    expect(await load()).toMatchObject({required:false,revision:0,can_manage:true,staff_count:5,enrolled_staff_count:0,enrollment_required_count:5,history:[]});
    for(const user of staff)expect(await status(user)).toMatchObject({required:false,allowed:true,staff:true,action:"none",current_aal:"aal1"});
    expect(await actor(id.adminA,"select id from public.students")).toHaveLength(2);
  });
  it.each([undefined,"aal1","invalid","aal3",null,7])("treats unknown/missing JWT AAL %s as AAL1",async(aal)=>{
    await enroll(id.adminA);
    expect(await status(id.adminA,{aal})).toMatchObject({required:true,allowed:false,current_aal:"aal1",action:"challenge"});
    expect(await actor(id.adminA,"select id from public.students",[],{aal})).toEqual([]);
    await deny(load());
  });
  it("requires native AAL2 for an optional verified guardian factor and retains linked-child boundaries",async()=>{
    await enroll(id.guardianA);
    expect(await status(id.guardianA)).toMatchObject({required:true,staff:false,policy_required:false,allowed:false,action:"challenge"});
    expect(await actor(id.guardianA,"select id from public.attendance")).toEqual([]);
    expect(await actor(id.guardianA,"select id from public.attendance",[],{aal:"aal2"})).toEqual([{id:id.attendanceA}]);
  });
  it("ignores unverified and non-TOTP factors for optional enrollment",async()=>{
    await enroll(id.guardianA,{elevate:false,verified:false});await enroll(id.studentUserA,{elevate:false,type:"phone"});
    expect(await status(id.guardianA)).toMatchObject({required:false,verified_totp_count:0,allowed:true});
    expect(await status(id.studentUserA)).toMatchObject({required:false,verified_totp_count:0,allowed:true});
  });
  it("requires a true global administrator to enroll even while every school policy is OFF",async()=>{
    expect(await status(globalAdmin)).toMatchObject({required:true,allowed:false,action:"enroll",staff:true,policy_required:false,profile_school_id:null});
    expect(await actor(globalAdmin,"select id from public.students")).toEqual([]);
    await enroll(globalAdmin);expect(await status(globalAdmin,{aal:"aal2"})).toMatchObject({allowed:true,action:"none"});
    expect(await actor(globalAdmin,"select id from public.students",[],{aal:"aal2"})).toHaveLength(3);
  });
  it("never treats a corrupt school-bound super_admin membership as global authority",async()=>{
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'super_admin')",[id.claimantA,id.schoolA]);
    expect(await status(id.claimantA)).toMatchObject({roles:[],staff:false,required:false,allowed:true});
    await deny(load(id.claimantA));
  });
  it("lets a verified zero-role invited identity inspect only its own enrollment state",async()=>{
    expect(await status(id.claimantA)).toMatchObject({user_id:id.claimantA,profile_school_id:null,roles:[],required:false,staff:false});
    await enroll(id.claimantA,{elevate:false});
    expect(await status(id.claimantA)).toMatchObject({roles:[],required:true,allowed:false,action:"challenge"});
    expect(await actor(id.claimantA,"select id from public.students",[],{aal:"aal2"})).toEqual([]);
    await deny(value(id.claimantA,"select public.get_school_staff_mfa_policy($1) as value",[id.schoolA],{aal:"aal2",http:true}));
  });
  it.each([null,"not-a-uuid",randomUUID(),id.guardianA])("rejects removed/malformed/foreign bootstrap session %s",async(session)=>{
    await deny(status(id.adminA,{session}));
  });
  it.each(["inactive","unverified","anonymous","banned","deleted","expired"])("requires a live verified active identity for bootstrap: %s",async(state)=>{
    if(state==="inactive")await db.query("update public.profiles set is_active=false where id=$1",[id.adminA]);
    else if(state==="expired")await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1",[id.adminA]);
    else await db.query(`update auth.users set ${state==="unverified"?"email_confirmed_at=null,phone_confirmed_at=null":state==="anonymous"?"is_anonymous=true":state==="banned"?"banned_until=now()+interval '1 hour'":"deleted_at=now()"} where id=$1`,[id.adminA]);
    await deny(status(id.adminA));
  });
  it("checks exact native session and exact surviving owned factor, not any verified factor",async()=>{
    const first=await enroll(id.adminA);await enroll(id.adminA,{elevate:false});
    expect(await status(id.adminA,{aal:"aal2"})).toMatchObject({allowed:true,verified_totp_count:2});
    await db.query("delete from auth.mfa_factors where id=$1",[first]);
    expect(await status(id.adminA,{aal:"aal2"})).toMatchObject({required:true,allowed:false,action:"sign_in",verified_totp_count:1});
    await deny(load(id.adminA,"aal2"));
  });
  it("rejects a cached AAL2 JWT after last-factor removal even when requirement becomes false",async()=>{
    await enroll(id.guardianA);await db.query("delete from auth.mfa_factors where user_id=$1",[id.guardianA]);
    await db.query("update auth.sessions set aal='aal1',factor_id=null where id=$1",[id.guardianA]);
    expect(await status(id.guardianA,{aal:"aal2"})).toMatchObject({required:false,allowed:false,action:"sign_in",verified_totp_count:0});
    expect(await actor(id.guardianA,"select id from public.attendance",[],{aal:"aal2"})).toEqual([]);
    expect(await status(id.guardianA,{aal:"aal1"})).toMatchObject({required:false,allowed:true});
  });
  it.each(["native-aal1","foreign-factor","unverified-factor","expired","removed"])("rejects forged or retained AAL2 state %s",async(state)=>{
    const factor=await enroll(id.adminA);
    if(state==="native-aal1")await db.query("update auth.sessions set aal='aal1' where id=$1",[id.adminA]);
    if(state==="foreign-factor"){const foreign=await enroll(id.guardianA);await db.query("update auth.sessions set factor_id=$2 where id=$1",[id.adminA,foreign]);}
    if(state==="unverified-factor")await db.query("update auth.mfa_factors set status='unverified' where id=$1",[factor]);
    if(state==="expired")await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1",[id.adminA]);
    if(state==="removed")await db.query("delete from auth.sessions where id=$1",[id.adminA]);
    expect(await actor(id.adminA,"select id from public.students",[],{aal:"aal2"})).toEqual([]);
    await deny(load(id.adminA,"aal2"));
  });
});

describe("complete HTTP/RLS coverage without an enrollment path bypass",()=>{
  it("covers every public base table and Storage with restrictive SELECT/write predicates",async()=>{
    const rows=await db.query<{tables:number;covered:number}>(`select count(*)::int as tables,count(*) filter(where exists(select 1 from pg_policy policy
      where policy.polrelid=relation.oid and policy.polname='staff_mfa_required' and not policy.polpermissive
      and policy.polcmd='*' and policy.polqual is not null and policy.polwithcheck is not null))::int as covered
      from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
      where(namespace.nspname='public' and relation.relkind in('r','p')) or(namespace.nspname='storage' and relation.relname='objects')`);
    expect(rows.rows).toEqual([{tables:70,covered:70}]);
    expect((await db.query(`select count(*)::int as count from pg_db_role_setting settings join pg_roles role on role.oid=settings.setrole,
      lateral unnest(settings.setconfig) item where role.rolname='authenticator' and item='pgrst.db_pre_request=public.check_staff_mfa_request'`)).rows).toEqual([{count:1}]);
  });
  it.each(["/rpc/current_admin_school_id","/rpc/current_user_has_any_role","/rpc/graphql","/profiles","/user_roles","/students","/rpc/get_my_staff_mfa_status_extra"])("prevents AAL1 HTTP access before legacy SECURITY DEFINER/table/GraphQL route %s",async(path)=>{
    await enroll(id.adminA);await deny(actor(id.adminA,"select public.current_user_has_any_role(array['school_admin']::public.app_role[])",[],{path,http:true}));
  });
  it("status path exception cannot bypass profile/role/table/view/Storage RLS",async()=>{
    await enroll(id.adminA);
    for(const table of["profiles","user_roles","students","student_fee_summary","student_missed_activities","report_card_subject_summary"])
      expect(await actor(id.adminA,`select * from public.${table}`,[],{http:true,path:"/rpc/get_my_staff_mfa_status"})).toEqual([]);
    expect(await actor(id.adminA,"select * from storage.objects",[],{path:"/rpc/get_my_staff_mfa_status"})).toEqual([]);
    await deny(actor(id.adminA,"update public.profiles set full_name='Denied' where id=$1 returning id",[id.adminA],{http:true}));
  });
  it("executes the guard inside read-only GET transactions",async()=>{
    await db.exec("set transaction read only");
    expect(await actor(id.guardianA,"select id from public.attendance",[],{http:true})).toEqual([{id:id.attendanceA}]);
  });
  it("does not widen service operators or expose private policy/factor helpers",async()=>{
    await enroll(id.adminA);
    expect(await actor(id.adminA,"select id from public.students",[],{role:"service_role",http:true})).toHaveLength(3);
    await deny(actor(id.guardianA,"select * from app_private.school_staff_mfa_policy"));
    await deny(actor(id.guardianA,"select app_private.staff_mfa_state()"));
    await deny(actor(id.guardianA,"select app_private.has_verified_staff_totp($1)",[id.adminA]));
    await deny(actor(null,"select public.get_my_staff_mfa_status()",[],{role:"anon",http:true}));
  });
});

describe("governed staff rollout, recovery boundaries and whole-account mixed roles",()=>{
  it("requires a native AAL2 admin for both enabling and disabling, with Principal read-only",async()=>{
    await deny(save(false,0,randomUUID(),"Reviewed policy",id.adminA,"aal1"));
    await enroll(principal);expect(await load(principal,"aal2")).toMatchObject({can_manage:false});
    await deny(save(false,0,randomUUID(),"Principal cannot edit",principal,"aal2"));
    await enroll(id.adminA);expect(await save(false)).toEqual({required:false,revision:0,changed:false,replayed:false});
    await deny(value(id.adminA,"select public.get_school_staff_mfa_policy($1) as value",[id.schoolB],{aal:"aal2",http:true}));
  });
  it("blocks first-factor password-only claims by refusing enablement until every active staff identity is ready",async()=>{
    await enroll(id.adminA);await deny(save(true),"22023");
    expect(await load(id.adminA,"aal2")).toMatchObject({enrolled_staff_count:1,enrollment_required_count:4,revision:0});
    for(const user of staff.filter(user=>user!==id.adminA))await enroll(user);
    await db.query("update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1",[accountant]);
    expect(await load(id.adminA,"aal2")).toMatchObject({staff_count:5,enrolled_staff_count:4,enrollment_required_count:1});
    await deny(save(true),"22023");
  });
  it("deduplicates multiple staff roles and ignores inactive profiles until governed reactivation",async()=>{
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'accountant')",[id.teacherA,id.schoolA]);
    await db.query("update public.profiles set is_active=false where id=$1",[reception]);
    for(const user of staff.filter(user=>user!==reception))await enroll(user);
    expect(await load(id.adminA,"aal2")).toMatchObject({staff_count:4,enrolled_staff_count:4,enrollment_required_count:0});
    expect(await save(true)).toMatchObject({required:true,revision:1});
    await deny(actor(id.adminA,"update public.profiles set is_active=true where id=$1 returning id",[reception],{aal:"aal2",http:true}));
    await enroll(reception,{elevate:false});
    expect(await actor(id.adminA,"update public.profiles set is_active=true where id=$1 returning id",[reception],{aal:"aal2",http:true})).toEqual([{id:reception}]);
  });
  it("makes every required staff role and mixed guardian account challenge while pure families retain scope",async()=>{
    await enable();
    for(const user of staff)expect(await status(user)).toMatchObject({required:true,allowed:false,policy_required:true,action:"challenge"});
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')",[id.guardianA,id.schoolA]);
    expect(await status(id.guardianA)).toMatchObject({required:true,allowed:false,staff:true,policy_required:true,action:"enroll"});
    expect(await actor(id.guardianA,"select id from public.attendance")).toEqual([]);
    expect(await status(id.studentUserA)).toMatchObject({required:false,allowed:true,staff:false});
    expect(await actor(id.studentUserA,"select id from public.attendance")).toEqual([{id:id.attendanceA}]);
    expect(await status(id.adminB)).toMatchObject({required:false,allowed:true,staff:true});
  });
  it("requires enrollment before adding a staff role but preserves family linking in enabled schools",async()=>{
    await enable();
    await deny(actor(id.adminA,"select public.assign_school_role($1,$2,'teacher')",[id.claimantA,id.schoolA],{aal:"aal2",http:true}));
    await actor(id.adminA,"select public.assign_school_role($1,$2,'parent')",[id.claimantA,id.schoolA],{aal:"aal2",http:true});
    await enroll(id.claimantA,{elevate:false});
    await actor(id.adminA,"select public.assign_school_role($1,$2,'teacher')",[id.claimantA,id.schoolA],{aal:"aal2",http:true});
    expect(await status(id.claimantA)).toMatchObject({required:true,allowed:false,action:"challenge",policy_required:true});
  });
  it("retains required policy after factor loss and cannot downgrade through the family's account role",async()=>{
    await enable();await db.query("delete from auth.mfa_factors where user_id=$1",[id.teacherA]);
    await db.query("update auth.sessions set aal='aal1',factor_id=null where id=$1",[id.teacherA]);
    expect(await status(id.teacherA)).toMatchObject({required:true,allowed:false,action:"enroll",policy_required:true});
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')",[id.teacherA,id.schoolB]);
    expect(await status(id.teacherA)).toMatchObject({required:true,allowed:false});
  });
  it("reports permanent conflicts as HTTP409 without retryable serialization SQLSTATEs",async()=>{
    const definition=(await db.query<{definition:string}>("select pg_get_functiondef('app_private.save_school_staff_mfa_policy(uuid,integer,boolean,uuid,text)'::regprocedure) as definition")).rows[0].definition;
    expect(definition.match(/errcode='PT409'/g)).toHaveLength(2);
    expect(definition).not.toContain("errcode='40001'");
  });
  it("enforces exact retries, stale CAS and no-op receipts without duplicate audit or revision",async()=>{
    for(const user of staff)await enroll(user);const request=randomUUID();
    expect(await save(true,0,request)).toEqual({required:true,revision:1,changed:true,replayed:false});
    expect(await save(true,0,request)).toEqual({required:true,revision:1,changed:true,replayed:true});
    await deny(save(false,0,request),"PT409");await deny(save(false,0),"PT409");
    expect(await save(true,1)).toEqual({required:true,revision:1,changed:false,replayed:false});
    expect(await save(false,1)).toEqual({required:false,revision:2,changed:true,replayed:false});
    expect(await load(id.adminA,"aal2")).toMatchObject({revision:2,required:false});
    expect((await db.query("select count(*)::int as count from app_private.school_staff_mfa_audit")).rows).toEqual([{count:2}]);
    expect((await db.query("select count(*)::int as count from app_private.school_staff_mfa_receipts")).rows).toEqual([{count:3}]);
  });
  it("returns only the latest ten own-school audit entries without private reasons or request IDs",async()=>{
    for(const user of staff)await enroll(user);
    for(let revision=0;revision<12;revision++)await save(revision%2===0,revision);
    const policy=await load(id.adminA,"aal2");
    expect(policy.history).toHaveLength(10);
    expect(policy.history.map(row=>(row as {revision:number}).revision)).toEqual([12,11,10,9,8,7,6,5,4,3]);
    for(const row of policy.history)expect(Object.keys(row as object).sort()).toEqual(["actor_name","changed_at","id","required","revision"]);
  });
  it("reauthorizes exact retries after identity revocation instead of leaking the old receipt",async()=>{
    await enroll(id.adminA);const request=randomUUID();await save(false,0,request);
    await db.query("update public.profiles set is_active=false where id=$1",[id.adminA]);
    await deny(save(false,0,request));
    expect((await db.query("select count(*)::int as count from app_private.school_staff_mfa_receipts")).rows).toEqual([{count:1}]);
  });
  it.each(["", "bad", "x".repeat(301),"reason\nwith control"])("rejects invalid reasons %s without a receipt",async(reason)=>{
    await enroll(id.adminA);await deny(save(false,0,randomUUID(),reason),"22023");
    expect((await db.query("select count(*)::int as count from app_private.school_staff_mfa_receipts")).rows).toEqual([{count:0}]);
  });
});
