begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog,public,extensions;

-- A removed or re-pointed assignment used to leave live periods that still held the
-- teacher_overlap constraint while staying hidden from the teacher view.
create function app_private.retire_assignment_timetable_periods()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=auth.uid();
  before_row public.timetables%rowtype;
  after_row public.timetables%rowtype;
begin
  -- Trusted writers without a signed-in profile (owner, service role) leave the periods
  -- marked Needs attention for office repair; the conflict message names them.
  if actor is null or not exists(select 1 from public.profiles p where p.id=actor) then return null; end if;
  for before_row in select p.* from public.timetables p where p.assignment_id=old.id and p.deleted_at is null
      and(tg_op='DELETE'
        or(new.academic_year_id,new.class_id,new.teacher_id,new.subject_id) is distinct from(p.academic_year_id,p.class_id,p.teacher_id,p.subject_id)
        or(new.section_id is not null and new.section_id is distinct from p.section_id))
      order by p.id for update loop
    update public.timetables set deleted_at=clock_timestamp(),deleted_by=actor where id=before_row.id returning * into after_row;
    insert into app_private.timetable_write_receipts(actor_id,request_id,operation,period_id,payload,before_record,after_record)
      values(actor,gen_random_uuid(),'remove',before_row.id,
        jsonb_build_object('school',before_row.school_id,'period',before_row.id,'version',before_row.version,
          'assignment',old.id,'reason','assignment_'||pg_catalog.lower(tg_op)),
        to_jsonb(before_row),to_jsonb(after_row));
  end loop;
  return null;
end;
$function$;
create trigger retire_assignment_timetable_periods
after update of academic_year_id,class_id,section_id,teacher_id,subject_id or delete on public.teacher_subject_assignments
for each row execute function app_private.retire_assignment_timetable_periods();

-- Lets the assignment manager show which periods a removal or re-point retires.
create function app_private.get_assignment_timetable_periods(p_school_id uuid,p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $function$
begin
  perform app_private.timetable_actor();
  if not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot view this school timetable.' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'class_name',p.class_name,'section_name',p.section_name,
      'day_of_week',p.day_of_week,'period_no',p.period_no,'start_time',p.start_time,'end_time',p.end_time)
      order by p.day_of_week,p.start_time nulls last,p.period_no,p.id)
    from app_private.timetable_periods p where p.school_id=p_school_id and p.assignment_id=p_assignment_id and p.deleted_at is null),'[]'::jsonb);
end;
$function$;
create function public.get_assignment_timetable_periods(p_school_id uuid,p_assignment_id uuid)
returns jsonb language sql security invoker set search_path=''
as $function$ select app_private.get_assignment_timetable_periods(p_school_id,p_assignment_id); $function$;

create or replace function app_private.save_timetable_period(
  p_school_id uuid,p_period_id uuid,p_expected_version uuid,p_assignment_id uuid,p_section_id uuid,
  p_day_of_week integer,p_period_no integer,p_start_time time,p_end_time time,p_room text,p_request_id uuid
)
returns uuid language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=app_private.timetable_actor();
  room_text text:=nullif(pg_catalog.btrim(p_room),'');
  request_payload jsonb:=jsonb_build_object('school',p_school_id,'period',p_period_id,'version',p_expected_version,
    'assignment',p_assignment_id,'section',p_section_id,'day',p_day_of_week,'period_no',p_period_no,
    'start',p_start_time,'end',p_end_time,'room',room_text);
  receipt app_private.timetable_write_receipts%rowtype;
  assignment public.teacher_subject_assignments%rowtype;
  expected_assignment public.teacher_subject_assignments%rowtype;
  teacher_profile uuid;
  before_row public.timetables%rowtype;
  after_row public.timetables%rowtype;
  conflict_name text;
  blocker record;
