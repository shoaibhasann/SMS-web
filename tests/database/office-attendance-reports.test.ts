// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite, today: string, start: string, days: string[];
const destinationClass = randomUUID(), destinationSection = randomUUID();
type Period = { state: string; from: string | null; to: string | null; pupil_count: number; complete_pupils: number; incomplete_pupils: number;
  unverified_pupils: number; enrollment_days: number; working_days: number; closed_days: number; unmarked_days: number; invalid_days: number; earned_days: number; percentage: number | null };
type Report = { user_id: string; school_id: string; pupil_count: number; month: string; year: { id: string }; scope: { class_id: string | null; section_id: string | null }; month_summary: Period; year_summary: Period };
type Context = { school_id: string; user_id: string; current_year_id: string | null; years: { id: string }[]; classes: { id: string }[]; schools: { id: string }[] };
async function actor<T>(user: string | null, sql: string, args: unknown[] = [], options: { role?: "authenticated" | "anon" | "service_role"; aal?: string; session?: string; metadata?: unknown } = {}) {
  await db.exec("savepoint office_report_actor");
  try {
    await db.exec(`set local role ${options.role ?? "authenticated"}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: options.session ?? user, aal: options.aal ?? "aal2", role: options.role ?? "authenticated", user_metadata: options.metadata })]);
    const result = await db.query<{ value: T }>(sql, args);
    await db.exec("reset role;release savepoint office_report_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows[0]?.value;
  } catch (error) { await db.exec("rollback to savepoint office_report_actor;release savepoint office_report_actor"); throw error; }
}
async function denied(promise: Promise<unknown>, code = "42501") { await expect(promise).rejects.toMatchObject({ code }); }
const report = (classId: string | null = null, sectionId: string | null = null, user = id.adminA, school = id.schoolA, year = id.yearA, selectedMonth: string | null = null, options = {}) =>
  actor<Report>(user, "select public.get_office_attendance_report($1,$2,$3,$4,$5) as value", [school, year, selectedMonth, classId, sectionId], options);
const context = (user = id.adminA, school: string | null = id.schoolA, options = {}) => actor<Context>(user, "select public.get_office_attendance_report_context($1) as value", [school], options);
async function calendar() {
  await db.query(`insert into app_private.school_attendance_policy_versions(school_id,revision,effective_from,working_days,correction_window_days,reason,actor_id,request_id)
    values($1,1,$2,array[0,1,2,3,4,5,6],2,'Verified synthetic school calendar',$3,$4)`, [id.schoolA, start, id.adminA, randomUUID()]);
  await db.query(`insert into app_private.school_attendance_day_exceptions(school_id,revision,day,mode,label,reason,actor_id,request_id)
    values($1,2,$2,'holiday','Verified school holiday','Verified school holiday evidence',$3,$4)`, [id.schoolA, days[3], id.adminA, randomUUID()]);
}
async function marks() {
  const statuses = ["present", "late", "half_day", "present", "leave", "absent", "present"];
  for (let n = 0; n < 7; n++) await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,$6)`, [id.schoolA,id.yearA,id.sectionA,id.pupilA,days[n],statuses[n]]);
  for (let n = 4; n < 7; n++) await db.query(`insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,$6)`, [id.schoolA,id.yearA,id.sectionA,id.unlinkedPupilA,days[n],statuses[n]]);
}
async function move() {
  const enrollment = (await db.query<{ id: string }>("select id from public.enrollments where student_id=$1 and academic_year_id=$2", [id.unlinkedPupilA,id.yearA])).rows[0].id;
  await db.query(`insert into app_private.roster_placement_changes(school_id,request_id,student_id,source_enrollment_id,source_year_id,source_class_id,source_section_id,
    destination_enrollment_id,destination_year_id,destination_class_id,destination_section_id,change_kind,effective_date,reason,changed_by)
    values($1,$2,$3,$4,$5,$6,$7,$4,$5,$8,$9,'move',$10,'Verified synthetic class move',$11)`, [id.schoolA,randomUUID(),id.unlinkedPupilA,enrollment,id.yearA,id.classA,id.sectionA,destinationClass,destinationSection,today,id.adminA]);
  await db.query("update public.enrollments set class_id=$1,section_id=$2 where id=$3", [destinationClass,destinationSection,enrollment]);
  await db.query("update public.attendance set section_id=$1 where student_id=$2 and attendance_date=$3", [destinationSection,id.unlinkedPupilA,today]);
}
const snapshot = async () => (await db.query(`select(select jsonb_agg(to_jsonb(a) order by id) from public.attendance a) as marks,
 (select jsonb_agg(to_jsonb(f) order by id) from public.student_fees f) as fees,
 (select jsonb_agg(to_jsonb(e) order by id) from public.enrollments e) as enrollments,
 (select jsonb_agg(to_jsonb(l) order by student_id,parent_id) from public.student_parents l) as links`)).rows;
beforeAll(async () => {
  db=await createRecoveryDatabase();await seedRecoveryData(db);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  for (const user of [id.adminA,id.claimantA]) {
    const factor=randomUUID();await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')",[factor,user]);
    await db.query("update auth.sessions set aal='aal2',factor_id=$1 where user_id=$2",[factor,user]);
  }
  await db.query("update public.profiles set school_id=$1 where id=$2",[id.schoolA,id.claimantA]);
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'principal')",[id.claimantA,id.schoolA]);
  const clock=(await db.query<{today:string;start:string;days:string[];month:string}>(`select d::text as today,(d-6)::text as start,date_trunc('month',d)::date::text as month,
    array(select(d-6+n)::text from generate_series(0,6)n) as days from(select(now() at time zone 'Asia/Kolkata')::date as d)c`)).rows[0];
  ({today,start,days}=clock);
  await db.query("update public.academic_years set start_date=$1,end_date=$2::date+30 where id=$3",[start,today,id.yearA]);
  await db.query("update public.students set admission_date=$1 where id=$2",[start,id.pupilA]);
  await db.query("update public.students set admission_date=$1 where id=$2",[days[4],id.unlinkedPupilA]);
  await db.query("update public.attendance set attendance_date=$1::date-30",[start]);
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Verified moved class')",[destinationClass,id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Verified moved section')",[destinationSection,id.schoolA,destinationClass]);
},60_000);
beforeEach(async()=>{await db.exec("begin")});afterEach(async()=>{await db.exec("rollback")});afterAll(async()=>{await db?.close()});

