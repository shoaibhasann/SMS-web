begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function app_private.office_attendance_report_actor(p_school_id uuid)
returns uuid language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.attendance_calendar_actor(p_school_id);begin
 perform 1 from public.user_roles where user_id=actor and school_id=p_school_id and role in('school_admin','principal') order by id for share;
 if not found or not exists(select 1 from auth.sessions session where session.user_id=actor
  and session.id=(auth.jwt()->>'session_id')::uuid and(session.not_after is null or session.not_after>clock_timestamp())) then
  raise exception 'Only the current School Admin or Principal can read official attendance reports.' using errcode='42501';end if;
 return actor;
end;$$;

-- The Office caller holds authorization and cohort locks; API roles cannot execute this internal kernel.
create function app_private.attendance_report_pupil_school(p_role text,p_student_id uuid,p_office_school_id uuid)
returns uuid language plpgsql volatile security definer set search_path=''
as $$begin
 if p_office_school_id is null then return app_private.family_attendance_report_school(p_role,p_student_id);end if;
 if p_role is distinct from 'office' then
  raise exception 'This pupil does not belong to the selected school report.' using errcode='42501';end if;
 return p_office_school_id;
end;$$;

create function app_private.calculate_attendance_report_pupil(p_role text,p_student_id uuid,p_academic_year_id uuid,p_month date,
 p_office_school_id uuid,p_class_id uuid,p_section_id uuid,p_calendar jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare
 actor uuid;school uuid;student public.students%rowtype;year public.academic_years%rowtype;
 placement public.enrollments%rowtype;withdrawal app_private.enrollment_withdrawals%rowtype;
 today date;month date;year_json jsonb;result jsonb;periods jsonb;blank jsonb;
 count_years integer;count_enrollments integer;promotion_count integer;promotion_day date;bad_promotion boolean;
 start_day date;end_day date;enrollment_state text;calendar_revision bigint;school_days jsonb;
begin
 -- Reuse the native-session, actual-role and current own/linked-child checks.
 school:=app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id);actor:=auth.uid();
 if p_office_school_id is null then
  perform 1 from public.schools where id=school and is_active for share;
  if not found then raise exception 'Current family school access is required.' using errcode='42501';end if;
 end if;
 if p_month is not null and(not isfinite(p_month) or p_month<'0001-01-01'::date or p_month>'9999-12-01'::date or extract(day from p_month)<>1) then
  raise exception 'Choose the first day of a valid reporting month.' using errcode='22023';end if;
 if p_office_school_id is null then
  perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||school::text,0));
 end if;
 if school is distinct from app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id) then
  raise exception 'You cannot view this student.' using errcode='42501';end if;
 today:=case when p_office_school_id is null then(clock_timestamp() at time zone 'Asia/Kolkata')::date else(p_calendar->>'today')::date end;
 month:=coalesce(p_month,date_trunc('month',today)::date);
 calendar_revision:=case when p_office_school_id is null then app_private.attendance_calendar_revision(school) else (p_calendar->>'revision')::bigint end;
 school_days:=p_calendar->'days';
 result:=jsonb_build_object('user_id',actor,'student_id',p_student_id,'school_id',school,'role',p_role,
  'server_today',today,'timezone','Asia/Kolkata','month',month,'calendar_revision',calendar_revision,'formula','daily-v1',
  'year',null,'month_summary',null,'year_summary',null);
 if p_office_school_id is not null then
  select * into year from jsonb_populate_record(null::public.academic_years,p_calendar->'year');
 elsif p_academic_year_id is null then
  perform 1 from public.academic_years where school_id=school and is_current order by id for share;
  if school is distinct from app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id) then
   raise exception 'You cannot view this student.' using errcode='42501';end if;
  select count(*) into count_years from public.academic_years where school_id=school and is_current;
  if count_years<>1 then return result||jsonb_build_object('session_state',case when count_years=0 then 'missing' else 'ambiguous' end);end if;
  select * into year from public.academic_years where school_id=school and is_current;
 else
  perform 1 from public.academic_years where school_id=school and(id=p_academic_year_id or is_current) order by id for share;
  if school is distinct from app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id) then
   raise exception 'You cannot view this student.' using errcode='42501';end if;
  select * into year from public.academic_years where school_id=school and id=p_academic_year_id;
  if not found then raise exception 'You cannot view this attendance year.' using errcode='42501';end if;
  if not isfinite(year.start_date) or not isfinite(year.end_date) or year.start_date<'0001-01-01'::date
   or year.end_date>'9999-12-31'::date or year.end_date<year.start_date then
   raise exception 'You cannot view this attendance year.' using errcode='42501';end if;
  if year.end_date-year.start_date>365 or year.start_date>today then
   raise exception 'You cannot view this attendance year.' using errcode='42501';end if;
  if year.is_current then
   if(select count(*) from public.academic_years where school_id=school and is_current)<>1 then
    raise exception 'You cannot view this attendance year.' using errcode='42501';end if;
  elsif year.end_date>=today or(p_office_school_id is null and not exists(select 1 from public.enrollments where student_id=p_student_id and academic_year_id=year.id and status in('active','withdrawn'))) then
   raise exception 'You cannot view this attendance year.' using errcode='42501';end if;
 end if;
 if not isfinite(year.start_date) or not isfinite(year.end_date) or year.end_date<year.start_date
  or year.start_date<'0001-01-01'::date or year.end_date>'9999-12-31'::date then
  return result||jsonb_build_object('session_state','unsupported');end if;
 year_json:=jsonb_build_object('id',year.id,'name',year.name,'start_date',year.start_date,'end_date',year.end_date);
 if year.end_date-year.start_date>365 then return result||jsonb_build_object('session_state','unsupported','year',year_json);end if;
 if p_month is null then month:=greatest(date_trunc('month',year.start_date)::date,
  least(month,date_trunc('month',year.end_date)::date));end if;
 if month>year.end_date or (month+interval '1 month')::date<=year.start_date then
  raise exception 'Choose a reporting month in the current academic year.' using errcode='22023';end if;
 result:=result||jsonb_build_object('session_state','active','year',year_json,'month',month);
 blank:=jsonb_build_object('from',null,'to',null,'enrollment_days',0,'working_days',0,'closed_days',0,'unconfigured_days',0,
  'marked_days',0,'unmarked_days',0,'invalid_days',0,'present_days',0,'late_days',0,'half_days',0,'leave_days',0,'absent_days',0,
  'earned_days',0,'percentage',null);
 if p_office_school_id is null then
  perform 1 from public.enrollments where student_id=p_student_id and academic_year_id=year.id order by id for share;
 end if;
  if school is distinct from app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id) then
   raise exception 'You cannot view this student.' using errcode='42501';end if;
 select count(*) into count_enrollments from public.enrollments where student_id=p_student_id and academic_year_id=year.id;
 if count_enrollments=0 then enrollment_state:='not_enrolled';
 elsif count_enrollments<>1 then enrollment_state:='enrollment_unverified';
 else
  select * into placement from public.enrollments where student_id=p_student_id and academic_year_id=year.id;
  -- Keep the roster's year -> enrollment -> student lock order.
  select * into student from public.students where id=p_student_id and school_id=school for share;
  if not found or school is distinct from app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id) then
   raise exception 'You cannot view this student.' using errcode='42501';end if;
  perform 1 from public.classes class join public.sections section on section.class_id=class.id and section.school_id=class.school_id
   where class.id=placement.class_id and class.school_id=school and section.id=placement.section_id for share of class,section;
  if not found or placement.status not in('active','withdrawn') or student.status not in('active','withdrawn')
   or(student.status='withdrawn' and placement.status='active' and not(p_academic_year_id is not null and not year.is_current
    and exists(select 1 from app_private.enrollment_withdrawals later
     join public.enrollments ended on ended.id=later.enrollment_id and ended.student_id=later.student_id
      and ended.academic_year_id=later.academic_year_id and ended.class_id=later.class_id and ended.section_id=later.section_id and ended.status='withdrawn'
     join public.academic_years later_year on later_year.id=ended.academic_year_id and later_year.school_id=later.school_id
     join public.classes later_class on later_class.id=ended.class_id and later_class.school_id=later.school_id
     join public.sections later_section on later_section.id=ended.section_id and later_section.class_id=later_class.id and later_section.school_id=later.school_id
     where later.school_id=school and later.student_id=p_student_id and later.enrollment_id<>placement.id
      and isfinite(later.withdrawn_at) and isfinite(later_year.start_date) and isfinite(later_year.end_date)
      and later_year.start_date>year.end_date and later_year.end_date>=later_year.start_date
      and(later.withdrawn_at at time zone 'Asia/Kolkata')::date>=later_year.start_date
      and(later.withdrawn_at at time zone 'Asia/Kolkata')::date<=today))) then enrollment_state:='enrollment_unverified';end if;
  if school is distinct from app_private.attendance_report_pupil_school(p_role,p_student_id,p_office_school_id) then
   raise exception 'You cannot view this student.' using errcode='42501';end if;
  select * into withdrawal from app_private.enrollment_withdrawals where enrollment_id=placement.id;
  if (placement.status='withdrawn' and(withdrawal.enrollment_id is null or withdrawal.school_id<>school
    or withdrawal.student_id<>p_student_id or withdrawal.academic_year_id<>year.id))
   or(placement.status='active' and withdrawal.enrollment_id is not null) then enrollment_state:='enrollment_unverified';end if;
  if p_academic_year_id is not null and not year.is_current and placement.status='withdrawn'
   and(withdrawal.class_id<>placement.class_id or withdrawal.section_id is distinct from placement.section_id
    or(withdrawal.withdrawn_at at time zone 'Asia/Kolkata')::date>today) then enrollment_state:='enrollment_unverified';end if;
  select count(distinct change.effective_date),max(change.effective_date),bool_or(change.school_id<>school or change.student_id<>p_student_id
    or change.destination_year_id<>year.id or not isfinite(change.effective_date)
    or change.effective_date not between year.start_date and year.end_date) into promotion_count,promotion_day,bad_promotion
   from app_private.roster_placement_changes change where change.destination_enrollment_id=placement.id and change.change_kind='promotion';
  if promotion_count>1 or coalesce(bad_promotion,false) or student.admission_date is not null and not isfinite(student.admission_date)
   or(student.admission_date is null and promotion_count=0) then enrollment_state:='enrollment_unverified';end if;
  -- enrolled_at records ingestion, not admission; never infer an old joining date from it.
  start_day:=greatest(year.start_date,coalesce(student.admission_date,promotion_day),promotion_day);
  end_day:=least(year.end_date,today,case when placement.status='withdrawn' then(withdrawal.withdrawn_at at time zone 'Asia/Kolkata')::date end);
  if placement.status='withdrawn' and (not isfinite(withdrawal.withdrawn_at)
    or(withdrawal.withdrawn_at at time zone 'Asia/Kolkata')::date<start_day) then enrollment_state:='enrollment_unverified';end if;
 end if;
 -- Office attribution needs a coherent audited move chain, not today's class label.
 if p_office_school_id is not null and count_enrollments=1 and enrollment_state is null then
  if exists(
   select 1 from(
    select change.*,lead(source_class_id) over(order by effective_date) as next_class,
     lead(source_section_id) over(order by effective_date) as next_section
    from app_private.roster_placement_changes change
    where change.change_kind='move' and(change.source_enrollment_id=placement.id or change.destination_enrollment_id=placement.id)
   ) change
   left join public.classes source_class on source_class.id=change.source_class_id and source_class.school_id=school
   left join public.sections source_section on source_section.id=change.source_section_id and source_section.class_id=source_class.id and source_section.school_id=school
   left join public.classes destination_class on destination_class.id=change.destination_class_id and destination_class.school_id=school
   left join public.sections destination_section on destination_section.id=change.destination_section_id and destination_section.class_id=destination_class.id and destination_section.school_id=school
   where change.school_id<>school or change.student_id<>p_student_id or change.source_enrollment_id<>placement.id
    or change.destination_enrollment_id<>placement.id or change.source_year_id<>year.id or change.destination_year_id<>year.id
    or not isfinite(change.effective_date) or change.effective_date not between start_day and end_day
    or source_section.id is null or destination_section.id is null
    or change.destination_class_id is distinct from coalesce(change.next_class,placement.class_id)
    or change.destination_section_id is distinct from coalesce(change.next_section,placement.section_id)
  ) then enrollment_state:='enrollment_unverified';end if;
 end if;
 if enrollment_state is not null then return result||jsonb_build_object(
  'month_summary',blank||jsonb_build_object('state',enrollment_state),'year_summary',blank||jsonb_build_object('state',enrollment_state));end if;

 with days as materialized(
  select day,calendar,
   attendance.id is not null as marked,
   attendance.status::text as status,
   attendance.id is not null and(attendance.school_id<>school or attendance.academic_year_id<>year.id
    or attendance.section_id is distinct from coalesce(move.source_section_id,placement.section_id)
    or attendance.status::text not in('present','late','half_day','leave','absent')) as invalid
  from generate_series(0,greatest(end_day-start_day,-1)) offset_day
  cross join lateral(select start_day+offset_day as day) date
  cross join lateral(select case when p_office_school_id is null then app_private.resolve_attendance_calendar_day(school,day)
   else school_days->day::text end as calendar) resolved
  left join public.attendance attendance on attendance.student_id=p_student_id and attendance.attendance_date=day
  left join lateral(select change.source_class_id,change.source_section_id from app_private.roster_placement_changes change
   where change.school_id=school and change.source_enrollment_id=placement.id and change.change_kind='move'
    and change.effective_date>day order by change.effective_date limit 1) move on true
  where(p_class_id is null or coalesce(move.source_class_id,placement.class_id)=p_class_id)
   and(p_section_id is null or coalesce(move.source_section_id,placement.section_id)=p_section_id)
 ),totals as(
  select period,min(day) as first_day,max(day) as last_day,count(day)::integer as enrollment_days,
   count(*) filter(where(calendar->>'is_working')::boolean)::integer as working_days,
   count(*) filter(where(calendar->>'is_working')::boolean=false)::integer as closed_days,
   count(*) filter(where(calendar->>'configured')::boolean=false)::integer as unconfigured_days,
   count(*) filter(where(calendar->>'is_working')::boolean and marked and not invalid)::integer as marked_days,
   count(*) filter(where(calendar->>'is_working')::boolean and not marked)::integer as unmarked_days,
   count(*) filter(where(calendar->>'is_working')::boolean and invalid)::integer as invalid_days,
   count(*) filter(where(calendar->>'is_working')::boolean and not invalid and status='present')::integer as present_days,
   count(*) filter(where(calendar->>'is_working')::boolean and not invalid and status='late')::integer as late_days,
   count(*) filter(where(calendar->>'is_working')::boolean and not invalid and status='half_day')::integer as half_days,
   count(*) filter(where(calendar->>'is_working')::boolean and not invalid and status='leave')::integer as leave_days,
   count(*) filter(where(calendar->>'is_working')::boolean and not invalid and status='absent')::integer as absent_days
  from(values('month',month,least((month+interval '1 month')::date-1,today)),('year',year.start_date,least(year.end_date,today))) periods(period,first,last)
  left join days on day between first and last group by period
 ),earned as(select *,present_days+late_days+half_days*0.5 as earned_days from totals)
 select jsonb_object_agg(period,jsonb_build_object('from',first_day,'to',last_day,'enrollment_days',enrollment_days,
  'working_days',working_days,'closed_days',closed_days,'unconfigured_days',unconfigured_days,'marked_days',marked_days,
  'unmarked_days',unmarked_days,'invalid_days',invalid_days,'present_days',present_days,'late_days',late_days,'half_days',half_days,
  'leave_days',leave_days,'absent_days',absent_days,'earned_days',earned_days,
  'percentage',case when invalid_days=0 and unconfigured_days=0 and unmarked_days=0 and working_days>0 then round(earned_days*100/working_days,2) end,
  'state',case when enrollment_days=0 then 'not_started' when invalid_days>0 then 'inconsistent'
   when unconfigured_days>0 then 'calendar_unconfigured' when unmarked_days>0 then 'attendance_incomplete'
   when working_days>0 then 'complete' else 'no_working_days' end)) into periods from earned;
 return result||jsonb_build_object('month_summary',periods->'month','year_summary',periods->'year');