begin
  if not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot schedule periods for this school.' using errcode='42501'; end if;
  if p_request_id is null or(p_period_id is null)<>(p_expected_version is null) or p_assignment_id is null
    or p_day_of_week is null or p_day_of_week not between 1 and 7 or p_period_no is null or p_period_no<=0
    or p_start_time is null or p_end_time is null or p_start_time>=p_end_time or p_end_time>='24:00'::time
    or extract(second from p_start_time)<>0 or extract(second from p_end_time)<>0
    or pg_catalog.char_length(room_text)>120 or room_text~'[[:cntrl:]]' then
    raise exception 'Choose a valid assignment, day, positive period number, ordered whole-minute times and room up to 120 characters.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('timetable-intent:'||actor::text||':'||p_request_id::text,0));
  select * into receipt from app_private.timetable_write_receipts r where r.actor_id=actor and r.request_id=p_request_id;
  if found then
    perform app_private.lock_timetable_office(p_school_id);
    if receipt.operation<>'save' or receipt.payload<>request_payload then
      raise exception 'This request reference already has a different timetable action.' using errcode='PT409'; end if;
    return receipt.period_id;
  end if;
  select a.* into expected_assignment from public.teacher_subject_assignments a
    join public.teachers t on t.id=a.teacher_id and t.school_id=p_school_id where a.id=p_assignment_id;
  if not found then raise exception 'The teaching assignment is unavailable.' using errcode='42501'; end if;
  select t.profile_id into teacher_profile from public.teachers t where t.id=expected_assignment.teacher_id and t.school_id=p_school_id;
  if teacher_profile is null then raise exception 'The teaching assignment is unavailable.' using errcode='42501'; end if;
  perform app_private.lock_timetable_office(p_school_id,teacher_profile);
  -- Match academic activation's year-before-assignment/placement lock order.
  perform 1 from public.academic_years y where y.id=expected_assignment.academic_year_id and y.school_id=p_school_id for share;
  if not found then raise exception 'The academic year is unavailable.' using errcode='42501'; end if;
  select a.* into assignment from public.teacher_subject_assignments a join public.teachers t on t.id=a.teacher_id
    where a.id=p_assignment_id and t.school_id=p_school_id and t.profile_id=teacher_profile
      and(a.academic_year_id,a.class_id,a.section_id,a.teacher_id,a.subject_id) is not distinct from
        (expected_assignment.academic_year_id,expected_assignment.class_id,expected_assignment.section_id,expected_assignment.teacher_id,expected_assignment.subject_id)
    for share of a,t;
  if not found or not app_private.timetable_assignment_valid(assignment)
    or(assignment.section_id is not null and assignment.section_id is distinct from p_section_id) then
    raise exception 'Use an active teacher and its exact class, section and subject assignment.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=teacher_profile and ur.school_id=p_school_id and ur.role='teacher' for share;
  if not found then raise exception 'The teacher role is unavailable.' using errcode='42501'; end if;
  perform 1 from public.classes c where c.id=assignment.class_id and c.school_id=p_school_id and c.is_active for share;
  if not found then raise exception 'The class is unavailable.' using errcode='42501'; end if;
  perform 1 from public.subjects sub where sub.id=assignment.subject_id and sub.school_id=p_school_id and sub.is_active for share;
  if not found then raise exception 'The subject is unavailable.' using errcode='42501'; end if;
  if p_section_id is not null then
    perform 1 from public.sections sec where sec.id=p_section_id and sec.class_id=assignment.class_id and sec.school_id=p_school_id for share;
    if not found then raise exception 'The section is outside this class.' using errcode='42501'; end if;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('timetable-school:'||p_school_id::text,0));
  if p_period_id is not null then
    select * into before_row from public.timetables p where p.id=p_period_id and p.school_id=p_school_id for update;
    if not found then raise exception 'The timetable period is unavailable.' using errcode='42501'; end if;
    if before_row.deleted_at is not null or before_row.version<>p_expected_version then
      raise exception 'This period changed or was removed. Refresh and review your draft.' using errcode='PT409'; end if;
    if(before_row.academic_year_id,before_row.class_id) is distinct from(assignment.academic_year_id,assignment.class_id) then
      raise exception 'Remove and recreate a period to change its year or class.' using errcode='22023'; end if;
  end if;
  if exists(select 1 from public.timetables p where p.school_id=p_school_id and p.academic_year_id=assignment.academic_year_id
    and p.deleted_at is null and p.id is distinct from p_period_id and p.day_of_week=p_day_of_week
    and(p.start_time is null or p.end_time is null or p.start_time>=p.end_time)
    and(p.teacher_id=assignment.teacher_id or(p.class_id=assignment.class_id and(p.section_id is null or p_section_id is null or p.section_id=p_section_id)))) then
    raise exception 'An incomplete older period reserves this teacher or class day. Repair or remove it first.' using errcode='PT409'; end if;
  if p_period_id is null then
    insert into public.timetables(school_id,academic_year_id,class_id,section_id,assignment_id,teacher_id,subject_id,day_of_week,period_no,start_time,end_time,room)
      values(p_school_id,assignment.academic_year_id,assignment.class_id,p_section_id,p_assignment_id,assignment.teacher_id,assignment.subject_id,
        p_day_of_week,p_period_no,p_start_time,p_end_time,room_text) returning * into after_row;
  else
    update public.timetables set section_id=p_section_id,assignment_id=p_assignment_id,teacher_id=assignment.teacher_id,subject_id=assignment.subject_id,
      day_of_week=p_day_of_week,period_no=p_period_no,start_time=p_start_time,end_time=p_end_time,room=room_text
      where id=p_period_id returning * into after_row;
  end if;
  insert into app_private.timetable_write_receipts(actor_id,request_id,operation,period_id,payload,before_record,after_record)
    values(actor,p_request_id,'save',after_row.id,request_payload,case when p_period_id is null then null else to_jsonb(before_row) end,to_jsonb(after_row));
  return after_row.id;
