-- Student leave: placement failures get PT422 (office must fix the class placement) instead of the
-- access-denial 42501, and a reviewer who is the pupil's own account or linked guardian cannot decide it.
-- The office review list flags those rows (is_family_reviewer) so the UI hides the decision.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

create or replace function app_private.submit_student_leave(
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
    raise exception 'This student has no active class placement for the current school year. Contact the school office.' using errcode='PT422';
  end if;
  select e.id as enrollment_id,e.class_id,e.section_id,s.school_id,
    pg_catalog.concat_ws(' ',s.first_name,nullif(s.middle_name,''),nullif(s.last_name,'')) as student_name,
    s.admission_no,c.name as class_name into placement
    from public.enrollments e join public.students s on s.id=e.student_id
    join public.classes c on c.id=e.class_id and c.school_id=s.school_id
    where s.id=p_student_id and s.school_id=year_row.school_id and s.status='active'
      and e.academic_year_id=year_row.id and e.status='active' and c.is_active
    for share of e,s,c;
  if not app_private.can_read_student_leave(p_student_id) then
    raise exception 'You cannot request leave for this student.' using errcode='42501';
  end if;
  if not found then
    raise exception 'This student has no active class placement for the current school year. Contact the school office.' using errcode='PT422';
  end if;
  if placement.section_id is not null then
    perform 1 from public.sections sec where sec.id=placement.section_id
      and sec.school_id=placement.school_id and sec.class_id=placement.class_id for share;
    if not found then raise exception 'The student enrollment is inconsistent. Contact the school office.' using errcode='PT422'; end if;
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

create or replace function app_private.review_student_leave(p_request_id uuid,p_decision text,p_reason text)
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
  -- Independent review: the pupil's own account or any linked guardian cannot decide, whatever roles they hold.
  if exists (select 1 from public.students s where s.id=request.student_id and s.profile_id=actor_id)
    or exists (select 1 from public.parents p join public.student_parents link on link.parent_id=p.id
      where p.profile_id=actor_id and link.student_id=request.student_id) then
    raise exception 'Another school administrator must review leave for your own child.' using errcode='42501';
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

-- Return type changes, so drop and recreate (wrapper first).
drop function if exists public.list_student_leave_review(uuid,text,integer);
drop function if exists app_private.list_student_leave_review(uuid,text,integer);

create function app_private.list_student_leave_review(p_school_id uuid,p_status text default null,p_offset integer default 0)
returns table(id uuid,school_id uuid,student_id uuid,student_name text,admission_no text,academic_year_id uuid,
  academic_year_name text,class_name text,section_name text,start_date date,end_date date,reason text,status text,
  requester_id uuid,requester_name text,created_at timestamptz,reviewed_by uuid,reviewer_name text,review_note text,reviewed_at timestamptz,total_count bigint,
  is_family_reviewer boolean)
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := app_private.student_leave_actor();
begin
  if p_school_id is null or not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot review leave for this school.' using errcode='42501';
  end if;
  if p_offset is null or p_offset<0 or (p_status is not null and p_status not in ('pending','approved','rejected')) then
    raise exception 'Invalid page or status filter.' using errcode='22023';
  end if;
  -- is_family_reviewer mirrors review_student_leave's own-child refusal.
  return query select r.id,r.school_id,r.student_id,r.student_name,r.admission_no,r.academic_year_id,
    r.academic_year_name,r.class_name,r.section_name,r.start_date,r.end_date,r.reason,r.status,
    r.requester_id,r.requester_name,r.created_at,r.reviewed_by,r.reviewer_name,r.review_note,r.reviewed_at,count(*) over(),
    (exists (select 1 from public.students s where s.id=r.student_id and s.profile_id=actor_id)
      or exists (select 1 from public.parents p join public.student_parents link on link.parent_id=p.id
        where p.profile_id=actor_id and link.student_id=r.student_id))
    from app_private.student_leave_requests r where r.school_id=p_school_id and (p_status is null or r.status=p_status)
    order by r.created_at desc,r.id desc limit 50 offset p_offset;
end;
$function$;

create function public.list_student_leave_review(p_school_id uuid,p_status text default null,p_offset integer default 0)
returns table(id uuid,school_id uuid,student_id uuid,student_name text,admission_no text,academic_year_id uuid,
  academic_year_name text,class_name text,section_name text,start_date date,end_date date,reason text,status text,
  requester_id uuid,requester_name text,created_at timestamptz,reviewed_by uuid,reviewer_name text,review_note text,reviewed_at timestamptz,total_count bigint,
  is_family_reviewer boolean)
language sql security invoker set search_path = ''
as $function$ select * from app_private.list_student_leave_review(p_school_id,p_status,p_offset); $function$;

revoke all on function app_private.list_student_leave_review(uuid,text,integer),public.list_student_leave_review(uuid,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function app_private.list_student_leave_review(uuid,text,integer),public.list_student_leave_review(uuid,text,integer)
  to authenticated;

revoke all on function app_private.submit_student_leave(uuid,date,date,text,uuid),
  app_private.review_student_leave(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function app_private.submit_student_leave(uuid,date,date,text,uuid),
  app_private.review_student_leave(uuid,text,text)
  to authenticated;

commit;
