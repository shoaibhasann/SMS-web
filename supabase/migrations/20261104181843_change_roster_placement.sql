begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.roster_placement_changes (
  school_id uuid not null,
  request_id uuid not null,
  student_id uuid not null,
  source_enrollment_id uuid not null,
  source_year_id uuid not null,
  source_class_id uuid not null,
  source_section_id uuid not null,
  source_roll_no text,
  source_stream_id uuid,
  destination_enrollment_id uuid not null,
  destination_year_id uuid not null,
  destination_class_id uuid not null,
  destination_section_id uuid not null,
  change_kind text not null check (change_kind in ('move', 'promotion')),
  effective_date date not null,
  reason text not null check (char_length(reason) between 5 and 300),
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (school_id, request_id)
);

create unique index roster_one_move_per_enrollment_day
  on app_private.roster_placement_changes (source_enrollment_id, effective_date)
  where change_kind = 'move';
create index roster_placement_changes_scope
  on app_private.roster_placement_changes (school_id, source_year_id, source_class_id, source_section_id, changed_at desc);
create index roster_placement_changes_destination
  on app_private.roster_placement_changes (school_id, destination_enrollment_id);
create index roster_staged_by_source
  on app_private.roster_placement_changes (source_enrollment_id)
  where change_kind = 'promotion';

alter table app_private.roster_placement_changes enable row level security;
revoke all on table app_private.roster_placement_changes from public, anon, authenticated, service_role;

-- Existing admission RPCs run as the owner. Direct browser mutations must
-- keep prior placement and lifecycle intact and cannot create a staged row.
create function app_private.guard_roster_placement()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Use the school enrollment workflow to preserve roster history.' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if (new.id, new.student_id, new.academic_year_id, new.class_id, new.section_id, new.stream_id, new.status, new.enrolled_at)
      is distinct from (old.id, old.student_id, old.academic_year_id, old.class_id, old.section_id, old.stream_id, old.status, old.enrolled_at)
      or (old.status <> 'active' and new.roll_no is distinct from old.roll_no) then
      raise exception 'Use the school enrollment workflow to change this placement.' using errcode = '42501';
    end if;
  else
    perform 1 from public.students s
    join public.academic_years y on y.school_id = s.school_id
    join public.classes c on c.school_id = s.school_id
    left join public.sections sec on sec.id = new.section_id and sec.school_id = s.school_id and sec.class_id = c.id
    where s.id = new.student_id and y.id = new.academic_year_id and y.is_current
      and c.id = new.class_id and c.is_active and (new.section_id is null or sec.id is not null)
    for share of y;
    if not found or new.status <> 'active' then
      raise exception 'Use the school enrollment workflow to create this placement.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

create trigger guard_roster_placement before insert or update or delete on public.enrollments
for each row execute function app_private.guard_roster_placement();

-- Family and teacher content policies also follow enrollments in caller scope.
-- Staging cannot open next-session data until the school activates the session.
alter policy enrollments_parent_children on public.enrollments
using (
  status not in ('staged', 'cancelled') and exists (
    select 1 from public.student_parents sp
    where sp.student_id = enrollments.student_id and sp.parent_id = app_private.current_parent_id()
  )
);
alter policy enrollments_student_own on public.enrollments
using (status not in ('staged', 'cancelled') and student_id = app_private.current_student_id());
alter policy enrollments_teacher_assigned_read on public.enrollments
using (
  status not in ('staged', 'cancelled') and app_private.is_teacher() and exists (
    select 1 from public.teacher_subject_assignments a
    where a.teacher_id = app_private.current_teacher_id() and a.academic_year_id = enrollments.academic_year_id
      and a.class_id = enrollments.class_id and (a.section_id is null or a.section_id = enrollments.section_id)
  )
);