describe("official Office class and school reporting",()=>{
 it("binds context to actual Admin/Principal school and uses native current-profile bootstrap",async()=>{
   expect(await context()).toMatchObject({user_id:id.adminA,school_id:id.schoolA,current_year_id:id.yearA,schools:[{id:id.schoolA}]});
   expect(await context(id.claimantA,null)).toMatchObject({user_id:id.claimantA,school_id:id.schoolA});
   expect((await context()).classes.map(c=>c.id)).toEqual(expect.arrayContaining([id.classA,destinationClass]));
 });
 it("weights pupil-days rather than averaging individual pupil percentages",async()=>{
   await calendar();await marks();const before=await snapshot();
   const value=await report();expect(value).toMatchObject({pupil_count:2,scope:{class_id:null,section_id:null},year_summary:{pupil_count:2,complete_pupils:2,incomplete_pupils:0,enrollment_days:10,working_days:9,closed_days:1,earned_days:4.5,percentage:50,state:"complete"}});
   const family=await actor<{year_summary:Period}>(id.guardianA,"select public.get_family_attendance_report('parent',$1,$2,null) as value",[id.pupilA,id.yearA],{aal:"aal1"});
   expect(family.year_summary).toMatchObject({percentage:58.33,working_days:6,earned_days:3.5});expect(await snapshot()).toEqual(before);
 });
 it("attributes class and section pupil-days through a cross-class move and reconciles school totals",async()=>{
   await calendar();await marks();await move();
   const all=await report(),source=await report(id.classA,id.sectionA),destination=await report(destinationClass,destinationSection);
   expect(source.year_summary).toMatchObject({pupil_count:2,working_days:8,earned_days:3.5,percentage:43.75});
   expect(destination.year_summary).toMatchObject({pupil_count:1,working_days:1,earned_days:1,percentage:100});
   expect(source.year_summary.working_days+destination.year_summary.working_days).toBe(all.year_summary.working_days);
   expect(source.year_summary.earned_days+destination.year_summary.earned_days).toBe(all.year_summary.earned_days);
 });
 it("withholds school/class rates for missing marks without assuming absence",async()=>{
   await calendar();await marks();await db.query("delete from public.attendance where student_id=$1 and attendance_date=$2",[id.unlinkedPupilA,today]);
   for(const value of [await report(),await report(id.classA)])expect(value.year_summary).toMatchObject({state:"attendance_incomplete",percentage:null,unmarked_days:1,incomplete_pupils:1});
 });
 it("withholds rates for missing calendars and malformed canonical records",async()=>{
   await marks();expect((await report()).year_summary).toMatchObject({state:"calendar_unconfigured",percentage:null,incomplete_pupils:2});
   await calendar();await db.query("update public.attendance set section_id=$1 where student_id=$2 and attendance_date=$3",[destinationSection,id.pupilA,today]);
   expect((await report()).year_summary).toMatchObject({state:"inconsistent",percentage:null,invalid_days:1});
 });
 it("does not silently exclude missing enrollment/admission or broken move provenance",async()=>{
   await calendar();await marks();await db.query("update public.students set admission_date=null where id=$1",[id.unlinkedPupilA]);
   expect((await report()).year_summary).toMatchObject({state:"enrollment_unverified",percentage:null,unverified_pupils:1,pupil_count:2});
   await db.query("update public.students set admission_date=$1 where id=$2",[days[4],id.unlinkedPupilA]);await move();
   await db.query("update app_private.roster_placement_changes set destination_class_id=$1 where student_id=$2",[id.classA,id.unlinkedPupilA]);
   expect((await report(destinationClass)).year_summary).toMatchObject({state:"enrollment_unverified",percentage:null,unverified_pupils:1});
   await db.query("delete from public.enrollments where student_id=$1 and academic_year_id=$2",[id.pupilA,id.yearA]);
   expect((await report()).year_summary).toMatchObject({state:"enrollment_unverified",percentage:null});
 });
 it("keeps future admissions in the candidate cohort but excludes no-elapsed pupil-days",async()=>{
   await calendar();await marks();await db.query("update public.students set admission_date=$1::date+1 where id=$2",[today,id.unlinkedPupilA]);
   expect(await report()).toMatchObject({pupil_count:2,year_summary:{pupil_count:1,complete_pupils:1,incomplete_pupils:0,working_days:6,percentage:58.33}});
 });
 it.each(["staged","cancelled"])("excludes deliberately %s placements without marks but reviews any marked pupil",async status=>{
   await calendar();await marks();await db.query("delete from public.attendance where student_id=$1",[id.unlinkedPupilA]);
   await db.query("update public.enrollments set status=$1 where student_id=$2 and academic_year_id=$3",[status,id.unlinkedPupilA,id.yearA]);
   expect(await report()).toMatchObject({pupil_count:1,year_summary:{pupil_count:1,percentage:58.33,state:"complete"}});
   await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,'present')",[id.schoolA,id.yearA,id.sectionA,id.unlinkedPupilA,today]);
   expect(await report()).toMatchObject({pupil_count:2,year_summary:{pupil_count:2,percentage:null,state:"enrollment_unverified",unverified_pupils:1}});
 });
 it("rejects a 5,001-pupil school-year cohort rather than truncating even a class report",async()=>{
   await db.query("insert into public.students(school_id,admission_no,first_name,dob,registered_mobile,admission_date) select $1,'CAP-'||n,'Synthetic cap pupil','2014-01-01','0000000000',$2 from generate_series(1,4999)n",[id.schoolA,start]);
   await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) select id,$2,$3,$4 from public.students where school_id=$1 and admission_no like 'CAP-%'",[id.schoolA,id.yearA,id.classA,id.sectionA]);
   await denied(report(),"54000");await denied(report(destinationClass),"54000");
 });
 it.each([[id.schoolA,id.yearB],[id.schoolB,id.yearA]])("does not silently omit an orphan mark misfiled to school/year %s/%s",async(school,year)=>{
   await calendar();await marks();await db.query("delete from public.enrollments where student_id=$1 and academic_year_id=$2",[id.unlinkedPupilA,id.yearA]);
   await db.query("delete from public.attendance where student_id=$1",[id.unlinkedPupilA]);
   await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status) values($1,$2,$3,$4,$5,'present')",[school,year,id.sectionA,id.unlinkedPupilA,today]);
   expect(await report()).toMatchObject({pupil_count:2,year_summary:{pupil_count:2,percentage:null,state:"enrollment_unverified",unverified_pupils:1}});
 });
 it("retains the family caller's explicit review state for its own staged placement",async()=>{
   await db.query("update public.enrollments set status='staged' where student_id=$1 and academic_year_id=$2",[id.pupilA,id.yearA]);
   const value=await actor<{year_summary:Period}>(id.guardianA,"select public.get_family_attendance_report('parent',$1,$2,null) as value",[id.pupilA,id.yearA],{aal:"aal1"});
   expect(value.year_summary).toMatchObject({state:"enrollment_unverified",percentage:null});
 });
 it("uses one internally frozen Office clock across all pupil calculations",async()=>{
   await calendar();await marks();
   const year=(await db.query<{year:unknown}>("select to_jsonb(y) as year from public.academic_years y where id=$1",[id.yearA])).rows[0].year;
   const cache={revision:2,today:days[5],year,days:Object.fromEntries(days.slice(0,6).map((day,index)=>[day,{configured:true,is_working:index!==3}]))};
   const value=(await db.query<{value:{server_today:string;year_summary:Period}}>("select app_private.calculate_attendance_report_pupil('office',$1,$2,null,$3,null,null,$4::jsonb) as value",[id.pupilA,id.yearA,id.schoolA,JSON.stringify(cache)])).rows[0].value;
   expect(value).toMatchObject({server_today:days[5],year_summary:{to:days[5],working_days:5,earned_days:2.5,percentage:50}});
 });
 it("withholds an unrelated class when corrupt move attribution cannot establish historical membership",async()=>{
   await calendar();await marks();await move();
   const thirdClass=randomUUID();await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Third reporting class')",[thirdClass,id.schoolA]);
   await db.query("update app_private.roster_placement_changes set source_section_id=$1 where student_id=$2",[id.sectionB,id.unlinkedPupilA]);
   expect((await report(thirdClass)).year_summary).toMatchObject({state:"enrollment_unverified",percentage:null,pupil_count:1,unverified_pupils:1});
 });
 it("returns an explicit empty scope and closed-only periods without inventing zero percent",async()=>{
   await calendar();expect((await report(destinationClass)).year_summary).toMatchObject({state:"no_pupils",percentage:null,pupil_count:0});
   await db.query("update public.students set admission_date=$1 where school_id=$2",[days[3],id.schoolA]);
   await db.query(`insert into app_private.school_attendance_day_exceptions(school_id,revision,day,mode,label,reason,actor_id,request_id)
     select $1,10+n,$2::date+n,'holiday','Verified holiday','Verified synthetic closed period',$3,gen_random_uuid() from generate_series(0,3)n`,[id.schoolA,days[3],id.adminA]);
   expect((await report()).year_summary).toMatchObject({state:"no_working_days",percentage:null,complete_pupils:2,pupil_count:2,working_days:0,closed_days:8});
 });
 it("uses historical admission/withdrawal and year-end dates rather than today's roster",async()=>{
   await calendar();await marks();const enrollment=(await db.query<{id:string}>("select id from public.enrollments where student_id=$1 and academic_year_id=$2",[id.unlinkedPupilA,id.yearA])).rows[0].id;
   await db.query("update public.enrollments set status='withdrawn' where id=$1",[enrollment]);
   await db.query(`insert into app_private.enrollment_withdrawals(enrollment_id,student_id,school_id,academic_year_id,class_id,section_id,reason,withdrawn_by,withdrawn_at)
     values($1,$2,$3,$4,$5,$6,'Verified reporting withdrawal',$7,$8::date::timestamp at time zone 'Asia/Kolkata')`,[enrollment,id.unlinkedPupilA,id.schoolA,id.yearA,id.classA,id.sectionA,id.adminA,days[5]]);
   await db.query("update public.students set status='withdrawn' where id=$1",[id.unlinkedPupilA]);
   expect((await report()).year_summary).toMatchObject({working_days:8,earned_days:3.5,percentage:43.75});
   await db.query("update public.academic_years set end_date=$1,is_current=false where id=$2",[days[5],id.yearA]);
   expect((await report()).year_summary.to).toBe(days[5]);
 });
 it.each([id.teacherA,id.guardianA,id.studentUserA,id.adminB])("denies wrong-role/foreign-school callers %s",async user=>{
   await denied(context(user,id.schoolA,{aal:"aal1"}));await denied(report(null,null,user,id.schoolA,id.yearA,null,{aal:"aal1"}));
 });
 it("denies metadata spoofing, global-only roles, stale native sessions and policy MFA bypass",async()=>{
   await denied(context(id.teacherA,id.schoolA,{aal:"aal1",metadata:{role:"school_admin"}}));
   await db.query("delete from public.user_roles where user_id=$1",[id.adminA]);
   await db.query("insert into public.user_roles(user_id,school_id,role) values($1,null,'super_admin')",[id.adminA]);await denied(context());
   await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'school_admin')",[id.adminA,id.schoolA]);
   await denied(context(id.adminA,id.schoolA,{session:randomUUID()}));await denied(context(id.adminA,id.schoolA,{session:id.adminB}));
   await denied(context(id.adminA,id.schoolA,{aal:"aal1"}));
   await db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where user_id=$1",[id.adminA]);await denied(context());
 });
 it.each(["accountant","reception_staff"])("denies lower privilege %s memberships",async role=>{
   await db.query("update public.user_roles set role=$1 where user_id=$2",[role,id.teacherA]);
   await denied(context(id.teacherA,id.schoolA,{aal:"aal1"}));await denied(report(null,null,id.teacherA,id.schoolA,id.yearA,null,{aal:"aal1"}));
 });
 it("allows policy-permitted Office AAL1 only when no factor or school policy requires MFA",async()=>{
   await db.query("delete from auth.mfa_factors where user_id=$1",[id.adminA]);await db.query("update auth.sessions set aal='aal1',factor_id=null where user_id=$1",[id.adminA]);
   expect(await context(id.adminA,id.schoolA,{aal:"aal1"})).toMatchObject({school_id:id.schoolA});
 });
 it("rejects foreign class/year/section and invalid or future months without fallback",async()=>{
   await denied(report(id.classB));await denied(report(null,null,id.adminA,id.schoolA,id.yearB));await denied(report(id.classA,id.sectionB));
   await denied(report(null,id.sectionA),"22023");await denied(report(null,null,id.adminA,id.schoolA,id.yearA,days[1]),"22023");
   const next=(await db.query<{m:string}>("select(date_trunc('month',$1::date)+interval '1 month')::date::text as m",[today])).rows[0].m;
   await denied(report(null,null,id.adminA,id.schoolA,id.yearA,next),"22023");
 });
 it("keeps math and cached-calendar inputs private; only authenticated invoker entrypoints execute",async()=>{
   await denied(actor(id.adminA,"select app_private.calculate_attendance_report_pupil('office',$1,$2,null,$3,null,null,'{}') as value",[id.pupilA,id.yearA,id.schoolA]));
   for(const role of ["anon","service_role"] as const)await denied(actor(role==="anon"?null:id.adminA,"select public.get_office_attendance_report_context($1) as value",[id.schoolA],{role}));
   const acl=(await db.query<{definer:boolean;browser:boolean;anonymous:boolean}>(`select p.prosecdef as definer,has_function_privilege('authenticated',p.oid,'EXECUTE') as browser,has_function_privilege('anon',p.oid,'EXECUTE') as anonymous
     from pg_proc p where p.oid=to_regprocedure('public.get_office_attendance_report(uuid,uuid,date,uuid,uuid)')`)).rows[0];
   expect(acl).toEqual({definer:false,browser:true,anonymous:false});
   await denied(actor(id.adminA,"select public.get_family_attendance_report('office',$1,$2,null) as value",[id.pupilA,id.yearA]),"22023");
 });
});
