begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog,public,extensions;

create extension if not exists btree_gist with schema extensions;
alter table public.timetables add column assignment_id uuid,
  add column version uuid not null default gen_random_uuid(),
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles(id);

-- NULL section means the entire class. An unbounded UUID range overlaps every
-- singleton section without hashing identifiers or guessing their ordering.
create type app_private.timetable_section_range as range(subtype=uuid);
revoke all on type app_private.timetable_section_range from public,anon,authenticated,service_role;

-- Constraints arbitrate concurrent writes, including transaction snapshots
-- where a preceding availability query cannot see a competing booking.
alter table public.timetables add constraint timetable_teacher_overlap
  exclude using gist(school_id with =,academic_year_id with =,teacher_id with =,day_of_week with =,
    (numrange(extract(epoch from start_time),extract(epoch from end_time),'[)')) with &&)
  where (deleted_at is null and start_time is not null and end_time is not null and start_time<end_time);
alter table public.timetables add constraint timetable_class_overlap
  exclude using gist(school_id with =,academic_year_id with =,class_id with =,day_of_week with =,
    (app_private.timetable_section_range(section_id,section_id,'[]')) with &&,
    (numrange(extract(epoch from start_time),extract(epoch from end_time),'[)')) with &&)
  where (deleted_at is null and start_time is not null and end_time is not null and start_time<end_time);
alter table public.timetables add constraint timetable_duplicate_period
  exclude using gist(school_id with =,academic_year_id with =,class_id with =,day_of_week with =,period_no with =,
    (app_private.timetable_section_range(section_id,section_id,'[]')) with &&)
  where (deleted_at is null);
create index timetable_school_week on public.timetables(school_id,academic_year_id,class_id,day_of_week,start_time,id)
  where deleted_at is null;

create table app_private.timetable_write_receipts(
  actor_id uuid not null references public.profiles(id),request_id uuid not null,
  operation text not null check(operation in ('save','remove')),
  period_id uuid not null,payload jsonb not null,before_record jsonb,after_record jsonb not null,
  created_at timestamptz not null default clock_timestamp(),primary key(actor_id,request_id)
);
alter table app_private.timetable_write_receipts enable row level security;
revoke all on table app_private.timetable_write_receipts from public,anon,authenticated,service_role;
revoke all on table public.timetables from public,anon,authenticated,service_role;
do $acl$
declare col record;
begin
  for col in select attname from pg_catalog.pg_attribute where attrelid='public.timetables'::regclass
    and attnum>0 and not attisdropped loop
    execute pg_catalog.format('revoke all(%I) on public.timetables from public,anon,authenticated,service_role',col.attname);
  end loop;
end;
$acl$;

create function app_private.timetable_actor()
returns uuid language plpgsql security definer set search_path=''
as $function$
declare actor uuid:=auth.uid();
begin
  perform 1 from auth.users u where u.id=actor and not coalesce(u.is_anonymous,false)
    and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
    and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null) for share;
  if not found or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then
    raise exception 'An active verified account is required.' using errcode='42501';
  end if;
  return actor;
end;
$function$;

create function app_private.lock_timetable_office(p_school_id uuid,p_teacher_profile uuid default null)
returns void language plpgsql security definer set search_path=''
as $function$
begin
  -- Role assignment locks actor/target profiles in this same stable order.
  perform 1 from public.profiles p where p.id in(auth.uid(),p_teacher_profile) order by p.id for share;
  if not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[])
    or (p_teacher_profile is not null and not exists(select 1 from public.profiles p where p.id=p_teacher_profile and p.is_active)) then
    raise exception 'You cannot schedule periods for this school or teacher.' using errcode='42501';
  end if;
  perform 1 from public.user_roles ur where ur.user_id=auth.uid() and
    ((ur.school_id=p_school_id and ur.role in('school_admin','principal')) or(ur.school_id is null and ur.role='super_admin'))
    order by ur.id for share;
  if not found then raise exception 'You cannot schedule periods for this school.' using errcode='42501'; end if;
end;
$function$;

