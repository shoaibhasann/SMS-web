begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function app_private.get_family_attendance_summary(p_role text,p_student_id uuid,p_month date default null)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare
 actor uuid;school uuid;student public.students%rowtype;year public.academic_years%rowtype;
 placement public.enrollments%rowtype;withdrawal app_private.enrollment_withdrawals%rowtype;
 today date;month date;year_json jsonb;result jsonb;periods jsonb;blank jsonb;
 count_years integer;count_enrollments integer;promotion_count integer;promotion_day date;bad_promotion boolean;
 start_day date;end_day date;enrollment_state text;calendar_revision bigint;
begin
 -- Reuse the native-session, actual-role and current own/linked-child checks.
 school:=app_private.family_notification_student_school(p_role,p_student_id);actor:=auth.uid();
 if not app_private.staff_mfa_allowed() then raise exception 'Verify your account authenticator.' using errcode='42501';end if;
 perform 1 from public.schools where id=school and is_active for share;
 if not found then raise exception 'Current family school access is required.' using errcode='42501';end if;
 if p_month is not null and(not isfinite(p_month) or p_month<'0001-01-01'::date or p_month>'9999-12-01'::date or extract(day from p_month)<>1) then
  raise exception 'Choose the first day of a valid reporting month.' using errcode='22023';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||school::text,0));
 if not app_private.staff_mfa_allowed() or school is distinct from app_private.family_notification_student_school(p_role,p_student_id) then
  raise exception 'You cannot view this student.' using errcode='42501';end if;
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 month:=coalesce(p_month,date_trunc('month',today)::date);
 calendar_revision:=app_private.attendance_calendar_revision(school);
 result:=jsonb_build_object('user_id',actor,'student_id',p_student_id,'school_id',school,'role',p_role,
  'server_today',today,'timezone','Asia/Kolkata','month',month,'calendar_revision',calendar_revision,'formula','daily-v1',
  'year',null,'month_summary',null,'year_summary',null);
 perform 1 from public.academic_years where school_id=school and is_current order by id for share;
 select count(*) into count_years from public.academic_years where school_id=school and is_current;
 if count_years<>1 then return result||jsonb_build_object('session_state',case when count_years=0 then 'missing' else 'ambiguous' end);end if;
 select * into year from public.academic_years where school_id=school and is_current;
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
 perform 1 from public.enrollments where student_id=p_student_id and academic_year_id=year.id order by id for share;
 select count(*) into count_enrollments from public.enrollments where student_id=p_student_id and academic_year_id=year.id;
 if count_enrollments=0 then enrollment_state:='not_enrolled';
 elsif count_enrollments<>1 then enrollment_state:='enrollment_unverified';
 else
  select * into placement from public.enrollments where student_id=p_student_id and academic_year_id=year.id;
  -- Keep the roster's year -> enrollment -> student lock order.
  select * into student from public.students where id=p_student_id and school_id=school for share;
  if not found or not app_private.staff_mfa_allowed() or school is distinct from app_private.family_notification_student_school(p_role,p_student_id) then
   raise exception 'You cannot view this student.' using errcode='42501';end if;
  perform 1 from public.classes class join public.sections section on section.class_id=class.id and section.school_id=class.school_id
   where class.id=placement.class_id and class.school_id=school and section.id=placement.section_id for share of class,section;
  if not found or placement.status not in('active','withdrawn') or student.status not in('active','withdrawn') then enrollment_state:='enrollment_unverified';end if;
  select * into withdrawal from app_private.enrollment_withdrawals where enrollment_id=placement.id;
  if (placement.status='withdrawn' and(withdrawal.enrollment_id is null or withdrawal.school_id<>school
    or withdrawal.student_id<>p_student_id or withdrawal.academic_year_id<>year.id))
   or(placement.status='active' and withdrawal.enrollment_id is not null) then enrollment_state:='enrollment_unverified';end if;
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
  cross join lateral(select app_private.resolve_attendance_calendar_day(school,day) as calendar) resolved
  left join public.attendance attendance on attendance.student_id=p_student_id and attendance.attendance_date=day
  left join lateral(select change.source_section_id from app_private.roster_placement_changes change
   where change.school_id=school and change.source_enrollment_id=placement.id and change.change_kind='move'
    and change.effective_date>day order by change.effective_date limit 1) move on true
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

create function public.get_family_attendance_summary(p_role text,p_student_id uuid,p_month date default null)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.get_family_attendance_summary(p_role,p_student_id,p_month);$$;
revoke all on function app_private.get_family_attendance_summary(text,uuid,date),public.get_family_attendance_summary(text,uuid,date)
 from public,anon,authenticated,service_role;
grant execute on function app_private.get_family_attendance_summary(text,uuid,date),public.get_family_attendance_summary(text,uuid,date) to authenticated;
commit;
