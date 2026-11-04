begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.attendance add column revision bigint not null default 0;

create table app_private.attendance_corrections (
  id uuid primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null,
  section_id uuid not null,
  student_id uuid not null,
  attendance_date date not null,
  requested_by uuid not null,
  request_reason text not null check (length(request_reason) between 1 and 500),
  requested_status public.attendance_status not null,
  before_record jsonb,
  after_record jsonb,
  requested_at timestamptz not null default clock_timestamp(),
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text check (length(review_reason) between 1 and 500),
  check (reviewed_by is distinct from requested_by),
  check (
    (state = 'pending' and reviewed_by is null and reviewed_at is null and review_reason is null)
    or (state <> 'pending' and reviewed_by is not null and reviewed_at is not null and review_reason is not null)
  ),
  check ((state = 'approved') = (after_record is not null))
);

alter table app_private.attendance_corrections enable row level security;
revoke all on table app_private.attendance_corrections from public, anon, authenticated, service_role;

create unique index attendance_corrections_pending_student_day
  on app_private.attendance_corrections (student_id, attendance_date) where state = 'pending';
create index attendance_corrections_school_requested
  on app_private.attendance_corrections (school_id, requested_at desc, id);
create index attendance_corrections_actor_requested
  on app_private.attendance_corrections (requested_by, school_id, requested_at desc, id);

create function app_private.attendance_scope_is_current(
  p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date
)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = auth.uid()
    and ((ur.school_id = p_school_id and ur.role in ('school_admin', 'principal', 'teacher'))
      or (ur.school_id is null and ur.role = 'super_admin'))
  for share of ur, p;
  if not found then
    return false;
  end if;
  perform 1 from public.enrollments e
    join public.students s on s.id = e.student_id and s.school_id = p_school_id
    join public.academic_years y on y.id = e.academic_year_id and y.school_id = p_school_id
    join public.sections sec on sec.id = e.section_id and sec.school_id = p_school_id and sec.class_id = e.class_id
    join public.classes c on c.id = e.class_id and c.school_id = p_school_id
    where e.student_id = p_student_id and e.academic_year_id = p_year_id and e.section_id = p_section_id
      and e.status = 'active' and s.status = 'active' and y.is_current
      and p_day between y.start_date and y.end_date
  for share of e, s, y, sec, c;
  return found;
end;
$$;

create function app_private.guard_daily_attendance_write()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  -- The review transaction runs as the function owner. Browser requests always
  -- run as an API role and cannot opt into the historical path.
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then
      raise exception 'Attendance records cannot be deleted by school accounts.' using errcode = '42501';
    end if;
    if (tg_op <> 'INSERT' and old.attendance_date is distinct from today)
      or new.attendance_date is distinct from today then
      raise exception 'Past attendance can only change through an approved correction. Choose today to mark attendance.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.id, new.school_id, new.academic_year_id, new.section_id, new.student_id, new.attendance_date)
      is distinct from (old.id, old.school_id, old.academic_year_id, old.section_id, old.student_id, old.attendance_date) then
      raise exception 'An existing attendance record cannot move to another register.' using errcode = '42501';
    end if;
    if new.marked_by is distinct from auth.uid()
      or not app_private.attendance_scope_is_current(new.school_id, new.academic_year_id, new.section_id, new.student_id, new.attendance_date) then
      raise exception 'This student is outside the current attendance register.' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  new.revision := case when tg_op = 'INSERT' then 0 else old.revision + 1 end;
  return new;
end;
$$;

create trigger guard_daily_attendance_write
  before insert or update or delete on public.attendance
  for each row execute function app_private.guard_daily_attendance_write();

create function app_private.can_review_attendance_corrections(p_school_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select p_school_id is not null and exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = auth.uid()
      and ((ur.school_id = p_school_id and ur.role in ('school_admin', 'principal'))
        or (ur.school_id is null and ur.role = 'super_admin'))
  );
$$;

