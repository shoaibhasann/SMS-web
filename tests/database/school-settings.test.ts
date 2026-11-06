// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const principal=randomUUID(),finance=randomUUID(),reception=randomUUID(),superAdmin=randomUUID(),fakeSuperAdmin=randomUUID();
const editFields=["name","board","affiliation_no","address","city","state","pincode","phone","email","website"].sort();
const reason="Synthetic QA approved office contact update";
const getSql="select public.get_school_settings($1) as value";
const saveSql="select public.save_school_settings($1,$2,$3,$4,$5) as value";
type Details={ name:string; board:string|null; affiliation_no:string|null; address:string|null; city:string|null; state:string|null;
  pincode:string|null; phone:string|null; email:string|null; website:string|null };
type Snapshot={school:Details&{id:string;code:string|null;timezone:string;revision:number};can_edit:boolean;setup:Record<string,number|string|object|null>;
  history:{id:string;revision:number;changed_at:string;actor_name:string|null;changed_fields:string[]}[]};
type Receipt={revision:number;changed:boolean;replayed:boolean};
let db:PGlite;
const details=(overrides:Partial<Details>={}):Details=>({name:"Verified School Alpha",board:"CBSE",affiliation_no:"QA-1234",
  address:"Synthetic Sector 4",city:"Delhi",state:"Delhi",pincode:"110001",phone:"+91 (11) 2345-6789",email:"office@school.invalid",
  website:"https://school.invalid/contact",...overrides});