end;
$$;

create or replace function app_private.calculate_family_attendance_summary(p_role text,p_student_id uuid,p_academic_year_id uuid,p_month date)
returns jsonb language sql volatile security definer set search_path=''
as $$select app_private.calculate_attendance_report_pupil(p_role,p_student_id,p_academic_year_id,p_month,null,null,null,null);$$;

create function app_private.get_office_attendance_report_context(p_school_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare school uuid:=p_school_id;actor uuid;today date;current_id uuid;begin
 if school is null then select school_id into school from public.profiles where id=auth.uid() and is_active;end if;
 actor:=app_private.office_attendance_report_actor(school);
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||school::text,0));
 perform app_private.office_attendance_report_actor(school);
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 if(select count(*) from public.academic_years where school_id=school and is_current)=1 then
  select id into current_id from public.academic_years where school_id=school and is_current;end if;
 return jsonb_build_object('user_id',actor,'school_id',school,'school_name',(select name from public.schools where id=school),
  'schools',(select jsonb_build_array(jsonb_build_object('id',id,'name',name)) from public.schools where id=school),
  'server_today',today,'timezone','Asia/Kolkata','calendar_revision',app_private.attendance_calendar_revision(school),'current_year_id',current_id,
  'years',coalesce((select jsonb_agg(jsonb_build_object('id',y.id,'name',y.name,'start_date',y.start_date,'end_date',y.end_date,'is_current',y.is_current)
    order by y.is_current desc,y.start_date desc,y.id) from public.academic_years y
    where y.school_id=school and((y.id=current_id and y.start_date<=today) or(not y.is_current and y.end_date<today))
     and case when isfinite(y.start_date) and isfinite(y.end_date) and y.start_date>=date '0001-01-01' and y.end_date<=date '9999-12-31'
      then y.end_date-y.start_date between 0 and 365 else false end),'[]'::jsonb),
  'classes',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name,id) from public.classes where school_id=school),'[]'::jsonb),
  'sections',coalesce((select jsonb_agg(jsonb_build_object('id',id,'class_id',class_id,'name',name) order by name,id) from public.sections where school_id=school),'[]'::jsonb));