create function app_private.lock_attendance_correction_scope(
  p_teacher_user uuid, p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date
)
returns boolean language plpgsql set search_path = ''
as $$
begin
  perform 1 from public.enrollments e
  join public.students s on s.id = e.student_id and s.school_id = p_school_id
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = p_school_id
  join public.sections sec on sec.id = e.section_id and sec.school_id = p_school_id and sec.class_id = e.class_id
  join public.classes c on c.id = e.class_id and c.school_id = p_school_id
  join public.teacher_subject_assignments a on a.academic_year_id = y.id and a.class_id = c.id
    and a.section_id = sec.id and a.is_class_teacher
  join public.teachers t on t.id = a.teacher_id and t.school_id = p_school_id and t.profile_id = p_teacher_user
  join public.profiles p on p.id = t.profile_id and p.is_active
  join public.user_roles ur on ur.user_id = p.id and ur.school_id = p_school_id and ur.role = 'teacher'
  where e.student_id = p_student_id and e.academic_year_id = p_year_id and e.section_id = p_section_id
    and e.status = 'active' and s.status = 'active' and y.is_current and p_day between y.start_date and y.end_date
    and app_private.assignment_scope_is_coherent(t.id, y.id, c.id, sec.id, a.subject_id, true)
  for share of e, s, y, sec, c, a, t, p, ur;
  return found;
end;
$$;