create function app_private.timetable_assignment_valid(p public.teacher_subject_assignments)
returns boolean language sql stable security definer set search_path=''
as $function$
  select exists(select 1 from public.teachers t
    join public.profiles profile on profile.id=t.profile_id and profile.is_active and profile.school_id=t.school_id
    join public.user_roles ur on ur.user_id=profile.id and ur.school_id=t.school_id and ur.role='teacher'
    join public.academic_years y on y.id=p.academic_year_id and y.school_id=t.school_id
    join public.classes c on c.id=p.class_id and c.school_id=t.school_id and c.is_active
    join public.subjects sub on sub.id=p.subject_id and sub.school_id=t.school_id and sub.is_active
    where t.id=p.teacher_id and isfinite(y.start_date) and isfinite(y.end_date) and y.start_date<=y.end_date
      and(p.section_id is null or exists(select 1 from public.sections sec
        where sec.id=p.section_id and sec.school_id=t.school_id and sec.class_id=c.id)));
$function$;

create view app_private.timetable_periods with(security_invoker=true) as
select period.*,c.name as class_name,sec.name as section_name,sub.name as subject_name,
  coalesce(nullif(btrim(t.full_name),''),t.employee_id) as teacher_name,
  not coalesce(period.period_no>0 and period.day_of_week between 1 and 7
    and period.start_time is not null and period.end_time is not null and period.start_time<period.end_time
    and period.end_time<'24:00'::time and extract(second from period.start_time)=0 and extract(second from period.end_time)=0
    and a.id is not null and a.teacher_id=period.teacher_id and a.subject_id=period.subject_id
    and a.class_id=period.class_id and a.academic_year_id=period.academic_year_id
    and(a.section_id is null or a.section_id=period.section_id)
    and y.school_id=period.school_id and c.school_id=period.school_id and sub.school_id=period.school_id
    and t.school_id=period.school_id and(period.section_id is null or(sec.school_id=period.school_id and sec.class_id=period.class_id))
    and app_private.timetable_assignment_valid(a),false) as needs_attention
from public.timetables period left join public.academic_years y on y.id=period.academic_year_id and y.school_id=period.school_id
left join public.classes c on c.id=period.class_id and c.school_id=period.school_id
left join public.sections sec on sec.id=period.section_id and sec.school_id=period.school_id and sec.class_id=period.class_id
left join public.subjects sub on sub.id=period.subject_id and sub.school_id=period.school_id
left join public.teachers t on t.id=period.teacher_id and t.school_id=period.school_id
left join public.teacher_subject_assignments a on a.id=period.assignment_id;
revoke all on app_private.timetable_periods from public,anon,authenticated,service_role;

create function app_private.guard_timetable_period()
returns trigger language plpgsql security invoker set search_path=''
as $function$
begin
  if tg_op='DELETE' then raise exception 'Remove periods through the timetable workflow to preserve history.' using errcode='42501'; end if;
  if tg_op='UPDATE' then
    if old.deleted_at is not null then raise exception 'Removed timetable periods are immutable.' using errcode='42501'; end if;
    if(new.id,new.school_id,new.academic_year_id,new.class_id) is distinct from(old.id,old.school_id,old.academic_year_id,old.class_id) then
      raise exception 'Remove and recreate a period to change its school, year or class.' using errcode='22023';
    end if;
    if new.deleted_at is not null then
      if(new.assignment_id,new.teacher_id,new.subject_id,new.section_id,new.day_of_week,new.period_no,new.start_time,new.end_time,new.room)
        is distinct from(old.assignment_id,old.teacher_id,old.subject_id,old.section_id,old.day_of_week,old.period_no,old.start_time,old.end_time,old.room)
        or new.deleted_by is null then raise exception 'Removing a period cannot rewrite its schedule.' using errcode='22023'; end if;
      new.version:=gen_random_uuid(); return new;
    end if;
  end if;
  if new.assignment_id is null or new.teacher_id is null or new.subject_id is null or new.period_no<=0
    or new.start_time is null or new.end_time is null or new.start_time>=new.end_time or new.end_time>='24:00'::time
    or extract(second from new.start_time)<>0 or extract(second from new.end_time)<>0
    or new.deleted_at is not null or new.deleted_by is not null then
    raise exception 'Choose an assignment, positive period number and ordered same-day times in whole minutes.' using errcode='22023';
  end if;
  new.version:=gen_random_uuid();return new;