create function app_private.change_roster_placement(
  p_school_id uuid, p_source_enrollment_id uuid, p_expected_class_id uuid, p_expected_section_id uuid,
  p_destination_academic_year_id uuid, p_destination_class_id uuid, p_destination_section_id uuid,
  p_reason text, p_request_id uuid
)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  reason_text text := pg_catalog.btrim(pg_catalog.regexp_replace(p_reason, '[[:space:]]+', ' ', 'g'));
  previous_change app_private.roster_placement_changes%rowtype;
  source public.enrollments%rowtype;
  source_year public.academic_years%rowtype;
  destination_year public.academic_years%rowtype;
  destination_id uuid;
  source_display_roll text;
  kind text;
  effective_on date;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;
  if not found or p_school_id is null then
    raise exception 'You cannot change placements for this school.' using errcode = '42501';
  end if;
  if p_request_id is null or reason_text is null or char_length(reason_text) not between 5 and 300
    or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Enter a placement change reason between 5 and 300 characters.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'roster-placement:' || p_school_id::text || ':' || p_request_id::text, 0));
  select * into previous_change from app_private.roster_placement_changes
  where school_id = p_school_id and request_id = p_request_id;
  if found then
    if (previous_change.source_enrollment_id, previous_change.source_class_id, previous_change.source_section_id,
      previous_change.destination_year_id, previous_change.destination_class_id, previous_change.destination_section_id,
      previous_change.reason, previous_change.changed_by)
      is distinct from (p_source_enrollment_id, p_expected_class_id, p_expected_section_id,
      p_destination_academic_year_id, p_destination_class_id, p_destination_section_id, reason_text, actor_id) then
      raise exception 'This placement request already has a different change.' using errcode = '23505';
    end if;
    return previous_change.destination_enrollment_id;
  end if;

  -- Lock the school year rows before enrollment so activation can serialize
  -- against both promotion staging and ordinary placement changes.
  select y.* into source_year from public.academic_years y
  join public.enrollments e on e.academic_year_id = y.id and e.id = p_source_enrollment_id
  join public.students s on s.id = e.student_id and s.school_id = y.school_id
  where y.school_id = p_school_id and y.is_current;
  if not found then
    raise exception 'The source placement is no longer active in the current academic year. Reload the roster.' using errcode = '22023';
  end if;

  perform 1 from public.academic_years y
  where y.school_id = p_school_id and y.id in (source_year.id, p_destination_academic_year_id)
  order by y.id for share;
  select * into source_year from public.academic_years where id = source_year.id and school_id = p_school_id;
  select * into destination_year from public.academic_years where id = p_destination_academic_year_id and school_id = p_school_id;
  if source_year.is_current is distinct from true or destination_year.id is null then
    raise exception 'Choose an available academic year in this school.' using errcode = '22023';
  end if;

  select e.* into source from public.enrollments e
  join public.students s on s.id = e.student_id and s.school_id = p_school_id and s.status = 'active'
  join public.classes c on c.id = e.class_id and c.school_id = p_school_id
  join public.sections sec on sec.id = e.section_id and sec.class_id = c.id and sec.school_id = p_school_id
  where e.id = p_source_enrollment_id and e.academic_year_id = source_year.id and e.status = 'active'
    and e.class_id = p_expected_class_id and e.section_id = p_expected_section_id
  for update of e for share of s, c, sec;
  if not found then
    raise exception 'The source placement is no longer active in the selected class and section. Reload the roster.' using errcode = '22023';
  end if;

  perform 1 from public.classes c
  join public.sections sec on sec.id = p_destination_section_id and sec.class_id = c.id and sec.school_id = c.school_id
  where c.id = p_destination_class_id and c.school_id = p_school_id and c.is_active
  for share of c, sec;
  if not found then
    raise exception 'Choose an active destination class and section in this school.' using errcode = '22023';
  end if;

  if exists (
    select 1 from app_private.attendance_corrections q
    where q.school_id = p_school_id and q.student_id = source.student_id
      and q.academic_year_id = source_year.id and q.state = 'pending'
  ) then
    raise exception 'Resolve pending attendance corrections before changing this placement.' using errcode = '55000';
  end if;

  source_display_roll := source.roll_no;
  if source_display_roll is null and not exists (
    select 1 from app_private.roster_placement_changes ch
    where ch.school_id = p_school_id and ch.destination_enrollment_id = source.id
  ) then
    select roll_no into source_display_roll from public.students where id = source.student_id;
  end if;

  if destination_year.id = source_year.id then
    if (source.class_id, source.section_id) = (p_destination_class_id, p_destination_section_id) then
      raise exception 'Choose a different destination class or section.' using errcode = '22023';
    end if;
    if today not between source_year.start_date and source_year.end_date then
      raise exception 'A same-session placement change requires a current session in progress.' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.attendance a where a.school_id = p_school_id and a.student_id = source.student_id
        and a.academic_year_id = source_year.id and a.attendance_date >= today
    ) then
      raise exception 'Attendance already exists for today or later. Change placement on a day before marking attendance.' using errcode = '55000';
    end if;
    if exists (
      select 1 from app_private.roster_placement_changes ch where ch.source_enrollment_id = source.id
        and ch.change_kind = 'move' and ch.effective_date >= today
    ) then
      raise exception 'This pupil already changed placement today. Reload the roster.' using errcode = '55000';
    end if;

    kind := 'move';
    effective_on := today;
    update public.enrollments
    set class_id = p_destination_class_id, section_id = p_destination_section_id, roll_no = null,
      stream_id = case when class_id = p_destination_class_id then stream_id else null end
    where id = source.id returning id into destination_id;
  else
    if destination_year.is_current or destination_year.start_date <= source_year.end_date then
      raise exception 'Choose a later academic year that starts after the current year ends.' using errcode = '22023';
    end if;

    kind := 'promotion';
    effective_on := destination_year.start_date;
    insert into public.enrollments as target (student_id, academic_year_id, class_id, section_id, status)
    values (source.student_id, destination_year.id, p_destination_class_id, p_destination_section_id, 'staged')
    on conflict (student_id, academic_year_id) do update
      set class_id = excluded.class_id, section_id = excluded.section_id, roll_no = null, stream_id = null
      where target.status = 'staged'
        and (target.class_id, target.section_id) is distinct from (excluded.class_id, excluded.section_id)
        and exists (
          select 1 from app_private.roster_placement_changes ch
          where ch.school_id = p_school_id and ch.source_enrollment_id = source.id
            and ch.destination_enrollment_id = target.id and ch.change_kind = 'promotion'
        )
    returning target.id into destination_id;
    if destination_id is null then
      if exists (
        select 1 from public.enrollments e
        where e.student_id = source.student_id and e.academic_year_id = destination_year.id and e.status = 'staged'
          and (e.class_id, e.section_id) = (p_destination_class_id, p_destination_section_id)
      ) then
        raise exception 'This pupil already has this staged placement.' using errcode = '23505';
      end if;
      raise exception 'This pupil already has an enrollment in the destination year.' using errcode = '23505';
    end if;
  end if;

  insert into app_private.roster_placement_changes (
    school_id, request_id, student_id, source_enrollment_id, source_year_id, source_class_id, source_section_id,
    source_roll_no, source_stream_id, destination_enrollment_id, destination_year_id, destination_class_id,
    destination_section_id, change_kind, effective_date, reason, changed_by
  ) values (
    p_school_id, p_request_id, source.student_id, source.id, source_year.id, source.class_id, source.section_id,
    source_display_roll, source.stream_id, destination_id, destination_year.id, p_destination_class_id,
    p_destination_section_id, kind, effective_on, reason_text, actor_id
  );
  return destination_id;
