-- Student leave is separate from the legacy staff/demo leave tables.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

create table app_private.student_leave_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id),
  enrollment_id uuid not null,
  academic_year_id uuid not null,
  class_id uuid not null,
  section_id uuid,
  student_name text not null,
  admission_no text not null,
  academic_year_name text not null,
  class_name text not null,
  section_name text,
  start_date date not null,
  end_date date not null,
  reason text not null check (char_length(reason) between 3 and 1000 and reason = regexp_replace(reason, '^[[:space:]]+|[[:space:]]+$', '', 'g')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requester_id uuid not null references public.profiles(id),
  requester_name text not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.profiles(id),
  reviewer_name text,
  review_note text check (char_length(review_note) between 3 and 1000 and review_note = regexp_replace(review_note, '^[[:space:]]+|[[:space:]]+$', '', 'g')),
  reviewed_at timestamptz,
  unique (requester_id,idempotency_key),
  check (isfinite(start_date) and isfinite(end_date) and start_date <= end_date),
  check (reviewed_by is distinct from requester_id),
  check ((status = 'pending' and reviewed_by is null and reviewer_name is null and review_note is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by is not null and reviewer_name is not null and review_note is not null and reviewed_at is not null))
);

alter table app_private.student_leave_requests enable row level security;
revoke all on table app_private.student_leave_requests from public,anon,authenticated,service_role;
create index student_leave_family_history on app_private.student_leave_requests(student_id,created_at desc,id desc);
create index student_leave_review_queue on app_private.student_leave_requests(school_id,status,created_at desc,id desc);
create index student_leave_school_history on app_private.student_leave_requests(school_id,created_at desc,id desc);
create index student_leave_overlap on app_private.student_leave_requests(student_id,start_date,end_date)
  where status in ('pending','approved');

create function app_private.student_leave_actor()
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare actor_id uuid := auth.uid();
begin
  -- Match guardian revoke's Auth-first lock order; profile/role locks keep a
  -- disabled account or removed role from racing an authorized mutation.
  perform 1 from auth.users u where u.id=actor_id and not coalesce(u.is_anonymous,false)
    and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
    and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null) for share;
  if not found then raise exception 'An active verified account is required.' using errcode='42501'; end if;
  perform 1 from public.profiles p where p.id=actor_id and p.is_active for share;
  if not found then raise exception 'An active verified account is required.' using errcode='42501'; end if;
  return actor_id;
end;
$function$;

create function app_private.can_read_student_leave(p_student_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from public.students s join public.profiles actor on actor.id=auth.uid()
      and actor.is_active and actor.school_id=s.school_id
    where s.id=p_student_id and (
      (s.profile_id=actor.id and exists (select 1 from public.user_roles ur
        where ur.user_id=actor.id and ur.school_id=s.school_id and ur.role='student'))
      or (exists (select 1 from public.user_roles ur where ur.user_id=actor.id
        and ur.school_id=s.school_id and ur.role='parent')
        and exists (select 1 from public.parents p join public.student_parents link on link.parent_id=p.id
          where p.profile_id=actor.id and p.school_id=s.school_id and link.student_id=s.id))
    )
  );
$function$;

create function app_private.submit_student_leave(
  p_student_id uuid,p_start_date date,p_end_date date,p_reason text,p_idempotency_key uuid
)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := app_private.student_leave_actor();
  reason_text text := pg_catalog.regexp_replace(p_reason,'^[[:space:]]+|[[:space:]]+$','','g');
  previous app_private.student_leave_requests%rowtype;
  year_row public.academic_years%rowtype;
  placement record;
  saved_id uuid;