end;
$function$;
create trigger guard_timetable_period before insert or update or delete on public.timetables
for each row execute function app_private.guard_timetable_period();

create function app_private.save_timetable_period(
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
  raise exception using errcode='PT409',message=case conflict_name
    when 'timetable_teacher_overlap' then 'This teacher already has an overlapping period in this session and day.'
    when 'timetable_duplicate_period' then 'This class or section already has that period number on this day.'
    else 'This class or section already has an overlapping period in this session and day.' end;
end;
$function$;

create function app_private.remove_timetable_period(p_school_id uuid,p_period_id uuid,p_expected_version uuid,p_request_id uuid)
returns uuid language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=app_private.timetable_actor();
  request_payload jsonb:=jsonb_build_object('school',p_school_id,'period',p_period_id,'version',p_expected_version);
  receipt app_private.timetable_write_receipts%rowtype;
  before_row public.timetables%rowtype;after_row public.timetables%rowtype;
begin
  perform app_private.lock_timetable_office(p_school_id);
  if p_period_id is null or p_expected_version is null or p_request_id is null then
    raise exception 'A saved period, version and request reference are required.' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('timetable-intent:'||actor::text||':'||p_request_id::text,0));
  select * into receipt from app_private.timetable_write_receipts r where r.actor_id=actor and r.request_id=p_request_id;
  if found then
    if receipt.operation<>'remove' or receipt.payload<>request_payload then
      raise exception 'This request reference already has a different timetable action.' using errcode='PT409'; end if;
    return receipt.period_id;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('timetable-school:'||p_school_id::text,0));
  select * into before_row from public.timetables p where p.id=p_period_id and p.school_id=p_school_id for update;
  if not found then raise exception 'The timetable period is unavailable.' using errcode='42501'; end if;
  if before_row.deleted_at is not null or before_row.version<>p_expected_version then
    raise exception 'This period changed or was removed. Refresh before removing it.' using errcode='PT409'; end if;
  update public.timetables set deleted_at=clock_timestamp(),deleted_by=actor where id=p_period_id returning * into after_row;
  insert into app_private.timetable_write_receipts(actor_id,request_id,operation,period_id,payload,before_record,after_record)
    values(actor,p_request_id,'remove',p_period_id,request_payload,to_jsonb(before_row),to_jsonb(after_row));
  return p_period_id;
end;
$function$;

create function app_private.get_timetable_setup(p_school_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $function$
begin
  perform app_private.timetable_actor();
  if not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot view timetable setup for this school.' using errcode='42501'; end if;
  return jsonb_build_object(
    'years',coalesce((select jsonb_agg(jsonb_build_object('id',y.id,'name',y.name,'is_current',y.is_current,'start_date',y.start_date,'end_date',y.end_date) order by y.start_date desc,y.id)
      from public.academic_years y where y.school_id=p_school_id and isfinite(y.start_date) and isfinite(y.end_date) and y.start_date<=y.end_date),'[]'::jsonb),
    'classes',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.sort_order,c.name,c.id) from public.classes c where c.school_id=p_school_id and c.is_active),'[]'::jsonb),
    'sections',coalesce((select jsonb_agg(jsonb_build_object('id',sec.id,'class_id',sec.class_id,'name',sec.name) order by sec.name,sec.id) from public.sections sec
      join public.classes c on c.id=sec.class_id and c.school_id=sec.school_id where sec.school_id=p_school_id and c.is_active),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'academic_year_id',a.academic_year_id,'class_id',a.class_id,'section_id',a.section_id,
      'subject_id',a.subject_id,'teacher_id',a.teacher_id,'subject_name',sub.name,'teacher_name',coalesce(nullif(btrim(t.full_name),''),t.employee_id))
      order by sub.name,coalesce(nullif(btrim(t.full_name),''),t.employee_id),a.id)
      from public.teacher_subject_assignments a join public.teachers t on t.id=a.teacher_id join public.subjects sub on sub.id=a.subject_id
      where t.school_id=p_school_id and app_private.timetable_assignment_valid(a)),'[]'::jsonb));
end;
$function$;