exception when exclusion_violation then
  get stacked diagnostics conflict_name=constraint_name;
  -- Name the blocker: it may be a Needs attention period hidden from the teacher view.
  if conflict_name='timetable_teacher_overlap' then
    select p.class_name,p.section_name,p.period_no,p.start_time,p.end_time,p.needs_attention into blocker
      from app_private.timetable_periods p where p.school_id=p_school_id and p.academic_year_id=assignment.academic_year_id
        and p.teacher_id=assignment.teacher_id and p.day_of_week=p_day_of_week and p.deleted_at is null
        and p.id is distinct from p_period_id and p.start_time<p_end_time and p.end_time>p_start_time
      order by p.start_time,p.id limit 1;
    if found then
      raise exception using errcode='PT409',message=pg_catalog.format(
        'This teacher already has %s%s period %s (%s–%s) on this day%s. Open that class timetable to move or remove it.',
        blocker.class_name,coalesce(' / '||blocker.section_name,' (whole class)'),blocker.period_no,
        pg_catalog.to_char(blocker.start_time,'HH24:MI'),pg_catalog.to_char(blocker.end_time,'HH24:MI'),
        case when blocker.needs_attention then ', marked Needs attention because its teaching assignment or teacher changed' else '' end);
    end if;
  end if;
  raise exception using errcode='PT409',message=case conflict_name
    when 'timetable_teacher_overlap' then 'This teacher already has an overlapping period in this session and day.'
    when 'timetable_duplicate_period' then 'This class or section already has that period number on this day.'
    else 'This class or section already has an overlapping period in this session and day.' end;
end;
$function$;

revoke all on function app_private.retire_assignment_timetable_periods() from public,anon,authenticated,service_role;
revoke all on function public.get_assignment_timetable_periods(uuid,uuid),app_private.get_assignment_timetable_periods(uuid,uuid),
  app_private.save_timetable_period(uuid,uuid,uuid,uuid,uuid,integer,integer,time,time,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_assignment_timetable_periods(uuid,uuid),app_private.get_assignment_timetable_periods(uuid,uuid),
  app_private.save_timetable_period(uuid,uuid,uuid,uuid,uuid,integer,integer,time,time,text,uuid)
  to authenticated;

commit;
