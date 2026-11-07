// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, secret: string, deviceId: string;
const principal=randomUUID(),finance=randomUUID(),reception=randomUUID();
type Device={user_id:string;device_id:string;school_id:string;revoked_at:string|null};
type Mapping={user_id:string;school_id:string;mapping_id:string;device_id:string;subject_id:string;student_id:string;revoked_at:string|null};
type Pupil={student_id:string;student_name:string;admission_no:string};
type Search={user_id:string;school_id:string;query:string;offset:number;page_size:number;total_count:number;pupils:Pupil[]};
type Setup={user_id:string;school_id:string;device_count:number;devices:Device[];mapping_count:number;mappings:Mapping[]};
type Events={user_id:string;school_id:string;device_count:number;total_count:number;events:{receipt_id:string;device_id:string;device_name:string|null;student_name:string|null;admission_no:string|null;reason:string}[]};
async function actor<T>(user:string|null,sql:string,args:unknown[]=[],options:{role?:"authenticated"|"anon"|"service_role";aal?:string;session?:string;metadata?:unknown}={}){
 await db.exec("savepoint gate_office_actor_test");
 try{
  await db.exec(`set local role ${options.role??"authenticated"}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user??"",JSON.stringify({sub:user,session_id:options.session??user,aal:options.aal??"aal2",role:options.role??"authenticated",user_metadata:options.metadata})]);
  const result=await db.query<{value:T}>(sql,args);await db.exec("reset role;release savepoint gate_office_actor_test");
  await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");return result.rows[0]?.value;
 }catch(error){await db.exec("rollback to savepoint gate_office_actor_test;release savepoint gate_office_actor_test");throw error}
}
async function denied(value:Promise<unknown>,code="42501"){await expect(value).rejects.toMatchObject({code})}
const create=(key=deviceId,name="School gate",user=id.adminA,school=id.schoolA)=>actor<Device>(user,"select public.create_gate_device($1,$2,$3,$4,'08:30',array[1,2,3,4,5,6]) as value",[school,key,name,secret]);
const map=(key:string=randomUUID(),subject="card-one",student=id.pupilA,user=id.adminA,device=deviceId)=>actor<Mapping>(user,"select public.map_gate_student($1,$2,$3,$4) as value",[device,key,subject,student]);
const setup=(user=id.adminA,school=id.schoolA,offset=0,options={})=>actor<Setup>(user,"select public.get_gate_setup($1,$2) as value",[school,offset],options);
const events=(user=id.adminA,school=id.schoolA,offset=0,options={})=>actor<Events>(user,"select public.list_gate_events($1,$2) as value",[school,offset],options);
const search=(query:string|null="REC-A",offset:number|null=0,user=id.adminA,school=id.schoolA,options={})=>actor<Search>(user,"select public.search_gate_pupils($1,$2,$3) as value",[school,query,offset],options);
const revokeDevice=(reason="Device retired for replacement",user=id.adminA)=>actor<Device>(user,"select public.revoke_gate_device($1,$2) as value",[deviceId,reason]);
const revokeMapping=(key:string,reason="Card retired for replacement",user=id.adminA)=>actor<Mapping>(user,"select public.revoke_gate_student_mapping($1,$2) as value",[key,reason]);
async function expireAfterInitialActor(){
 const definition=(await db.query<{source:string}>("select pg_get_functiondef('app_private.gate_office_actor(uuid)'::regprocedure) as source")).rows[0].source;
 expect(definition.match(/return actor;/g)).toHaveLength(1);
 await db.exec(definition.replace("return actor;","update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=(auth.jwt()->>'session_id')::uuid; return actor;"));
}
async function expireOnMutation(table:"gate_devices"|"gate_student_mappings",operation:"insert"|"update"){
 await db.exec(`create function app_private.expire_gate_test_actor() returns trigger language plpgsql security definer set search_path='' as $$begin
  update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=(auth.jwt()->>'session_id')::uuid;return new;end;$$;
  create trigger expire_gate_test_actor before ${operation} on app_private.${table} for each row execute function app_private.expire_gate_test_actor()`);
}
const snapshot=async()=>(await db.query(`select(select jsonb_agg(to_jsonb(a)order by id)from public.attendance a)as marks,
 (select jsonb_agg(to_jsonb(f)order by id)from public.student_fees f)as fees,
 (select jsonb_agg(to_jsonb(e)order by id)from app_private.gate_events e)as receipts,
 (select jsonb_agg(to_jsonb(d)order by id)from app_private.gate_devices d)as devices,
 (select jsonb_agg(to_jsonb(m)order by id)from app_private.gate_student_mappings m)as mappings,
 (select jsonb_agg(to_jsonb(l)order by student_id,parent_id)from public.student_parents l)as links`)).rows;
beforeAll(async()=>{
 db=await createRecoveryDatabase();await seedRecoveryData(db);
 for(const[user,role]of[[principal,"principal"],[finance,"accountant"],[reception,"reception_staff"]]){
  await db.query("insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())",[user,`${user}@gate-office.invalid`]);
  await db.query("update public.profiles set school_id=$1 where id=$2",[id.schoolA,user]);
  await db.query("insert into public.user_roles(user_id,school_id,role)values($1,$2,$3)",[user,id.schoolA,role]);
 }
 await db.exec("insert into auth.sessions(id,user_id,aal)select id,id,'aal1'from auth.users");
 for(const user of[id.adminA,id.adminB,id.teacherA,id.guardianA,id.studentUserA,principal,finance,reception]){
  const factor=randomUUID();await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status)values($1,$2,'totp','verified')",[factor,user]);
  await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2",[factor,user]);
 }
},60_000);
beforeEach(async()=>{await db.exec("begin");secret=randomBytes(32).toString("base64url");deviceId=randomUUID();await create()});
afterEach(async()=>{await db.exec("rollback")});afterAll(async()=>{await db?.close()});

describe("guarded Gate operations pupil picker",()=>{
 it("binds native Admin/Principal identity and returns active same-school names/admissions only",async()=>{
  const value=await search("  rec-a  ");expect(value).toMatchObject({user_id:id.adminA,school_id:id.schoolA,query:"rec-a",offset:0,page_size:25,total_count:2});
  expect(value.pupils.map(p=>p.student_id)).toEqual([id.pupilA,id.unlinkedPupilA]);
  expect((await search("REC-A",0,principal)).user_id).toBe(principal);
  await db.query("update public.students set status='withdrawn'where id=$1",[id.unlinkedPupilA]);
  expect((await search()).pupils.map(p=>p.student_id)).toEqual([id.pupilA]);
  expect((await search("REC-B")).total_count).toBe(0);
 });
 it("treats percent, underscore and SQL-like text as literal substring data",async()=>{
  const pupil=randomUUID();await db.query("insert into public.students(id,school_id,admission_no,first_name,dob,registered_mobile)values($1,$2,'LITERAL%_001','Literal %_ Pupil','2014-01-01','0000000000')",[pupil,id.schoolA]);
  expect((await search("%_")).pupils.map(p=>p.student_id)).toEqual([pupil]);
  expect((await search("%%")).pupils).toEqual([]);expect((await search("' OR 1=1 --")).total_count).toBe(0);
  expect((await search("No such pupil")).pupils).toEqual([]);
 });
 it("normalizes empty middle names and supports literal Hindi names",async()=>{
  await db.query("update public.students set first_name='आशा',middle_name='',last_name='सिंह'where id=$1",[id.pupilA]);
  expect((await search("आशा सिंह")).pupils).toEqual([{student_id:id.pupilA,student_name:"आशा सिंह",admission_no:"REC-A-001"}]);
 });
 it("paginates all matches with deterministic non-overlapping pages and honest totals",async()=>{
  await db.query("insert into public.students(school_id,admission_no,first_name,dob,registered_mobile)select $1,'PAGE-'||lpad(n::text,3,'0'),'Page pupil '||lpad(n::text,3,'0'),'2014-01-01','0000000000'from generate_series(1,31)n",[id.schoolA]);
  const first=await search("PAGE",0),second=await search("PAGE",25),beyond=await search("PAGE",1_000_000);
  expect(first.total_count).toBe(31);expect(first.pupils).toHaveLength(25);expect(second.pupils).toHaveLength(6);expect(beyond.pupils).toEqual([]);
  expect(new Set([...first.pupils,...second.pupils].map(p=>p.student_id)).size).toBe(31);
 });
 it.each([[null,0],["x",0],["x".repeat(81),0],["REC\nA",0],["REC\u202eA",0],["REC-A",null],["REC-A",-1],["REC-A",1_000_001]]as const)("rejects invalid bounded picker input %s/%s",async(query,offset)=>{await denied(search(query,offset),"22023")});
 it.each([id.teacherA,id.guardianA,id.studentUserA,finance,reception,id.adminB])("denies a lower/foreign native AAL2 caller %s",async user=>{
  await denied(search("REC-A",0,user));await denied(setup(user));await denied(events(user));
 });
 it("denies metadata spoofing, global-only authority and invalid/expired native MFA sessions",async()=>{
  await denied(search("REC-A",0,id.teacherA,id.schoolA,{metadata:{role:"school_admin"}}));
  await denied(search("REC-A",0,id.adminA,id.schoolA,{aal:"aal1"}));await denied(search("REC-A",0,id.adminA,id.schoolA,{session:randomUUID()}));
  await db.query("delete from public.user_roles where user_id=$1",[id.adminA]);await db.query("insert into public.user_roles(user_id,school_id,role)values($1,null,'super_admin')",[id.adminA]);await denied(search());
 });
 it("rechecks native identity before returning even if the initial read was authorized",async()=>{
  await expireAfterInitialActor();await denied(search());
 });
});

describe("additive Gate setup and event history",()=>{
 it("keeps setup fields, adds identity/counts and never returns a raw secret or its hash",async()=>{
  const mapped=await map();const value=await setup();expect(value).toMatchObject({user_id:id.adminA,school_id:id.schoolA,device_count:1,mapping_count:1,page_size:100,offset:0});
  expect(value.devices[0]).toMatchObject({device_id:deviceId,revoked_at:null});expect(value.mappings[0]).toMatchObject({mapping_id:mapped.mapping_id,student_id:id.pupilA});
  expect(JSON.stringify(value)).not.toContain(secret);expect(JSON.stringify(value)).not.toContain("secret_hash");
 });
 it("includes the active device before up to 99 latest retained devices without pretending all history was loaded",async()=>{
  await db.query("insert into app_private.gate_devices(id,school_id,name,secret_hash,late_after,working_days,created_by,revoked_at,revoked_by,revoke_reason)select gen_random_uuid(),$1,'Retained gate '||n,sha256(convert_to('retained-test-secret','UTF8')),'08:30',array[1,2,3,4,5,6],$2,clock_timestamp(),$2,'Verified old device retirement'from generate_series(1,105)n",[id.schoolA,id.adminA]);
  const value=await setup();expect(value.device_count).toBe(106);expect(value.devices).toHaveLength(100);expect(value.devices[0].device_id).toBe(deviceId);
 });
 it("bounds event and mapping pages and adds same-school inline labels only",async()=>{
  const mapped=await map();
  await db.query("insert into app_private.gate_events(device_id,school_id,source_event_id,subject_id,direction,occurred_at,mapping_id,student_id,status,reason)select $1,$2,'event-'||n,'card-one','IN',clock_timestamp(),$3,$4,'held_review','future_clock'from generate_series(1,105)n",[deviceId,id.schoolA,mapped.mapping_id,id.pupilA]);
  await db.query("insert into app_private.gate_events(device_id,school_id,source_event_id,subject_id,direction,occurred_at,status,reason)values($1,$2,'unmapped-event','unknown-card','IN',clock_timestamp(),'held_review','unmapped_subject')",[deviceId,id.schoolA]);
  const first=await events(),second=await events(id.adminA,id.schoolA,100);
  expect(first).toMatchObject({user_id:id.adminA,school_id:id.schoolA,device_count:1,total_count:106});expect(first.events).toHaveLength(100);expect(second.events).toHaveLength(6);
  const own=first.events.find(row=>row.reason==="future_clock")!;expect(own).toMatchObject({device_name:"School gate",student_name:"Synthetic recovery pupil",admission_no:"REC-A-001"});
  expect(first.events.find(row=>row.reason==="unmapped_subject")).toMatchObject({device_name:"School gate",student_name:null,admission_no:null});
  expect(new Set([...first.events,...second.events].map(row=>row.receipt_id)).size).toBe(106);
 });
 it("never joins a foreign-school pupil label from an inconsistent retained receipt",async()=>{
  await db.query("insert into app_private.gate_events(device_id,school_id,source_event_id,subject_id,direction,occurred_at,student_id,status,reason)values($1,$2,'foreign-label-event','foreign-card','IN',clock_timestamp(),$3,'held_review','mapping_school_mismatch')",[deviceId,id.schoolA,id.pupilB]);
  expect((await events()).events[0]).toMatchObject({device_name:"School gate",student_name:null,admission_no:null});
 });
 it.each(["get_gate_setup","list_gate_events"])("rechecks native expiry before returning %s",async name=>{
  await expireAfterInitialActor();await denied(actor(id.adminA,`select public.${name}($1,0)as value`,[id.schoolA]));
 });
 it("preserves original marks, fees, links, device/mapping and immutable receipt rows on reads and denials",async()=>{
  await map();const before=await snapshot();await setup();await events();await search();await denied(search("REC-A",0,id.adminB));expect(await snapshot()).toEqual(before);
 });
 it("keeps direct tables and unchecked actor helpers denied and the new entrypoint invoker-only",async()=>{
  await denied(actor(id.adminA,"select to_jsonb(d)as value from app_private.gate_devices d"));await denied(actor(id.adminA,"select app_private.gate_office_actor($1)as value",[id.schoolA]));
  for(const role of["anon","service_role"]as const)await denied(actor(role==="anon"?null:id.adminA,"select public.search_gate_pupils($1,'REC',0)as value",[id.schoolA],{role}));
  expect((await db.query("select p.prosecdef as definer,has_function_privilege('authenticated',p.oid,'EXECUTE')as browser,has_function_privilege('anon',p.oid,'EXECUTE')as anonymous,has_function_privilege('service_role',p.oid,'EXECUTE')as server from pg_proc p where p.oid='public.search_gate_pupils(uuid,text,integer)'::regprocedure")).rows).toEqual([{definer:false,browser:true,anonymous:false,server:false}]);
 });
});

describe("Gate mutations retain retired-state retries and checked native ownership",()=>{
 it("keeps exact device/mapping retries retired rather than creating a new activation",async()=>{
  const created=await create();expect(created).toMatchObject({user_id:id.adminA,school_id:id.schoolA});
  const mapped=await map();expect(mapped).toMatchObject({user_id:id.adminA,school_id:id.schoolA});
  const retiredMapping=await revokeMapping(mapped.mapping_id);expect(retiredMapping).toMatchObject({user_id:id.adminA,school_id:id.schoolA});expect(retiredMapping.revoked_at).not.toBeNull();
  expect((await map(mapped.mapping_id)).revoked_at).toBe(retiredMapping.revoked_at);
  const retired=await revokeDevice();expect(retired).toMatchObject({user_id:id.adminA,school_id:id.schoolA});expect((await create()).revoked_at).toBe(retired.revoked_at);
  expect((await setup()).device_count).toBe(1);await denied(map(randomUUID(),"new-card",id.unlinkedPupilA));
 });
 it("retains permanent subject ownership and rejects duplicate active pupil mappings",async()=>{
  const mapped=await map();await denied(map(randomUUID(),"card-one",id.unlinkedPupilA),"PT409");await denied(map(randomUUID(),"other-card",id.pupilA),"PT409");
  await revokeMapping(mapped.mapping_id);await denied(map(randomUUID(),"card-one",id.unlinkedPupilA),"PT409");expect((await map(randomUUID(),"replacement-card",id.pupilA)).revoked_at).toBeNull();
 });
 it.each(["Gate\nControl","Gate\u202eControl","Gate\u2066Control","Gate\u0085Control"])("rejects unsafe device labels %s",async name=>{
  await revokeDevice();await denied(create(randomUUID(),name),"22023");
 });
 it.each(["Reason\ncontrol","Reason\u202econtrol","Reason\u2066control","Reason\u0085control"])("rejects unsafe revoke reasons %s",async reason=>{
  const mapped=await map();await denied(revokeDevice(reason),"22023");await denied(revokeMapping(mapped.mapping_id,reason),"22023");
 });
 it.each(["create","revoke_device","map","revoke_mapping"]as const)("rolls back %s if native expiry changes during mutation",async kind=>{
  const mapped=kind==="revoke_mapping"?await map():null;
  const before=await snapshot();
  if(kind==="create"){
   await revokeDevice();await expireOnMutation("gate_devices","insert");await denied(create(randomUUID()));
   expect((await setup()).device_count).toBe(1);
  }else{
   await expireOnMutation(kind==="revoke_device"?"gate_devices":"gate_student_mappings",kind==="map"?"insert":"update");
   await denied(kind==="map"?map():kind==="revoke_mapping"?revokeMapping(mapped!.mapping_id):revokeDevice());expect(await snapshot()).toEqual(before);
  }
 });
 it.each(["create","revoke_device","map","revoke_mapping"]as const)("rejects %s after initial native authorization expires",async kind=>{
  const mapped=kind==="revoke_mapping"?await map():null;const before=await snapshot();await expireAfterInitialActor();
  await denied(kind==="create"?create(randomUUID()):kind==="map"?map():kind==="revoke_mapping"?revokeMapping(mapped!.mapping_id):revokeDevice());expect(await snapshot()).toEqual(before);
 });
});