end;$$;

create function app_private.get_office_attendance_report(p_school_id uuid,p_academic_year_id uuid,p_month date default null,p_class_id uuid default null,p_section_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.office_attendance_report_actor(p_school_id);year public.academic_years%rowtype;
 today date;month date;calendar jsonb;pupils uuid[];periods jsonb;revision bigint;result jsonb;class_name text;section_name text;report_pupils integer;
begin
 if p_section_id is not null and p_class_id is null then raise exception 'Select a class before selecting a section.' using errcode='22023';end if;
 if p_month is not null and(not isfinite(p_month) or p_month<date '0001-01-01' or p_month>date '9999-12-01' or extract(day from p_month)<>1) then
  raise exception 'Select the first day of a valid reporting month.' using errcode='22023';end if;
 -- A short report snapshot fences governed manual/gate/correction writes, including new marks.
 perform pg_advisory_xact_lock(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 perform app_private.office_attendance_report_actor(p_school_id);
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 perform 1 from public.academic_years where school_id=p_school_id and(id=p_academic_year_id or is_current) order by id for share;
 perform app_private.office_attendance_report_actor(p_school_id);
 select * into year from public.academic_years where id=p_academic_year_id and school_id=p_school_id;
 if not found or not isfinite(year.start_date) or not isfinite(year.end_date) or year.start_date<date '0001-01-01' or year.end_date>date '9999-12-31'
  or year.end_date-year.start_date not between 0 and 365 or year.start_date>today
  or(year.is_current and(select count(*) from public.academic_years where school_id=p_school_id and is_current)<>1)
  or(not year.is_current and year.end_date>=today) then
  raise exception 'Select a supported current or completed academic year in this school.' using errcode='42501';end if;
 month:=coalesce(p_month,greatest(date_trunc('month',year.start_date)::date,least(date_trunc('month',today)::date,date_trunc('month',year.end_date)::date)));
 if month>least(year.end_date,today) or(month+interval '1 month')::date<=year.start_date then
  raise exception 'Select an elapsed reporting month within this academic year.' using errcode='22023';end if;
 if p_class_id is not null then
  select name into class_name from public.classes where id=p_class_id and school_id=p_school_id for share;
  if not found then raise exception 'Select a class in this school.' using errcode='42501';end if;
 end if;
 if p_section_id is not null then
  select name into section_name from public.sections where id=p_section_id and class_id=p_class_id and school_id=p_school_id for share;
  if not found then raise exception 'Select a section in the chosen class.' using errcode='42501';end if;
 end if;
 -- The cohort is linearized here; later admissions appear on the next report, never as a partial pupil.
 if exists(select 1 from public.enrollments e where e.academic_year_id=year.id and not exists(
   select 1 from public.students s where s.id=e.student_id and s.school_id=p_school_id))
  or exists(select 1 from public.attendance a where a.school_id=p_school_id and(a.academic_year_id=year.id
   or a.attendance_date between year.start_date and least(year.end_date,today)) and not exists(
   select 1 from public.students s where s.id=a.student_id and s.school_id=p_school_id)) then
  raise exception 'School enrollment or attendance identity mapping needs review.' using errcode='22023';end if;
 select coalesce(array_agg(id order by id),'{}'::uuid[]) into pupils from(
  select s.id from public.students s where s.school_id=p_school_id
   and(exists(select 1 from public.enrollments e where e.student_id=s.id and e.academic_year_id=year.id and e.status not in('staged','cancelled'))
    or exists(select 1 from public.attendance a where a.student_id=s.id and(a.academic_year_id=year.id
     or a.attendance_date between year.start_date and least(year.end_date,today))))

 ) candidates;
 if cardinality(pupils)>5000 then raise exception 'This school-year cohort exceeds the 5,000-pupil reporting limit. Contact the school office.' using errcode='54000';end if;
 perform 1 from public.enrollments where academic_year_id=year.id and student_id=any(pupils) order by id for share;
 perform app_private.office_attendance_report_actor(p_school_id);
 perform 1 from public.students where id=any(pupils) order by id for share;
 perform 1 from public.classes where school_id=p_school_id order by id for share;
 perform 1 from public.sections where school_id=p_school_id order by id for share;
 perform app_private.office_attendance_report_actor(p_school_id);
 revision:=app_private.attendance_calendar_revision(p_school_id);
 with resolved as materialized(select year.start_date+n as day,app_private.resolve_attendance_calendar_day(p_school_id,year.start_date+n) as calendar
  from generate_series(0,least(year.end_date,today)-year.start_date) n)
 select jsonb_build_object('revision',revision,'today',today,'year',to_jsonb(year),'days',coalesce(jsonb_object_agg(day::text,
  jsonb_build_object('configured',resolved.calendar->'configured','is_working',resolved.calendar->'is_working')),'{}'::jsonb)) into calendar from resolved;
 with reports as materialized(
  select pupil,app_private.calculate_attendance_report_pupil('office',pupil,year.id,month,p_school_id,p_class_id,p_section_id,calendar) as data from unnest(pupils) pupil
 ),relevant as materialized(
  select * from reports r where p_class_id is null or r.data->'year_summary'->>'state'='enrollment_unverified'
   or exists(select 1 from public.enrollments e where e.student_id=r.pupil and e.academic_year_id=year.id
    and(e.class_id=p_class_id and(p_section_id is null or e.section_id=p_section_id)
     or exists(select 1 from app_private.roster_placement_changes ch where ch.change_kind='move'
      and(ch.source_enrollment_id=e.id or ch.destination_enrollment_id=e.id)
      and((ch.source_class_id=p_class_id and(p_section_id is null or ch.source_section_id=p_section_id))
       or(ch.destination_class_id=p_class_id and(p_section_id is null or ch.destination_section_id=p_section_id))))))
   or r.data->'year_summary'->>'state'='not_enrolled'
 ),pieces as materialized(
  select r.pupil,p.period,case when r.data->p.period->>'state'='not_enrolled' then jsonb_set(r.data->p.period,'{state}','"enrollment_unverified"')
   else r.data->p.period end as data from relevant r cross join(values('month_summary'),('year_summary')) p(period)
 ),totals as(
  select period,min((data->>'from')::date) as first_day,max((data->>'to')::date) as last_day,
   count(*) filter(where(data->>'enrollment_days')::integer>0 or data->>'state'='enrollment_unverified')::integer as pupil_count,
   count(*) filter(where data->>'state' in('complete','no_working_days') and(data->>'enrollment_days')::integer>0)::integer as complete_pupils,
   count(*) filter(where data->>'state' in('enrollment_unverified','inconsistent','calendar_unconfigured','attendance_incomplete'))::integer as incomplete_pupils,
   count(*) filter(where data->>'state'='enrollment_unverified')::integer as unverified_pupils,
   coalesce(sum((data->>'enrollment_days')::integer),0)::integer as enrollment_days,
   coalesce(sum((data->>'working_days')::integer),0)::integer as working_days,
   coalesce(sum((data->>'closed_days')::integer),0)::integer as closed_days,
   coalesce(sum((data->>'unconfigured_days')::integer),0)::integer as unconfigured_days,
   coalesce(sum((data->>'marked_days')::integer),0)::integer as marked_days,
   coalesce(sum((data->>'unmarked_days')::integer),0)::integer as unmarked_days,
   coalesce(sum((data->>'invalid_days')::integer),0)::integer as invalid_days,
   coalesce(sum((data->>'present_days')::integer),0)::integer as present_days,
   coalesce(sum((data->>'late_days')::integer),0)::integer as late_days,
   coalesce(sum((data->>'half_days')::integer),0)::integer as half_days,
   coalesce(sum((data->>'leave_days')::integer),0)::integer as leave_days,
   coalesce(sum((data->>'absent_days')::integer),0)::integer as absent_days,
   coalesce(sum((data->>'earned_days')::numeric),0) as earned_days
  from(values('month_summary'),('year_summary')) periods(period) left join pieces using(period) group by period
 ) select jsonb_object_agg(period,(to_jsonb(t)-'period'-'first_day'-'last_day')||jsonb_build_object('from',first_day,'to',last_day,
  'percentage',case when unverified_pupils=0 and invalid_days=0 and unconfigured_days=0 and unmarked_days=0 and working_days>0 then round(earned_days*100/working_days,2) end,
  'state',case when not exists(select 1 from relevant) then 'no_pupils' when unverified_pupils>0 then 'enrollment_unverified' when invalid_days>0 then 'inconsistent'
   when unconfigured_days>0 then 'calendar_unconfigured' when unmarked_days>0 then 'attendance_incomplete'
   when working_days>0 then 'complete' when enrollment_days>0 then 'no_working_days' else 'not_started' end)),(select count(*)::integer from relevant) into periods,report_pupils from totals t;
 perform app_private.office_attendance_report_actor(p_school_id);
 result:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'school_name',(select name from public.schools where id=p_school_id),
  'server_today',today,'timezone','Asia/Kolkata','calendar_revision',revision,'formula','daily-v1','month',month,
  'year',jsonb_build_object('id',year.id,'name',year.name,'start_date',year.start_date,'end_date',year.end_date),
  'scope',jsonb_build_object('class_id',p_class_id,'class_name',class_name,'section_id',p_section_id,'section_name',section_name),
  'pupil_count',report_pupils,'month_summary',periods->'month_summary','year_summary',periods->'year_summary');
 return result;
end;$$;

create function public.get_office_attendance_report_context(p_school_id uuid default null)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.get_office_attendance_report_context(p_school_id);$$;
create function public.get_office_attendance_report(p_school_id uuid,p_academic_year_id uuid,p_month date default null,p_class_id uuid default null,p_section_id uuid default null)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.get_office_attendance_report(p_school_id,p_academic_year_id,p_month,p_class_id,p_section_id);$$;

revoke all on function app_private.office_attendance_report_actor(uuid),app_private.attendance_report_pupil_school(text,uuid,uuid),
 app_private.calculate_attendance_report_pupil(text,uuid,uuid,date,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
do $permissions$declare signature text;begin
 foreach signature in array array['get_office_attendance_report_context(uuid)','get_office_attendance_report(uuid,uuid,date,uuid,uuid)'] loop
  execute 'revoke all on function public.'||signature||',app_private.'||signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function public.'||signature||',app_private.'||signature||' to authenticated';
 end loop;
end;$permissions$;
commit;