create function app_private.get_office_timetable(p_school_id uuid,p_year_id uuid,p_class_id uuid,p_section_id uuid default null)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare year_name text;class_label text;section_label text;
begin
  perform app_private.timetable_actor();
  if not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot view this school timetable.' using errcode='42501'; end if;
  select y.name,c.name into year_name,class_label from public.academic_years y
    join public.classes c on c.school_id=y.school_id where y.id=p_year_id and c.id=p_class_id and y.school_id=p_school_id;
  if not found then raise exception 'The class or session is outside this school.' using errcode='42501'; end if;
  if p_section_id is not null then
    select sec.name into section_label from public.sections sec where sec.id=p_section_id and sec.class_id=p_class_id and sec.school_id=p_school_id;
    if not found then raise exception 'The section is outside this class.' using errcode='42501'; end if;
  end if;
  return jsonb_build_object('school_id',p_school_id,'academic_year_id',p_year_id,'academic_year_name',year_name,
    'class_id',p_class_id,'class_name',class_label,'section_id',p_section_id,'section_name',section_label,
    'rows',coalesce((select jsonb_agg(to_jsonb(p)-array['deleted_at','deleted_by'] order by p.day_of_week,p.start_time nulls last,p.period_no,p.id)
      from app_private.timetable_periods p where p.school_id=p_school_id and p.academic_year_id=p_year_id and p.class_id=p_class_id
        and p.deleted_at is null and(p_section_id is null or p.section_id is null or p.section_id=p_section_id)),'[]'::jsonb));
end;
$function$;

create function app_private.get_teacher_timetable()
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare actor uuid:=app_private.timetable_actor();teacher public.teachers%rowtype;year_row public.academic_years%rowtype;
begin
  select t.* into teacher from public.teachers t join public.profiles profile on profile.id=t.profile_id and profile.school_id=t.school_id
    where t.profile_id=actor and exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.school_id=t.school_id and ur.role='teacher');
  if not found or(select count(*) from public.teachers t where t.profile_id=actor)<>1 then
    raise exception 'An active linked teacher account is required.' using errcode='42501'; end if;
  if(select count(*) from public.academic_years y where y.school_id=teacher.school_id and y.is_current)>1 then
    raise exception 'The current academic year is ambiguous. Contact the school office.' using errcode='42501'; end if;
  select * into year_row from public.academic_years y where y.school_id=teacher.school_id and y.is_current;
  return jsonb_build_object('school_id',teacher.school_id,'academic_year_id',year_row.id,'academic_year_name',year_row.name,
    'rows',coalesce((select jsonb_agg(to_jsonb(p)-array['deleted_at','deleted_by'] order by p.day_of_week,p.start_time,p.period_no,p.id)
      from app_private.timetable_periods p where p.teacher_id=teacher.id and p.school_id=teacher.school_id
        and p.academic_year_id=year_row.id and p.deleted_at is null and not p.needs_attention),'[]'::jsonb));
end;
$function$;

create function app_private.get_family_timetable(p_student_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare actor uuid:=app_private.timetable_actor();student public.students%rowtype;scope record;
begin
  select s.* into student from public.students s join public.profiles profile on profile.id=actor and profile.school_id=s.school_id
    where s.id=p_student_id and((s.profile_id=actor and exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.school_id=s.school_id and ur.role='student'))
      or(exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.school_id=s.school_id and ur.role='parent')
        and exists(select 1 from public.parents parent join public.student_parents link on link.parent_id=parent.id
          where parent.profile_id=actor and parent.school_id=s.school_id and link.student_id=s.id)));
  if not found then raise exception 'You cannot view this student timetable.' using errcode='42501'; end if;
  if(select count(*) from public.academic_years y where y.school_id=student.school_id and y.is_current)>1 then
    raise exception 'The current academic year is ambiguous. Contact the school office.' using errcode='42501'; end if;
  select e.academic_year_id,y.name as academic_year_name,e.class_id,c.name as class_name,e.section_id,sec.name as section_name into scope
    from public.enrollments e join public.academic_years y on y.id=e.academic_year_id and y.school_id=student.school_id and y.is_current
    join public.classes c on c.id=e.class_id and c.school_id=student.school_id and c.is_active
    left join public.sections sec on sec.id=e.section_id and sec.class_id=c.id and sec.school_id=student.school_id
    where e.student_id=p_student_id and e.status='active' and student.status='active' and(e.section_id is null or sec.id is not null);
  return jsonb_build_object('student_id',p_student_id,'school_id',student.school_id,
    'academic_year_id',scope.academic_year_id,'academic_year_name',scope.academic_year_name,'class_id',scope.class_id,'class_name',scope.class_name,
    'section_id',scope.section_id,'section_name',scope.section_name,
    'rows',coalesce((select jsonb_agg(to_jsonb(p)-array['deleted_at','deleted_by'] order by p.day_of_week,p.start_time,p.period_no,p.id)
      from app_private.timetable_periods p where p.school_id=student.school_id and p.academic_year_id=scope.academic_year_id
        and p.class_id=scope.class_id and(p.section_id is null or p.section_id=scope.section_id)
        and p.deleted_at is null and not p.needs_attention),'[]'::jsonb));