end;
$function$;

-- When an office withdrawal follows staging, retain the promotion record and
-- cancel its destination so activating the session cannot reinstate the pupil.
create function app_private.cancel_staged_roster_promotion()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  update public.enrollments target set status = 'cancelled'
  from app_private.roster_placement_changes change_row
  where change_row.change_kind = 'promotion' and change_row.source_enrollment_id = new.id
    and target.id = change_row.destination_enrollment_id and target.status = 'staged';
  return new;
end;
$function$;
create trigger cancel_staged_roster_promotion after update of status on public.enrollments
for each row when (old.status = 'active' and new.status = 'withdrawn')
execute function app_private.cancel_staged_roster_promotion();

create function app_private.list_roster_placement_changes(
  p_school_id uuid, p_academic_year_id uuid, p_class_id uuid, p_section_id uuid
)
returns table (
  request_id uuid, student_name text, admission_no text, change_kind text, destination_year_name text,
  destination_class_name text, destination_section_name text, effective_date date, reason text,
  changed_by_name text, changed_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if not app_private.can_review_attendance_corrections(p_school_id) then
    raise exception 'You cannot view placement changes for this school.' using errcode = '42501';
  end if;
  return query
  select ch.request_id, pg_catalog.concat_ws(' ', s.first_name, s.middle_name, s.last_name), s.admission_no,
    ch.change_kind, y.name, c.name, sec.name, ch.effective_date, ch.reason, coalesce(p.full_name, 'School staff'), ch.changed_at
  from app_private.roster_placement_changes ch
  join public.students s on s.id = ch.student_id and s.school_id = ch.school_id
  join public.academic_years y on y.id = ch.destination_year_id and y.school_id = ch.school_id
  join public.classes c on c.id = ch.destination_class_id and c.school_id = ch.school_id
  join public.sections sec on sec.id = ch.destination_section_id and sec.school_id = ch.school_id and sec.class_id = c.id
  left join public.profiles p on p.id = ch.changed_by
  where ch.school_id = p_school_id and ch.source_year_id = p_academic_year_id
    and ch.source_class_id = p_class_id and ch.source_section_id = p_section_id
  order by ch.changed_at desc, ch.request_id limit 100;
end;
$function$;


create function app_private.teacher_owns_attendance_register(
  p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid
)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select (p_student_id is null or exists (
    select 1 from public.students s where s.id = p_student_id and s.school_id = p_school_id
  )) and exists (
    select 1 from public.teacher_subject_assignments a
    join public.teachers t on t.id = a.teacher_id and t.school_id = p_school_id
    join public.profiles p on p.id = t.profile_id and p.is_active
    join public.user_roles ur on ur.user_id = p.id and ur.school_id = p_school_id and ur.role = 'teacher'
    where t.profile_id = (select auth.uid()) and a.academic_year_id = p_year_id
      and a.section_id = p_section_id and a.is_class_teacher
      and app_private.assignment_scope_is_coherent(t.id, p_year_id, a.class_id, p_section_id, a.subject_id, true)
  );
$function$;

-- Match the register the mark belongs to, not the student's present section.
-- Today's write trigger separately checks the pupil's active placement.
alter policy attendance_class_teacher_manage on public.attendance to authenticated
using (app_private.teacher_owns_attendance_register(school_id, academic_year_id, section_id, student_id))
with check (app_private.teacher_owns_attendance_register(school_id, academic_year_id, section_id, student_id));

create function app_private.list_attendance_register_students(
  p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_day date
)
returns table (id uuid, first_name text, middle_name text, last_name text, admission_no text, roll_no text)
language plpgsql stable security definer set search_path = ''
as $function$
declare
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  if not app_private.can_review_attendance_corrections(p_school_id)
    and not app_private.teacher_owns_attendance_register(p_school_id, p_year_id, p_section_id, null) then
    raise exception 'You cannot read this attendance register.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.academic_years y
    join public.classes c on c.id = p_class_id and c.school_id = y.school_id
    join public.sections sec on sec.id = p_section_id and sec.school_id = y.school_id and sec.class_id = c.id
    where y.id = p_year_id and y.school_id = p_school_id and p_day between y.start_date and y.end_date
  ) then
    raise exception 'Choose a date and section in this school session.' using errcode = '22023';
  end if;

  return query
  with dated_roster as (
    select e.student_id,
      case when next_move.source_enrollment_id is not null then next_move.source_roll_no
        when exists (
          select 1 from app_private.roster_placement_changes ch
          where ch.school_id = p_school_id and ch.destination_enrollment_id = e.id
        ) then e.roll_no
        else coalesce(e.roll_no, s.roll_no)
      end as dated_roll
    from public.enrollments e
    join public.students s on s.id = e.student_id and s.school_id = p_school_id
    left join app_private.enrollment_withdrawals w on w.enrollment_id = e.id and w.school_id = p_school_id
    left join lateral (
      select ch.source_enrollment_id, ch.source_class_id, ch.source_section_id, ch.source_roll_no
      from app_private.roster_placement_changes ch
      where ch.school_id = p_school_id and ch.source_enrollment_id = e.id
        and ch.change_kind = 'move' and ch.effective_date > p_day
      order by ch.effective_date limit 1
    ) next_move on true
    where e.academic_year_id = p_year_id
      and (e.status = 'active' or (e.status = 'withdrawn' and p_day < today
        and p_day <= (w.withdrawn_at at time zone 'Asia/Kolkata')::date))
      and coalesce(next_move.source_class_id, e.class_id) = p_class_id
      and coalesce(next_move.source_section_id, e.section_id) = p_section_id
  )
  select s.id, s.first_name, s.middle_name, s.last_name, s.admission_no, d.dated_roll
  from dated_roster d join public.students s on s.id = d.student_id
  union all
  select s.id, s.first_name, s.middle_name, s.last_name, s.admission_no, null::text
  from public.attendance a
  join public.students s on s.id = a.student_id and s.school_id = p_school_id
  where p_day < today and a.school_id = p_school_id and a.academic_year_id = p_year_id
    and a.section_id = p_section_id and a.attendance_date = p_day
    and not exists (select 1 from dated_roster d where d.student_id = a.student_id);