async function actor<T extends Record<string,unknown>={value:unknown}>(user:string|null,sql:string,params:unknown[]=[],
  options:{role?:"authenticated"|"anon"|"service_role";session?:string|null;claims?:object}={}){
  await db.exec("savepoint settings_probe");
  try{
    await db.exec(`set local role ${options.role??"authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[
      user??"",JSON.stringify({sub:user,session_id:options.session===undefined?user:options.session,...options.claims})]);
    const result=await db.query<T>(sql,params);
    await db.exec("reset role; release savepoint settings_probe");
    return result.rows;
  }catch(error){await db.exec("rollback to savepoint settings_probe; release savepoint settings_probe");throw error;}
}
const load=async(user=id.adminA,school=id.schoolA,options:Parameters<typeof actor>[3]={})=>
  (await actor<{value:Snapshot}>(user,getSql,[school],options))[0].value;
const save=async({user=id.adminA,school=id.schoolA,revision=0,request=randomUUID(),value=details(),note=reason,
  options={}}:{user?:string;school?:string;revision?:number|null;request?:string|null;value?:unknown;note?:string|null;options?:Parameters<typeof actor>[3]}={})=>
  (await actor<{value:Receipt}>(user,saveSql,[school,revision,request,value===null?null:JSON.stringify(value),note],options))[0].value;
const denied=(promise:Promise<unknown>)=>expect(promise).rejects.toMatchObject({code:"42501"});
const invalid=(promise:Promise<unknown>)=>expect(promise).rejects.toMatchObject({code:"22023"});
const conflict=(promise:Promise<unknown>)=>expect(promise).rejects.toMatchObject({code:"PT409"});
const preserved=async()=> (await db.query(`select jsonb_build_object(
  'attendance',(select jsonb_agg(to_jsonb(r) order by id) from public.attendance r),
  'fees',(select jsonb_agg(to_jsonb(r) order by id) from public.student_fees r),
  'payments',(select jsonb_agg(to_jsonb(r) order by id) from public.fee_payments r),
  'links',(select jsonb_agg(to_jsonb(r) order by student_id,parent_id) from public.student_parents r),
  'enrollments',(select jsonb_agg(to_jsonb(r) order by id) from public.enrollments r),
  'year',(select jsonb_agg(to_jsonb(r) order by id) from public.academic_years r),
  'school_other',(select to_jsonb(r)-array['name','board','affiliation_no','address','city','state','pincode','phone','email','website','settings_revision','updated_at']
    from public.schools r where id='${id.schoolA}'),
  'school_b',(select to_jsonb(r) from public.schools r where id='${id.schoolB}')) as value`)).rows;

beforeAll(async()=>{
  db=await createRecoveryDatabase();await seedRecoveryData(db);
  for(const [user,role,school] of [[principal,"principal",id.schoolA],[finance,"accountant",id.schoolA],
    [reception,"reception_staff",id.schoolA],[superAdmin,"super_admin",null],[fakeSuperAdmin,"super_admin",id.schoolA]] as const){
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",[user,`${user}@settings.invalid`]);
    await db.query("update public.profiles set school_id=$2,full_name=$3 where id=$1",[user,school,`Synthetic ${role}`]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)",[user,school,role]);
  }
  await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users");
  await db.query("update public.schools set settings=$2,primary_color='#3355FF',secondary_color='#7755DD',logo_url='private-legacy-logo' where id=$1",
    [id.schoolA,{canary:"OPAQUE_SCHOOL_CONFIG_DO_NOT_EXPOSE"}]);
},60_000);
beforeEach(async()=>{await db.exec("begin");});
afterEach(async()=>{await db.exec("rollback");});
afterAll(async()=>{await db?.close();});

describe("governed school settings and derived setup status",()=>{
  it("returns the exact safe school DTO, complete scoped structural counts and no opaque config",async()=>{
    const value=await load();
    expect(Object.keys(value).sort()).toEqual(["can_edit","history","school","setup"]);
    expect(Object.keys(value.school).sort()).toEqual([...editFields,"id","code","timezone","revision"].sort());
    expect(value.school).toMatchObject({id:id.schoolA,name:"Synthetic recovery school A",code:"RECOVERY-A",revision:0,timezone:"Asia/Kolkata"});
    expect(value.can_edit).toBe(true);expect(value.history).toEqual([]);
    expect(value.setup).toMatchObject({current_year_count:1,active_classes:1,sections:1,classes_without_sections:0,
      active_subjects:1,teachers:1,linked_teachers:1,teaching_assignments:1,sections_without_class_teacher:0,
      enrolled_students:2,invalid_enrollments:0,linked_students:1,pending_guardian_invitations:0});
    expect(value.setup.current_year).toMatchObject({id:id.yearA,name:"2026–27 Recovery",start_date:"2026-04-01",end_date:"2027-03-31"});
    expect(value.setup.school_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(value)).not.toContain("OPAQUE_SCHOOL_CONFIG");expect(JSON.stringify(value)).not.toContain(id.schoolB);
  });

  it("saves normalized profile details, records only changed fields, and preserves every unrelated record",async()=>{
    const before=await preserved(),request=randomUUID();
    expect(await save({request,value:details({name:"  Verified School Alpha  ",email:" OFFICE@SCHOOL.INVALID "})}))
      .toEqual({revision:1,changed:true,replayed:false});
    const value=await load();expect(value.school).toMatchObject(details());expect(value.school.revision).toBe(1);
    expect(value.history).toHaveLength(1);expect(Object.keys(value.history[0]).sort())
      .toEqual(["id","revision","changed_at","actor_name","changed_fields"].sort());
    expect(value.history[0].changed_fields).toEqual(editFields);expect(value.history[0].actor_name).toBe("Synthetic admin-a");
    expect(JSON.stringify(value.history)).not.toContain(reason);expect(JSON.stringify(value.history)).not.toContain("office@school.invalid");
    const audit=(await db.query<{reason:string;request_id:string;before_details:object;after_details:Details}>("select reason,request_id,before_details,after_details from app_private.school_settings_audit")).rows[0];
    expect(audit.reason).toBe(reason);expect(audit.request_id).toBe(request);expect(audit.after_details).toEqual(details());
    expect(await preserved()).toEqual(before);
  });

  it("permits Principal read-only and a true global Super Admin while denying a school-bound fake Super Admin",async()=>{
    expect((await load(principal)).can_edit).toBe(false);await denied(save({user:principal}));
    expect((await load(superAdmin)).can_edit).toBe(true);expect((await save({user:superAdmin})).revision).toBe(1);
    await denied(load(fakeSuperAdmin));await denied(save({user:fakeSuperAdmin}));
  });

  it.each([id.teacherA,id.studentUserA,id.guardianA,finance,reception,id.adminB])("denies unprivileged or other-school actor %s for reads and writes",async(user)=>{
    await denied(load(user));await denied(save({user}));
  });

  it("denies anonymous and service callers and cannot bootstrap or delete a school through raw REST privileges",async()=>{
    await denied(actor(null,getSql,[id.schoolA],{role:"anon"}));
    await denied(actor(id.adminA,getSql,[id.schoolA],{role:"service_role"}));
    await denied(actor(id.adminA,saveSql,[id.schoolA,0,randomUUID(),details(),reason],{role:"service_role"}));
    for(const role of ["anon","authenticated"] as const){
      for(const sql of ["insert into public.schools(name) values('Unauthorized new school')",
        `update public.schools set name='Bypass',settings_revision=100 where id='${id.schoolA}'`,
        `delete from public.schools where id='${id.schoolA}'`,"truncate public.schools cascade",
        "select * from public.school_settings",`insert into public.school_settings(school_id) values('${id.schoolA}')`,
        `update public.school_settings set settings='{}'`,"delete from public.school_settings","truncate public.school_settings"])
        await denied(actor(id.adminA,sql,[],{role}));
    }
    expect((await actor(id.adminA,"select id,name from public.schools where id=$1",[id.schoolA]))[0]).toMatchObject({id:id.schoolA});
    expect((await db.query(`select has_table_privilege('service_role','public.schools','UPDATE') as server,
      has_table_privilege('authenticated','public.schools','TRIGGER') as trigger,
      has_any_column_privilege('authenticated','public.schools','UPDATE') as column,
      has_any_column_privilege('authenticated','public.school_settings','SELECT') as legacy`)).rows)
      .toEqual([{server:true,trigger:false,column:false,legacy:false}]);
  });

  it.each([null,"malformed",randomUUID(),id.adminB])("denies missing, malformed, unknown or another user's session %s",async(session)=>{
    await denied(load(id.adminA,id.schoolA,{session}));await denied(save({options:{session}}));
  });

  it.each(["expired","deleted","inactive_profile","anonymous_account","unverified_account","banned_account","inactive_school","removed_role"])("denies %s identities even with retained credentials",async(state)=>{
    if(state==="expired")await db.query("update auth.sessions set not_after=now()-interval '1 minute' where id=$1",[id.adminA]);
    if(state==="deleted")await db.query("delete from auth.sessions where id=$1",[id.adminA]);
    if(state==="inactive_profile")await db.query("update public.profiles set is_active=false where id=$1",[id.adminA]);
    if(state==="anonymous_account")await db.query("update auth.users set is_anonymous=true where id=$1",[id.adminA]);
    if(state==="unverified_account")await db.query("update auth.users set email_confirmed_at=null,phone_confirmed_at=null where id=$1",[id.adminA]);
    if(state==="banned_account")await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[id.adminA]);
    if(state==="inactive_school")await db.query("update public.schools set is_active=false where id=$1",[id.schoolA]);
    if(state==="removed_role")await db.query("delete from public.user_roles where user_id=$1",[id.adminA]);
    await denied(load());await denied(save());
  });

  it("replays an exact lost-response request after later saves without writing or returning a newer receipt",async()=>{
    const request=randomUUID(),value=details();expect(await save({request,value})).toEqual({revision:1,changed:true,replayed:false});
    expect(await save({request,value})).toEqual({revision:1,changed:true,replayed:true});
    expect(await save({revision:1,value:details({city:"Firozabad"})})).toEqual({revision:2,changed:true,replayed:false});
    expect(await save({request,value})).toEqual({revision:1,changed:true,replayed:true});
    expect((await load()).school).toMatchObject({revision:2,city:"Firozabad"});
    expect((await db.query("select count(*)::integer as count from app_private.school_settings_audit")).rows).toEqual([{count:2}]);
  });

  it("binds request IDs to the actor and exact semantic payload, including revision and reason",async()=>{
    const request=randomUUID();await save({request});
    await conflict(save({request,value:details({city:"Elsewhere"})}));await conflict(save({request,revision:1}));
    await conflict(save({request,note:reason+" changed"}));await conflict(save({request,value:details({name:" Verified School Alpha "})}));
    expect(await save({user:superAdmin,request,revision:1,value:details({city:"Agra"})})).toMatchObject({revision:2,replayed:false});
  });

  it("denies stale revisions before writing; a refreshed retry succeeds once",async()=>{
    await save();const before=await load();await conflict(save({value:details({city:"Stale overwrite"})}));
    expect(await load()).toEqual(before);expect(await save({revision:1,value:details({city:"Fresh edit"})})).toMatchObject({revision:2});
  });

  it("does not change revision, timestamp or audit on a no-op, but remembers its exact retry",async()=>{
    await save();const previous=(await db.query("select updated_at from public.schools where id=$1",[id.schoolA])).rows;
    const request=randomUUID();expect(await save({revision:1,request})).toEqual({revision:1,changed:false,replayed:false});
    expect(await save({revision:1,request})).toEqual({revision:1,changed:false,replayed:true});
    expect((await load()).history).toHaveLength(1);
    expect((await db.query("select updated_at from public.schools where id=$1",[id.schoolA])).rows).toEqual(previous);
  });

  it("normalizes blank optional fields to null and accepts office landlines without requiring guardian E164",async()=>{
    await save({value:details({address:"Sector 4\r\nDelhi\rIndia",affiliation_no:"  ",phone:"011 2345-6789",website:"https://school.invalid:443/?q=@office"})});
    expect((await load()).school).toMatchObject({address:"Sector 4\nDelhi\nIndia",affiliation_no:null,phone:"011 2345-6789",website:"https://school.invalid:443/?q=@office"});
  });

  it.each([
    {name:"X"},{name:" ".repeat(5)},{name:"N".repeat(161)},{name:"School\u0001"},{address:"Line1\u0007Line2"},
    {address:"a".repeat(1001)},{city:"c".repeat(101)},{state:"s".repeat(101)},{affiliation_no:"a".repeat(101)},
    {board:"ICSE"},{pincode:"12345"},{pincode:"1234567"},{phone:"123"},{phone:"+91 1234x56789"},
    {phone:"+1234567890123456"},{email:"invalid-email"},{email:"one@@school.invalid"},{email:"a b@school.invalid"},
    {website:"http://school.invalid"},{website:"https://user:password@school.invalid"},{website:"https://school.invalid:99999"},
    {website:"https://school.invalid/\nprivate"},{website:"https://school.invalid\\@other.invalid"},
    {website:"https:///empty"},{website:"https://"},
  ])("rejects invalid field input %j without mutation",async(overrides)=>{
    const before=await preserved();await invalid(save({value:details(overrides)}));expect((await load()).school.revision).toBe(0);
    expect(await preserved()).toEqual(before);
  });

  it("rejects omitted, unknown, nontext and protected fields rather than partially applying a form",async()=>{
    const omitted:Record<string,unknown>={...details()};delete omitted.city;
    for(const value of [null,[],"wrong",omitted,{...details(),city:7},{...details(),name:null},
      {...details(),is_active:false},{...details(),timezone:"UTC"},{...details(),code:"CHANGE"},{...details(),settings:{admin:true}}])
      await invalid(save({value}));
    for(const values of [{revision:null},{revision:-1},{request:null},{note:null},{note:"short".slice(0,4)},{note:"x".repeat(301)},{note:"Reason\nnewline"}])
      await invalid(save(values));
    expect((await load()).history).toEqual([]);
  });

  it("never lets a retry recover permissions after role removal",async()=>{
    const request=randomUUID();await save({request});await db.query("delete from public.user_roles where user_id=$1",[id.adminA]);
    await denied(save({request}));
  });

  it("keeps the latest ten redacted school-only history entries",async()=>{
    for(let revision=0;revision<12;revision++)await save({revision,value:details({city:`City ${revision}`})});
    const value=await load(principal);expect(value.history.map(row=>row.revision)).toEqual([12,11,10,9,8,7,6,5,4,3]);
    expect((await load(id.adminB,id.schoolB)).history).toEqual([]);
    expect(JSON.stringify(value.history)).not.toContain(reason);expect(JSON.stringify(value.history)).not.toContain("office@school.invalid");
    await denied(actor(id.adminA,"select * from app_private.school_settings_audit"));
    await denied(actor(id.adminA,"delete from app_private.school_settings_audit"));
    await denied(actor(id.adminA,"select * from app_private.school_settings_receipts"));
  });

  it("counts missing setup and current-year directories honestly without completing an empty school",async()=>{
    await db.query("update public.academic_years set is_current=false where school_id=$1",[id.schoolA]);
    await db.query("insert into public.classes(school_id,name) values($1,'Unsectioned class')",[id.schoolA]);
    const value=await load();expect(value.setup).toMatchObject({current_year:null,current_year_count:0,active_classes:2,
      classes_without_sections:1,enrolled_students:0,teaching_assignments:0,linked_students:0,sections_without_class_teacher:1,today_attendance:0});
    expect((await load(id.adminB,id.schoolB)).setup).toMatchObject({teachers:0,linked_teachers:0,teaching_assignments:0,
      sections_without_class_teacher:1,enrolled_students:1,linked_students:0});
  });

  it("rejects invalid cohort mappings and inactive/foreign account links from setup counters",async()=>{
    await db.query("update public.profiles set is_active=false where id=$1",[id.teacherA]);
    expect((await load()).setup).toMatchObject({teachers:1,linked_teachers:0,teaching_assignments:0,sections_without_class_teacher:1});
    await db.query("update public.profiles set is_active=false where id=$1",[id.guardianA]);
    expect((await load()).setup.linked_students).toBe(0);
    await db.query("update public.classes set is_active=false where id=$1",[id.classA]);
    expect((await load()).setup).toMatchObject({active_classes:0,sections:0,enrolled_students:0,invalid_enrollments:2});
  });

  it("reports a missing section as an invalid enrollment rather than hiding it through SQL null logic",async()=>{
    await db.query("update public.enrollments set section_id=null where student_id=$1",[id.pupilA]);
    expect((await load()).setup).toMatchObject({enrolled_students:1,invalid_enrollments:1,linked_students:0});
  });

  it("counts the complete school roster beyond client Data API row caps",async()=>{
    await db.query(`with pupils as(insert into public.students(school_id,admission_no,first_name)
      select $1,'SETUP-SCALE-'||n,'Synthetic scale pupil' from generate_series(1,1205)n returning id)
      insert into public.enrollments(student_id,academic_year_id,class_id,section_id)
      select id,$2,$3,$4 from pupils`,[id.schoolA,id.yearA,id.classA,id.sectionA]);
    expect((await load()).setup).toMatchObject({enrolled_students:1207,invalid_enrollments:0,linked_students:1});
    expect((await load(id.adminB,id.schoolB)).setup.enrolled_students).toBe(1);
  });

  it("counts only unexpired, unrevoked, unaccepted invitations for valid current-year pupils",async()=>{
    const values=[{pupil:id.pupilA,expires:"1 hour",accepted:false,revoked:false},{pupil:id.unlinkedPupilA,expires:"-1 hour",accepted:false,revoked:false},
      {pupil:id.pupilA,expires:"1 hour",accepted:true,revoked:false},{pupil:id.pupilA,expires:"1 hour",accepted:false,revoked:true}];
    for(const [index,row] of values.entries())await db.query(`insert into app_private.guardian_invitations(school_id,student_id,email,token_hash,created_at,expires_at,accepted_at,revoked_at)
      values($1,$2,$3,decode($4,'hex'),now()-interval '2 hours',now()+$5::interval,case when $6 then now() else null end,case when $7 then now() else null end)`,
      [id.schoolA,row.pupil,`qa${index}@settings.invalid`,randomUUID().replaceAll("-",""),row.expires,row.accepted,row.revoked]);
    expect((await load()).setup.pending_guardian_invitations).toBe(1);
  });

  it("counts today's saved marks independently from simulated readiness switches",async()=>{
    await db.query("update public.attendance set attendance_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date where id=$1",[id.attendanceA]);
    expect((await load()).setup.today_attendance).toBe(1);
    await invalid(save({value:{...details(),setup_complete:true}}));expect((await load()).setup.today_attendance).toBe(1);
  });

  it("fails closed at revision overflow while allowing a read and no-op at the last supported revision",async()=>{
    await save();await db.query("update public.schools set settings_revision=2147483647 where id=$1",[id.schoolA]);
    await invalid(save({revision:2147483647,value:details({city:"Overflow"})}));
    expect(await save({revision:2147483647})).toEqual({revision:2147483647,changed:false,replayed:false});
  });
});