begin
  if not app_private.can_read_student_leave(p_student_id) then
    raise exception 'You cannot request leave for this student.' using errcode='42501';
  end if;
  if p_idempotency_key is null or reason_text is null or pg_catalog.char_length(reason_text) not between 3 and 1000
    or p_start_date is null or p_end_date is null or not pg_catalog.isfinite(p_start_date)
    or not pg_catalog.isfinite(p_end_date) or p_start_date>p_end_date then
    raise exception 'Enter valid ordered dates and a reason between 3 and 1000 characters.' using errcode='22023';
  end if;

  perform 1 from public.user_roles ur join public.students s on s.id=p_student_id
    where ur.user_id=actor_id and ur.school_id=s.school_id and ur.role in ('parent','student')
    order by ur.id for share of ur;
  perform 1 from public.parents p join public.student_parents link on link.parent_id=p.id
    where p.profile_id=actor_id and link.student_id=p_student_id for share of p,link;
  if not app_private.can_read_student_leave(p_student_id) then
    raise exception 'You cannot request leave for this student.' using errcode='42501';
  end if;

  -- Actor/key serializes retry payloads across children. Student mutex also
  -- serializes overlapping requests from different guardians of one child.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'student-leave-intent:'||actor_id::text||':'||p_idempotency_key::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('student-leave:'||p_student_id::text,0));
  select * into previous from app_private.student_leave_requests r
    where r.requester_id=actor_id and r.idempotency_key=p_idempotency_key;
  if found then
    if (previous.student_id,previous.start_date,previous.end_date,previous.reason)
      is distinct from (p_student_id,p_start_date,p_end_date,reason_text) then
      raise exception 'This request key already has a different leave request.' using errcode='PT409';
    end if;
    return previous.id;
  end if;

  -- Academic-year locks precede enrollment/student locks, as in promotion.
  select y.* into year_row from public.academic_years y join public.students s on s.school_id=y.school_id
    where s.id=p_student_id and y.is_current for share of y;
  if not found or (select count(*) from public.academic_years y where y.school_id=year_row.school_id and y.is_current)<>1 then
    raise exception 'The student needs one current school year and an active enrollment.' using errcode='42501';
  end if;
  select e.id as enrollment_id,e.class_id,e.section_id,s.school_id,
    pg_catalog.concat_ws(' ',s.first_name,nullif(s.middle_name,''),nullif(s.last_name,'')) as student_name,
    s.admission_no,c.name as class_name into placement
    from public.enrollments e join public.students s on s.id=e.student_id
    join public.classes c on c.id=e.class_id and c.school_id=s.school_id
    where s.id=p_student_id and s.school_id=year_row.school_id and s.status='active'
      and e.academic_year_id=year_row.id and e.status='active' and c.is_active
    for share of e,s,c;
  if not found or not app_private.can_read_student_leave(p_student_id) then
    raise exception 'The student needs one current school year and an active enrollment.' using errcode='42501';
  end if;
  if placement.section_id is not null then
    perform 1 from public.sections sec where sec.id=placement.section_id
      and sec.school_id=placement.school_id and sec.class_id=placement.class_id for share;
    if not found then raise exception 'The student enrollment is inconsistent. Contact the school office.' using errcode='42501'; end if;
  end if;
  if p_start_date<year_row.start_date or p_end_date>year_row.end_date then
    raise exception 'Leave dates must be within the current academic year.' using errcode='22023';
  end if;
  if exists (select 1 from app_private.student_leave_requests r where r.student_id=p_student_id
    and r.status in ('pending','approved') and r.start_date<=p_end_date and r.end_date>=p_start_date) then
    raise exception 'An overlapping pending or approved request already exists. Refresh the history.' using errcode='PT409';
  end if;
  insert into app_private.student_leave_requests(school_id,student_id,enrollment_id,academic_year_id,class_id,section_id,
    student_name,admission_no,academic_year_name,class_name,section_name,start_date,end_date,reason,requester_id,requester_name,idempotency_key)
  values(placement.school_id,p_student_id,placement.enrollment_id,year_row.id,placement.class_id,placement.section_id,
    placement.student_name,placement.admission_no,year_row.name,placement.class_name,
    (select sec.name from public.sections sec where sec.id=placement.section_id),p_start_date,p_end_date,reason_text,actor_id,
    (select coalesce(p.full_name,'School account') from public.profiles p where p.id=actor_id),p_idempotency_key)
  returning id into saved_id;
  return saved_id;
end;
$function$;

create function app_private.review_student_leave(p_request_id uuid,p_decision text,p_reason text)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := app_private.student_leave_actor();
  reason_text text := pg_catalog.regexp_replace(p_reason,'^[[:space:]]+|[[:space:]]+$','','g');
  request app_private.student_leave_requests%rowtype;