end;
$function$;

create or replace function app_private.lock_attendance_correction_scope(
  p_teacher_user uuid, p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date
)
returns boolean language plpgsql set search_path = ''
as $function$
begin
  perform 1 from public.enrollments e
  join public.students s on s.id = e.student_id and s.school_id = p_school_id
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = p_school_id
  join public.sections sec on sec.id = p_section_id and sec.school_id = p_school_id
  join public.classes c on c.id = sec.class_id and c.school_id = p_school_id
  join public.teacher_subject_assignments a on a.academic_year_id = y.id and a.class_id = c.id
    and a.section_id = sec.id and a.is_class_teacher
  join public.teachers t on t.id = a.teacher_id and t.school_id = p_school_id and t.profile_id = p_teacher_user
  join public.profiles p on p.id = t.profile_id and p.is_active
  join public.user_roles ur on ur.user_id = p.id and ur.school_id = p_school_id and ur.role = 'teacher'
  left join lateral (
    select ch.source_class_id, ch.source_section_id from app_private.roster_placement_changes ch
    where ch.school_id = p_school_id and ch.source_enrollment_id = e.id
      and ch.change_kind = 'move' and ch.effective_date > p_day
    order by ch.effective_date limit 1
  ) next_move on true
  where e.student_id = p_student_id and e.academic_year_id = p_year_id
    and coalesce(next_move.source_class_id, e.class_id) = c.id
    and coalesce(next_move.source_section_id, e.section_id) = sec.id
    and e.status = 'active' and s.status = 'active' and y.is_current and p_day between y.start_date and y.end_date
    and app_private.assignment_scope_is_coherent(t.id, y.id, c.id, sec.id, a.subject_id, true)
  for share of e, s, y, sec, c, a, t, p, ur;
  return found;