end;
$function$;

create function public.get_timetable_setup(p_school_id uuid) returns jsonb language sql security invoker set search_path=''
as $function$ select app_private.get_timetable_setup(p_school_id); $function$;
create function public.get_office_timetable(p_school_id uuid,p_year_id uuid,p_class_id uuid,p_section_id uuid default null)
returns jsonb language sql security invoker set search_path=''
as $function$ select app_private.get_office_timetable(p_school_id,p_year_id,p_class_id,p_section_id); $function$;
create function public.get_teacher_timetable() returns jsonb language sql security invoker set search_path=''
as $function$ select app_private.get_teacher_timetable(); $function$;
create function public.get_family_timetable(p_student_id uuid) returns jsonb language sql security invoker set search_path=''
as $function$ select app_private.get_family_timetable(p_student_id); $function$;
create function public.save_timetable_period(p_school_id uuid,p_period_id uuid,p_expected_version uuid,p_assignment_id uuid,p_section_id uuid,
  p_day_of_week integer,p_period_no integer,p_start_time time,p_end_time time,p_room text,p_request_id uuid)
returns uuid language sql security invoker set search_path=''
as $function$ select app_private.save_timetable_period(p_school_id,p_period_id,p_expected_version,p_assignment_id,p_section_id,p_day_of_week,p_period_no,p_start_time,p_end_time,p_room,p_request_id); $function$;
create function public.remove_timetable_period(p_school_id uuid,p_period_id uuid,p_expected_version uuid,p_request_id uuid)
returns uuid language sql security invoker set search_path=''
as $function$ select app_private.remove_timetable_period(p_school_id,p_period_id,p_expected_version,p_request_id); $function$;

revoke all on function app_private.timetable_actor(),app_private.lock_timetable_office(uuid,uuid),
  app_private.timetable_assignment_valid(public.teacher_subject_assignments),app_private.guard_timetable_period()
  from public,anon,authenticated,service_role;
revoke all on function public.get_timetable_setup(uuid),app_private.get_timetable_setup(uuid),
  public.get_office_timetable(uuid,uuid,uuid,uuid),app_private.get_office_timetable(uuid,uuid,uuid,uuid),
  public.get_teacher_timetable(),app_private.get_teacher_timetable(),public.get_family_timetable(uuid),app_private.get_family_timetable(uuid),
  public.save_timetable_period(uuid,uuid,uuid,uuid,uuid,integer,integer,time,time,text,uuid),app_private.save_timetable_period(uuid,uuid,uuid,uuid,uuid,integer,integer,time,time,text,uuid),
  public.remove_timetable_period(uuid,uuid,uuid,uuid),app_private.remove_timetable_period(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_timetable_setup(uuid),app_private.get_timetable_setup(uuid),
  public.get_office_timetable(uuid,uuid,uuid,uuid),app_private.get_office_timetable(uuid,uuid,uuid,uuid),
  public.get_teacher_timetable(),app_private.get_teacher_timetable(),public.get_family_timetable(uuid),app_private.get_family_timetable(uuid),
  public.save_timetable_period(uuid,uuid,uuid,uuid,uuid,integer,integer,time,time,text,uuid),app_private.save_timetable_period(uuid,uuid,uuid,uuid,uuid,integer,integer,time,time,text,uuid),
  public.remove_timetable_period(uuid,uuid,uuid,uuid),app_private.remove_timetable_period(uuid,uuid,uuid,uuid)
  to authenticated;

commit;