begin
  select * into request from app_private.student_leave_requests r where r.id=p_request_id;
  if not found or not app_private.has_school_roles(request.school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot review this leave request.' using errcode='42501';
  end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id and
    ((ur.school_id=request.school_id and ur.role in ('school_admin','principal'))
      or (ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'You cannot review this leave request.' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') or reason_text is null
    or pg_catalog.char_length(reason_text) not between 3 and 1000 then
    raise exception 'Choose approve or reject and enter a review note between 3 and 1000 characters.' using errcode='22023';
  end if;
  select * into request from app_private.student_leave_requests r where r.id=p_request_id for update;
  if request.requester_id=actor_id then
    raise exception 'Another school administrator must review your request.' using errcode='42501';
  end if;
  if request.status<>'pending' then
    if (request.status,request.reviewed_by,request.review_note)=(p_decision,actor_id,reason_text) then return request.id; end if;
    raise exception 'This leave request has already been reviewed. Refresh the queue.' using errcode='PT409';
  end if;
  update app_private.student_leave_requests set status=p_decision,reviewed_by=actor_id,
    reviewer_name=(select coalesce(p.full_name,'School office') from public.profiles p where p.id=actor_id),
    review_note=reason_text,reviewed_at=clock_timestamp() where id=request.id;
  return request.id;
end;
$function$;

create function app_private.list_family_student_leave(p_student_id uuid,p_offset integer default 0)
returns table(id uuid,school_id uuid,student_id uuid,student_name text,admission_no text,academic_year_id uuid,
  academic_year_name text,class_name text,section_name text,start_date date,end_date date,reason text,status text,
  requester_id uuid,requester_name text,created_at timestamptz,reviewed_by uuid,reviewer_name text,review_note text,reviewed_at timestamptz,total_count bigint)
language plpgsql security definer set search_path = ''
as $function$
begin
  perform app_private.student_leave_actor();
  if not app_private.can_read_student_leave(p_student_id) then
    raise exception 'You cannot view leave for this student.' using errcode='42501';
  end if;
  if p_offset is null or p_offset<0 then raise exception 'Invalid page.' using errcode='22023'; end if;
  return query select r.id,r.school_id,r.student_id,r.student_name,r.admission_no,r.academic_year_id,
    r.academic_year_name,r.class_name,r.section_name,r.start_date,r.end_date,r.reason,r.status,
    r.requester_id,r.requester_name,r.created_at,r.reviewed_by,r.reviewer_name,r.review_note,r.reviewed_at,count(*) over()
    from app_private.student_leave_requests r where r.student_id=p_student_id order by r.created_at desc,r.id desc limit 50 offset p_offset;
end;
$function$;

create function app_private.list_student_leave_review(p_school_id uuid,p_status text default null,p_offset integer default 0)
returns table(id uuid,school_id uuid,student_id uuid,student_name text,admission_no text,academic_year_id uuid,
  academic_year_name text,class_name text,section_name text,start_date date,end_date date,reason text,status text,
  requester_id uuid,requester_name text,created_at timestamptz,reviewed_by uuid,reviewer_name text,review_note text,reviewed_at timestamptz,total_count bigint)
language plpgsql security definer set search_path = ''
as $function$
begin
  perform app_private.student_leave_actor();
  if p_school_id is null or not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot review leave for this school.' using errcode='42501';
  end if;
  if p_offset is null or p_offset<0 or (p_status is not null and p_status not in ('pending','approved','rejected')) then
    raise exception 'Invalid page or status filter.' using errcode='22023';
  end if;
  return query select r.id,r.school_id,r.student_id,r.student_name,r.admission_no,r.academic_year_id,
    r.academic_year_name,r.class_name,r.section_name,r.start_date,r.end_date,r.reason,r.status,
    r.requester_id,r.requester_name,r.created_at,r.reviewed_by,r.reviewer_name,r.review_note,r.reviewed_at,count(*) over()
    from app_private.student_leave_requests r where r.school_id=p_school_id and (p_status is null or r.status=p_status)
    order by r.created_at desc,r.id desc limit 50 offset p_offset;
end;
$function$;

create function public.submit_student_leave(p_student_id uuid,p_start_date date,p_end_date date,p_reason text,p_idempotency_key uuid)
returns uuid language sql security invoker set search_path = ''
as $function$ select app_private.submit_student_leave(p_student_id,p_start_date,p_end_date,p_reason,p_idempotency_key); $function$;
create function public.review_student_leave(p_request_id uuid,p_decision text,p_reason text)
returns uuid language sql security invoker set search_path = ''
as $function$ select app_private.review_student_leave(p_request_id,p_decision,p_reason); $function$;
create function public.list_family_student_leave(p_student_id uuid,p_offset integer default 0)
returns table(id uuid,school_id uuid,student_id uuid,student_name text,admission_no text,academic_year_id uuid,
  academic_year_name text,class_name text,section_name text,start_date date,end_date date,reason text,status text,
  requester_id uuid,requester_name text,created_at timestamptz,reviewed_by uuid,reviewer_name text,review_note text,reviewed_at timestamptz,total_count bigint)
language sql security invoker set search_path = ''
as $function$ select * from app_private.list_family_student_leave(p_student_id,p_offset); $function$;
create function public.list_student_leave_review(p_school_id uuid,p_status text default null,p_offset integer default 0)
returns table(id uuid,school_id uuid,student_id uuid,student_name text,admission_no text,academic_year_id uuid,
  academic_year_name text,class_name text,section_name text,start_date date,end_date date,reason text,status text,
  requester_id uuid,requester_name text,created_at timestamptz,reviewed_by uuid,reviewer_name text,review_note text,reviewed_at timestamptz,total_count bigint)
language sql security invoker set search_path = ''
as $function$ select * from app_private.list_student_leave_review(p_school_id,p_status,p_offset); $function$;

revoke all on function app_private.student_leave_actor(),app_private.can_read_student_leave(uuid)
  from public,anon,authenticated,service_role;
revoke all on function app_private.submit_student_leave(uuid,date,date,text,uuid),public.submit_student_leave(uuid,date,date,text,uuid),
  app_private.review_student_leave(uuid,text,text),public.review_student_leave(uuid,text,text),
  app_private.list_family_student_leave(uuid,integer),public.list_family_student_leave(uuid,integer),
  app_private.list_student_leave_review(uuid,text,integer),public.list_student_leave_review(uuid,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function app_private.submit_student_leave(uuid,date,date,text,uuid),public.submit_student_leave(uuid,date,date,text,uuid),
  app_private.review_student_leave(uuid,text,text),public.review_student_leave(uuid,text,text),
  app_private.list_family_student_leave(uuid,integer),public.list_family_student_leave(uuid,integer),
  app_private.list_student_leave_review(uuid,text,integer),public.list_student_leave_review(uuid,text,integer)
  to authenticated;

commit;