end;
$function$;

create function public.change_roster_placement(
  p_school_id uuid, p_source_enrollment_id uuid, p_expected_class_id uuid, p_expected_section_id uuid,
  p_destination_academic_year_id uuid, p_destination_class_id uuid, p_destination_section_id uuid,
  p_reason text, p_request_id uuid
)
returns uuid language sql security invoker set search_path = ''
as $function$
  select app_private.change_roster_placement(
    p_school_id, p_source_enrollment_id, p_expected_class_id, p_expected_section_id,
    p_destination_academic_year_id, p_destination_class_id, p_destination_section_id, p_reason, p_request_id
  );
$function$;

create function public.list_roster_placement_changes(
  p_school_id uuid, p_academic_year_id uuid, p_class_id uuid, p_section_id uuid
)
returns table (
  request_id uuid, student_name text, admission_no text, change_kind text, destination_year_name text,
  destination_class_name text, destination_section_name text, effective_date date, reason text,
  changed_by_name text, changed_at timestamptz
)
language sql stable security invoker set search_path = ''
as $function$
  select * from app_private.list_roster_placement_changes(p_school_id, p_academic_year_id, p_class_id, p_section_id);
$function$;

create function public.list_attendance_register_students(
  p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_day date
)
returns table (id uuid, first_name text, middle_name text, last_name text, admission_no text, roll_no text)
language sql stable security invoker set search_path = ''
as $function$
  select * from app_private.list_attendance_register_students(p_school_id, p_year_id, p_class_id, p_section_id, p_day);
$function$;

revoke all on function
  app_private.guard_roster_placement(), app_private.cancel_staged_roster_promotion(),
  app_private.teacher_owns_attendance_register(uuid, uuid, uuid, uuid),
  app_private.change_roster_placement(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid),
  public.change_roster_placement(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid),
  app_private.list_roster_placement_changes(uuid, uuid, uuid, uuid),
  public.list_roster_placement_changes(uuid, uuid, uuid, uuid),
  app_private.list_attendance_register_students(uuid, uuid, uuid, uuid, date),
  public.list_attendance_register_students(uuid, uuid, uuid, uuid, date)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.teacher_owns_attendance_register(uuid, uuid, uuid, uuid),
  app_private.change_roster_placement(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid),
  public.change_roster_placement(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, uuid),
  app_private.list_roster_placement_changes(uuid, uuid, uuid, uuid),
  public.list_roster_placement_changes(uuid, uuid, uuid, uuid),
  app_private.list_attendance_register_students(uuid, uuid, uuid, uuid, date),
  public.list_attendance_register_students(uuid, uuid, uuid, uuid, date)
to authenticated;

commit;