create function app_private.request_attendance_correction(
  p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date,
  p_expected_id uuid, p_expected_revision bigint, p_status public.attendance_status, p_reason text, p_request_id uuid
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  reason text := nullif(pg_catalog.regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  existing_request app_private.attendance_corrections%rowtype;
  existing_mark public.attendance%rowtype;
  before_record jsonb;
begin
  if actor_id is null then
    raise exception 'Sign in again to request an attendance correction.' using errcode = '42501';
  end if;
  if p_request_id is null or p_status is null or reason is null or length(reason) > 500
    or p_day is null or not pg_catalog.isfinite(p_day) or p_day >= (statement_timestamp() at time zone 'Asia/Kolkata')::date
    or (p_expected_id is null) <> (p_expected_revision is null) then
    raise exception 'Choose a past date, changed status and a reason of up to 500 characters.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('attendance-correction:' || p_request_id::text, 0));
  select * into existing_request from app_private.attendance_corrections where id = p_request_id;
  if found then
    if (existing_request.requested_by, existing_request.school_id, existing_request.academic_year_id,
          existing_request.section_id, existing_request.student_id, existing_request.attendance_date,
          existing_request.requested_status, existing_request.request_reason,
          (existing_request.before_record->>'id')::uuid, (existing_request.before_record->>'revision')::bigint)
      is distinct from (actor_id, p_school_id, p_year_id, p_section_id, p_student_id, p_day, p_status, reason,
          p_expected_id, p_expected_revision) then
      raise exception 'This correction request was already used for another submission.' using errcode = '23505';
    end if;
    return existing_request.id;
  end if;

  if not app_private.lock_attendance_correction_scope(actor_id, p_school_id, p_year_id, p_section_id, p_student_id, p_day) then
    raise exception 'This pupil or date is outside your assigned current-year register.' using errcode = '42501';
  end if;
  select * into existing_mark from public.attendance
  where student_id = p_student_id and attendance_date = p_day;
  if found then
    if (existing_mark.school_id, existing_mark.academic_year_id, existing_mark.section_id)
      is distinct from (p_school_id, p_year_id, p_section_id) then
      raise exception 'This attendance record belongs to a different register.' using errcode = '42501';
    end if;
    before_record := pg_catalog.to_jsonb(existing_mark);
  end if;
  if (existing_mark.id, existing_mark.revision) is distinct from (p_expected_id, p_expected_revision) then
    raise exception 'Attendance changed since you opened the register. Reload before requesting a correction.' using errcode = '40001';
  end if;
  if existing_mark.status is not distinct from p_status then
    raise exception 'Choose a different status for the correction.' using errcode = '22023';
  end if;

  insert into app_private.attendance_corrections (
    id, school_id, academic_year_id, section_id, student_id, attendance_date,
    requested_by, request_reason, requested_status, before_record
  ) values (
    p_request_id, p_school_id, p_year_id, p_section_id, p_student_id, p_day,
    actor_id, reason, p_status, before_record
  )
  on conflict (student_id, attendance_date) where state = 'pending' do nothing;
  if not found then
    raise exception 'A correction for this pupil and date is already awaiting review.' using errcode = '23505';
  end if;
  return p_request_id;
end;
$$;

create function app_private.review_attendance_correction(p_request_id uuid, p_decision text, p_reason text)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  reason text := nullif(pg_catalog.regexp_replace(p_reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  correction app_private.attendance_corrections%rowtype;
  existing_mark public.attendance%rowtype;
  current_record jsonb;
  applied_record jsonb;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') or reason is null or length(reason) > 500 then
    raise exception 'A decision and a reason of up to 500 characters are required.' using errcode = '22023';
  end if;
  select * into correction from app_private.attendance_corrections
  where id = p_request_id for update;
  if not found or not app_private.can_review_attendance_corrections(correction.school_id) then
    raise exception 'You cannot review this attendance correction.' using errcode = '42501';
  end if;
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.school_id = correction.school_id and ur.role in ('school_admin', 'principal'))
      or (ur.school_id is null and ur.role = 'super_admin'))
  for share of ur, p;
  if not found then
    raise exception 'You cannot review this attendance correction.' using errcode = '42501';
  end if;
  if correction.requested_by = actor_id then
    raise exception 'Another administrator or principal must review your own correction.' using errcode = '42501';
  end if;
  if correction.state <> 'pending' then
    if correction.state = p_decision and correction.reviewed_by = actor_id and correction.review_reason = reason then
      return correction.state;
    end if;
    raise exception 'This request has already been reviewed. Refresh to see the decision.' using errcode = '23505';
  end if;

  if p_decision = 'approved' then
    if not app_private.lock_attendance_correction_scope(correction.requested_by, correction.school_id, correction.academic_year_id,
      correction.section_id, correction.student_id, correction.attendance_date) then
      raise exception 'This pupil or teacher is no longer assigned to this register. Reject the request with a reason.' using errcode = '42501';
    end if;
    select * into existing_mark from public.attendance
    where student_id = correction.student_id and attendance_date = correction.attendance_date for update;
    if found then current_record := pg_catalog.to_jsonb(existing_mark); end if;
    if current_record is distinct from correction.before_record then
      raise exception 'The original attendance changed. Reject this request and ask the teacher to reload.' using errcode = '40001';
    end if;

    if correction.before_record is null then
      insert into public.attendance (school_id, academic_year_id, section_id, student_id, attendance_date, status, marked_by)
      values (correction.school_id, correction.academic_year_id, correction.section_id, correction.student_id,
        correction.attendance_date, correction.requested_status, actor_id)
      on conflict (student_id, attendance_date) do nothing
      returning * into existing_mark;
      if not found then
        raise exception 'Attendance was added while this request was reviewed.' using errcode = '40001';
      end if;
    else
      update public.attendance set status = correction.requested_status, marked_by = actor_id
      where id = existing_mark.id returning * into existing_mark;
    end if;
    applied_record := pg_catalog.to_jsonb(existing_mark);
  end if;

  update app_private.attendance_corrections
  set state = p_decision, reviewed_by = actor_id, review_reason = reason, reviewed_at = clock_timestamp(),
    after_record = applied_record
  where id = correction.id;
  return p_decision;
end;
$$;

create function app_private.list_attendance_corrections(p_school_id uuid, p_offset integer, p_own boolean)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is null or (not p_own and not app_private.can_review_attendance_corrections(p_school_id))
    or p_own is null or p_school_id is null or p_offset is null or p_offset < 0 then
    raise exception 'You cannot view attendance corrections for this school.' using errcode = '42501';
  end if;
  if p_own and not exists (
    select 1 from public.user_roles ur join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = actor_id and ur.school_id = p_school_id and ur.role = 'teacher'
  ) then
    raise exception 'You cannot view attendance corrections for this school.' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
      order by row_data.state = 'pending' desc, row_data.requested_at desc, row_data.id)
    from (
      select q.id, q.student_id, q.requested_by, q.attendance_date, q.requested_at, q.reviewed_at, q.state,
        q.request_reason, q.review_reason, q.requested_status, q.before_record, q.after_record,
        concat_ws(' ', s.first_name, s.middle_name, s.last_name) as student_name, s.admission_no,
        concat_ws(' / ', c.name, sec.name) as section_name,
        p.full_name as requester_name, reviewer.full_name as reviewer_name
      from app_private.attendance_corrections q
      left join public.students s on s.id = q.student_id and s.school_id = q.school_id
      left join public.sections sec on sec.id = q.section_id and sec.school_id = q.school_id
      left join public.classes c on c.id = sec.class_id and c.school_id = q.school_id
      left join public.profiles p on p.id = q.requested_by
      left join public.profiles reviewer on reviewer.id = q.reviewed_by
      where q.school_id = p_school_id and (not p_own or q.requested_by = actor_id)
      order by q.state = 'pending' desc, q.requested_at desc, q.id
      limit 21 offset p_offset
    ) row_data
  ), '[]'::jsonb);
end;
$$;

create function public.request_attendance_correction(
  p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date,
  p_expected_id uuid, p_expected_revision bigint, p_status public.attendance_status, p_reason text, p_request_id uuid
)
returns uuid language sql security invoker set search_path = ''
as $$
  select app_private.request_attendance_correction(p_school_id, p_year_id, p_section_id, p_student_id, p_day,
    p_expected_id, p_expected_revision, p_status, p_reason, p_request_id);
$$;

create function public.review_attendance_correction(p_request_id uuid, p_decision text, p_reason text)
returns text language sql security invoker set search_path = ''
as $$
  select app_private.review_attendance_correction(p_request_id, p_decision, p_reason);
$$;

create function public.list_attendance_corrections(p_school_id uuid, p_offset integer default 0, p_own boolean default false)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select app_private.list_attendance_corrections(p_school_id, p_offset, p_own);
$$;

revoke all on function app_private.attendance_scope_is_current(uuid, uuid, uuid, uuid, date),
  app_private.guard_daily_attendance_write(), app_private.can_review_attendance_corrections(uuid),
  app_private.lock_attendance_correction_scope(uuid, uuid, uuid, uuid, uuid, date),
  app_private.request_attendance_correction(uuid, uuid, uuid, uuid, date, uuid, bigint, public.attendance_status, text, uuid),
  app_private.review_attendance_correction(uuid, text, text), app_private.list_attendance_corrections(uuid, integer, boolean),
  public.request_attendance_correction(uuid, uuid, uuid, uuid, date, uuid, bigint, public.attendance_status, text, uuid),
  public.review_attendance_correction(uuid, text, text), public.list_attendance_corrections(uuid, integer, boolean)
from public, anon, authenticated, service_role;

grant execute on function app_private.attendance_scope_is_current(uuid, uuid, uuid, uuid, date),
  app_private.request_attendance_correction(uuid, uuid, uuid, uuid, date, uuid, bigint, public.attendance_status, text, uuid),
  app_private.review_attendance_correction(uuid, text, text), app_private.list_attendance_corrections(uuid, integer, boolean),
  public.request_attendance_correction(uuid, uuid, uuid, uuid, date, uuid, bigint, public.attendance_status, text, uuid),
  public.review_attendance_correction(uuid, text, text), public.list_attendance_corrections(uuid, integer, boolean)
to authenticated;

commit;
