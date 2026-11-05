begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.substitute_attendance_coverages (
  id uuid primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  source_assignment_id uuid not null,
  source_teacher_id uuid not null,
  substitute_teacher_id uuid not null,
  academic_year_id uuid not null,
  class_id uuid not null,
  section_id uuid not null,
  subject_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  reason text not null check (char_length(reason) between 5 and 300),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text check (char_length(revoke_reason) between 5 and 300),
  check (isfinite(starts_on) and isfinite(ends_on) and starts_on <= ends_on),
  check (source_teacher_id <> substitute_teacher_id),
  check ((revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and revoked_by is not null and revoke_reason is not null))
);
alter table app_private.substitute_attendance_coverages enable row level security;
revoke all on app_private.substitute_attendance_coverages from public, anon, authenticated, service_role;
create index substitute_attendance_source_dates
  on app_private.substitute_attendance_coverages (source_assignment_id, starts_on, ends_on) where revoked_at is null;
create index substitute_attendance_recipient_dates
  on app_private.substitute_attendance_coverages (substitute_teacher_id, starts_on, ends_on) where revoked_at is null;
create index substitute_attendance_school_history
  on app_private.substitute_attendance_coverages (school_id, academic_year_id, created_at desc, id);

create function app_private.coverage_scope_is_current(p_coverage_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from app_private.substitute_attendance_coverages coverage
    join public.teacher_subject_assignments source on source.id = coverage.source_assignment_id
      and (source.teacher_id, source.academic_year_id, source.class_id, source.section_id, source.subject_id, source.is_class_teacher)
        is not distinct from (coverage.source_teacher_id, coverage.academic_year_id, coverage.class_id, coverage.section_id, coverage.subject_id, true)
    join public.teachers original on original.id = source.teacher_id and original.school_id = coverage.school_id
    join public.teachers substitute on substitute.id = coverage.substitute_teacher_id and substitute.school_id = coverage.school_id
    join public.profiles profile on profile.id = substitute.profile_id and profile.is_active and profile.school_id = coverage.school_id
    join public.user_roles membership on membership.user_id = profile.id and membership.school_id = coverage.school_id and membership.role = 'teacher'
    join public.academic_years year on year.id = coverage.academic_year_id and year.school_id = coverage.school_id and year.is_current
    join public.classes class on class.id = coverage.class_id and class.school_id = coverage.school_id and class.is_active
    join public.sections section on section.id = coverage.section_id and section.school_id = coverage.school_id and section.class_id = class.id
    join public.subjects subject on subject.id = coverage.subject_id and subject.school_id = coverage.school_id and subject.is_active
    where coverage.id = p_coverage_id and coverage.starts_on >= year.start_date and coverage.ends_on <= year.end_date
  );
$$;

create function app_private.my_active_attendance_coverages(p_day date)
returns setof app_private.substitute_attendance_coverages
language sql stable security definer set search_path = ''
as $$
  select coverage.* from app_private.substitute_attendance_coverages coverage
  join public.teachers substitute on substitute.id = coverage.substitute_teacher_id and substitute.profile_id = (select auth.uid())
  where coverage.revoked_at is null
    and (statement_timestamp() at time zone 'Asia/Kolkata')::date between coverage.starts_on and coverage.ends_on
    and p_day between coverage.starts_on and coverage.ends_on
    and app_private.coverage_scope_is_current(coverage.id);
$$;

create function app_private.can_manage_substitute_attendance(p_school_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select p_school_id is not null and exists (
    select 1 from public.user_roles membership
    join public.profiles profile on profile.id = membership.user_id and profile.is_active
    where membership.user_id = (select auth.uid())
      and ((membership.role = 'super_admin' and membership.school_id is null)
        or (membership.school_id = p_school_id and membership.role in ('school_admin', 'principal')))
  );
$$;

create function app_private.create_substitute_attendance_coverage(
  p_school_id uuid, p_source_assignment_id uuid, p_substitute_teacher_id uuid,
  p_starts_on date, p_ends_on date, p_reason text, p_request_id uuid
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  source public.teacher_subject_assignments%rowtype;
  year public.academic_years%rowtype;
  existing app_private.substitute_attendance_coverages%rowtype;
  note text := btrim(p_reason);
begin
  perform 1 from public.user_roles membership
  join public.profiles profile on profile.id = membership.user_id and profile.is_active
  where membership.user_id = actor and ((membership.role = 'super_admin' and membership.school_id is null)
    or (membership.school_id = p_school_id and membership.role in ('school_admin','principal')))
  for share of membership, profile;
  if not found then raise exception 'School administrator or principal access is required.' using errcode = '42501'; end if;
  if p_request_id is null or note is null or char_length(note) not between 5 and 300
    or p_starts_on is null or p_ends_on is null or not isfinite(p_starts_on) or not isfinite(p_ends_on)
    or p_ends_on < p_starts_on then
    raise exception 'Choose today or a future start date, an end date, and a reason of 5 to 300 characters.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('substitute-attendance-request:' || p_request_id::text, 0));
  select * into existing from app_private.substitute_attendance_coverages where id = p_request_id;
  if found then
    if (existing.school_id, existing.source_assignment_id, existing.substitute_teacher_id, existing.starts_on, existing.ends_on, existing.reason, existing.created_by)
      is distinct from (p_school_id, p_source_assignment_id, p_substitute_teacher_id, p_starts_on, p_ends_on, note, actor) then
      raise exception 'This coverage request already belongs to another action.' using errcode = '23505';
    end if;
    return existing.id;
  end if;
  if p_starts_on < today then
    raise exception 'Coverage must start today or in the future.' using errcode = '22023';
  end if;

  select assignment.* into source from public.teacher_subject_assignments assignment
  join public.teachers teacher on teacher.id = assignment.teacher_id and teacher.school_id = p_school_id
  join public.academic_years session on session.id = assignment.academic_year_id and session.school_id = p_school_id and session.is_current
  join public.classes class on class.id = assignment.class_id and class.school_id = p_school_id and class.is_active
  join public.sections section on section.id = assignment.section_id and section.school_id = p_school_id and section.class_id = class.id
  join public.subjects subject on subject.id = assignment.subject_id and subject.school_id = p_school_id and subject.is_active
  where assignment.id = p_source_assignment_id and assignment.is_class_teacher
  for share of assignment, teacher, session, class, section, subject;
  if not found then raise exception 'Choose a current class-teacher assignment in this school.' using errcode = '42501'; end if;
  select * into year from public.academic_years where id = source.academic_year_id;
  if today not between year.start_date and year.end_date or p_starts_on < year.start_date or p_ends_on > year.end_date then
    raise exception 'Coverage dates must be within the active academic year.' using errcode = '22023';
  end if;
  if p_substitute_teacher_id = source.teacher_id then
    raise exception 'Choose a different teacher as the substitute.' using errcode = '22023';
  end if;
  perform 1 from public.teachers teacher
  join public.profiles profile on profile.id = teacher.profile_id and profile.school_id = p_school_id and profile.is_active
  join public.user_roles membership on membership.user_id = profile.id and membership.school_id = p_school_id and membership.role = 'teacher'
  where teacher.id = p_substitute_teacher_id and teacher.school_id = p_school_id
  for share of teacher, profile, membership;
  if not found then raise exception 'Choose a linked active teacher in this school.' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended('substitute-attendance-source:' || source.id::text, 0));
  if exists (
    select 1 from app_private.substitute_attendance_coverages coverage
    where coverage.source_assignment_id = source.id and coverage.revoked_at is null
      and coverage.starts_on <= p_ends_on and coverage.ends_on >= p_starts_on
  ) then raise exception 'This class already has substitute coverage in that date range.' using errcode = '23505'; end if;

  insert into app_private.substitute_attendance_coverages
    (id, school_id, source_assignment_id, source_teacher_id, substitute_teacher_id, academic_year_id,
      class_id, section_id, subject_id, starts_on, ends_on, reason, created_by)
  values (p_request_id, p_school_id, source.id, source.teacher_id, p_substitute_teacher_id, source.academic_year_id,
    source.class_id, source.section_id, source.subject_id, p_starts_on, p_ends_on, note, actor);
  return p_request_id;
end;
$$;

create function app_private.revoke_substitute_attendance_coverage(p_school_id uuid, p_coverage_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  note text := btrim(p_reason);
  coverage app_private.substitute_attendance_coverages%rowtype;
begin
  perform 1 from public.user_roles membership
  join public.profiles profile on profile.id = membership.user_id and profile.is_active
  where membership.user_id = auth.uid() and ((membership.role = 'super_admin' and membership.school_id is null)
    or (membership.school_id = p_school_id and membership.role in ('school_admin','principal')))
  for share of membership, profile;
  if not found then raise exception 'School administrator or principal access is required.' using errcode = '42501'; end if;
  if note is null or char_length(note) not between 5 and 300 then
    raise exception 'Enter a revocation reason of 5 to 300 characters.' using errcode = '22023';
  end if;
  select * into coverage from app_private.substitute_attendance_coverages
  where id = p_coverage_id and school_id = p_school_id for update;
  if not found then raise exception 'This coverage is outside your school.' using errcode = '42501'; end if;
  if coverage.revoked_at is not null then return false; end if;
  update app_private.substitute_attendance_coverages set revoked_at = clock_timestamp(), revoked_by = auth.uid(), revoke_reason = note
  where id = coverage.id;
  return true;
end;
$$;

create function app_private.get_substitute_attendance_setup(p_school_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  year public.academic_years%rowtype;
begin
  if not app_private.can_manage_substitute_attendance(p_school_id) then
    raise exception 'School administrator or principal access is required.' using errcode = '42501';
  end if;
  if (select count(*) from public.academic_years where school_id = p_school_id and is_current) <> 1 then
    raise exception 'Set exactly one current academic year first.' using errcode = '55000';
  end if;
  select * into year from public.academic_years where school_id = p_school_id and is_current;
  return jsonb_build_object('today', (statement_timestamp() at time zone 'Asia/Kolkata')::date,
    'year', jsonb_build_object('id', year.id, 'name', year.name, 'start_date', year.start_date, 'end_date', year.end_date),
    'teachers', (
      select coalesce(jsonb_agg(to_jsonb(row) order by row.full_name, row.id), '[]'::jsonb) from (
        select teacher.id, teacher.full_name, teacher.employee_id from public.teachers teacher
        join public.profiles profile on profile.id = teacher.profile_id and profile.school_id = p_school_id and profile.is_active
        where teacher.school_id = p_school_id and exists (
          select 1 from public.user_roles membership where membership.user_id = profile.id and membership.school_id = p_school_id and membership.role = 'teacher'
        )
      ) row
    ),
    'assignments', (
      select coalesce(jsonb_agg(to_jsonb(row) order by row.class_name, row.section_name, row.id), '[]'::jsonb) from (
        select assignment.id, assignment.teacher_id, coalesce(teacher.full_name, teacher.employee_id) as teacher_name,
          class.id as class_id, class.name as class_name, section.id as section_id, section.name as section_name,
          subject.id as subject_id, subject.name as subject_name
        from public.teacher_subject_assignments assignment
        join public.teachers teacher on teacher.id = assignment.teacher_id and teacher.school_id = p_school_id
        join public.classes class on class.id = assignment.class_id and class.school_id = p_school_id and class.is_active
        join public.sections section on section.id = assignment.section_id and section.school_id = p_school_id and section.class_id = class.id
        join public.subjects subject on subject.id = assignment.subject_id and subject.school_id = p_school_id and subject.is_active
        where assignment.academic_year_id = year.id and assignment.is_class_teacher
      ) row
    ),
    'coverages', (
      select coalesce(jsonb_agg(to_jsonb(row) order by row.created_at desc, row.id), '[]'::jsonb) from (
        select coverage.id, coverage.source_assignment_id, coverage.substitute_teacher_id,
          coalesce(substitute.full_name, substitute.employee_id, 'Former teacher') as substitute_teacher_name,
          coalesce(original.full_name, original.employee_id, 'Former teacher') as source_teacher_name,
          coalesce(class.name, 'Former class') as class_name, coalesce(section.name, 'Former section') as section_name,
          coverage.starts_on, coverage.ends_on, coverage.reason, coverage.created_at, actor.full_name as created_by_name,
          coverage.revoked_at, coverage.revoke_reason,
          case when coverage.revoked_at is not null then 'revoked'
            when not app_private.coverage_scope_is_current(coverage.id) then 'invalid'
            when (statement_timestamp() at time zone 'Asia/Kolkata')::date < coverage.starts_on then 'scheduled'
            when (statement_timestamp() at time zone 'Asia/Kolkata')::date > coverage.ends_on then 'expired'
            else 'active' end as status
        from app_private.substitute_attendance_coverages coverage
        left join public.teachers substitute on substitute.id = coverage.substitute_teacher_id
        left join public.teachers original on original.id = coverage.source_teacher_id
        left join public.classes class on class.id = coverage.class_id
        left join public.sections section on section.id = coverage.section_id
        left join public.profiles actor on actor.id = coverage.created_by
        where coverage.school_id = p_school_id and coverage.academic_year_id = year.id
          and ((coverage.revoked_at is null and coverage.ends_on >= (statement_timestamp() at time zone 'Asia/Kolkata')::date)
            or coverage.id in (
              select historic.id from app_private.substitute_attendance_coverages historic
              where historic.school_id = p_school_id and historic.academic_year_id = year.id
                and (historic.revoked_at is not null or historic.ends_on < (statement_timestamp() at time zone 'Asia/Kolkata')::date)
              order by historic.created_at desc, historic.id limit 100
            ))
        order by coverage.created_at desc, coverage.id
      ) row
    )
  );
end;
$$;

create function app_private.list_my_effective_attendance_assignments()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(row) order by row.class_name, row.section_name, row.id), '[]'::jsonb) from (
    select source.id, teacher.id as teacher_id, source.academic_year_id, source.class_id, source.section_id, source.subject_id,
      true as is_class_teacher, class.name as class_name, section.name as section_name, subject.name as subject_name,
      null::uuid as coverage_id, null::date as starts_on, null::date as ends_on
    from public.teacher_subject_assignments source
    join public.teachers teacher on teacher.id = source.teacher_id and teacher.profile_id = (select auth.uid())
    join public.academic_years year on year.id = source.academic_year_id and year.school_id = teacher.school_id and year.is_current
    join public.classes class on class.id = source.class_id and class.school_id = teacher.school_id
    join public.sections section on section.id = source.section_id and section.school_id = teacher.school_id and section.class_id = class.id
    join public.subjects subject on subject.id = source.subject_id and subject.school_id = teacher.school_id
    where source.is_class_teacher and app_private.is_own_school_teacher(teacher.id)
    union all
    select coverage.source_assignment_id, coverage.substitute_teacher_id, coverage.academic_year_id, coverage.class_id,
      coverage.section_id, coverage.subject_id, true, class.name, section.name, subject.name,
      coverage.id, coverage.starts_on, coverage.ends_on
    from app_private.my_active_attendance_coverages((statement_timestamp() at time zone 'Asia/Kolkata')::date) coverage
    join public.classes class on class.id = coverage.class_id
    join public.sections section on section.id = coverage.section_id
    join public.subjects subject on subject.id = coverage.subject_id
  ) row;
$$;

create function app_private.teacher_has_attendance_coverage(
  p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date
)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from app_private.my_active_attendance_coverages(p_day) coverage
    where coverage.school_id = p_school_id and coverage.academic_year_id = p_year_id and coverage.section_id = p_section_id
      and (p_student_id is null or exists (
        select 1 from public.students pupil where pupil.id = p_student_id and pupil.school_id = p_school_id
      ))
  );
$$;

create function app_private.teacher_owns_attendance_register_on(
  p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date
)
returns boolean language sql stable security definer set search_path = ''
as $$
  select app_private.teacher_owns_attendance_register(p_school_id, p_year_id, p_section_id, p_student_id)
    or app_private.teacher_has_attendance_coverage(p_school_id, p_year_id, p_section_id, p_student_id, p_day);
$$;

alter policy attendance_class_teacher_manage on public.attendance to authenticated
using (app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date))
with check (app_private.teacher_owns_attendance_register_on(school_id, academic_year_id, section_id, student_id, attendance_date));

create function app_private.substitute_roster_access(p_student_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from app_private.my_active_attendance_coverages((statement_timestamp() at time zone 'Asia/Kolkata')::date) coverage
    join public.students pupil on pupil.id = p_student_id and pupil.school_id = coverage.school_id and pupil.status = 'active'
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.academic_year_id = coverage.academic_year_id
      and enrollment.class_id = coverage.class_id and enrollment.section_id = coverage.section_id and enrollment.status = 'active'
    where (p_year_id is null or enrollment.academic_year_id = p_year_id)
      and (p_class_id is null or enrollment.class_id = p_class_id)
      and (p_section_id is null or enrollment.section_id = p_section_id)
  );
$$;

create policy enrollments_substitute_attendance_read on public.enrollments for select to authenticated
using (status = 'active' and app_private.substitute_roster_access(student_id, academic_year_id, class_id, section_id));

create policy students_substitute_attendance_read on public.students for select to authenticated
using (app_private.substitute_roster_access(id, null, null, null));

create function app_private.guard_substitute_attendance_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if current_setting('role', true) not in ('authenticated', 'anon') then return new; end if;
  if app_private.can_review_attendance_corrections(new.school_id)
    or app_private.teacher_owns_attendance_register(new.school_id, new.academic_year_id, new.section_id, new.student_id) then
    return new;
  end if;

  -- Hold the coverage and identity locks through the write. Revocation waits
  -- for an authorized save, and a save waiting behind revocation fails closed.
  perform 1 from app_private.substitute_attendance_coverages coverage
  join public.teacher_subject_assignments source on source.id = coverage.source_assignment_id
    and (source.teacher_id, source.academic_year_id, source.class_id, source.section_id, source.subject_id, source.is_class_teacher)
      is not distinct from (coverage.source_teacher_id, coverage.academic_year_id, coverage.class_id, coverage.section_id, coverage.subject_id, true)
  join public.teachers original on original.id = source.teacher_id and original.school_id = coverage.school_id
  join public.teachers teacher on teacher.id = coverage.substitute_teacher_id and teacher.profile_id = auth.uid() and teacher.school_id = coverage.school_id
  join public.profiles profile on profile.id = teacher.profile_id and profile.is_active and profile.school_id = coverage.school_id
  join public.user_roles membership on membership.user_id = profile.id and membership.school_id = coverage.school_id and membership.role = 'teacher'
  join public.academic_years year on year.id = coverage.academic_year_id and year.school_id = coverage.school_id and year.is_current
  join public.classes class on class.id = coverage.class_id and class.school_id = coverage.school_id and class.is_active
  join public.sections section on section.id = coverage.section_id and section.school_id = coverage.school_id and section.class_id = class.id
  join public.subjects subject on subject.id = coverage.subject_id and subject.school_id = coverage.school_id and subject.is_active
  where coverage.school_id = new.school_id and coverage.academic_year_id = new.academic_year_id and coverage.section_id = new.section_id
    and coverage.revoked_at is null
    and (statement_timestamp() at time zone 'Asia/Kolkata')::date between coverage.starts_on and coverage.ends_on
    and new.attendance_date between coverage.starts_on and coverage.ends_on
    and coverage.starts_on >= year.start_date and coverage.ends_on <= year.end_date
  for share of coverage, source, original, teacher, profile, membership, year, class, section, subject;
  if not found then raise exception 'Substitute attendance coverage is unavailable for this date and class.' using errcode = '42501'; end if;
  return new;
end;
$$;

create trigger guard_substitute_attendance_write before insert or update on public.attendance
for each row execute function app_private.guard_substitute_attendance_write();

create or replace function app_private.list_attendance_register_students(
  p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_day date
)
returns table (id uuid, first_name text, middle_name text, last_name text, admission_no text, roll_no text)
language plpgsql stable security definer set search_path = ''
as $function$
declare
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  if not app_private.can_review_attendance_corrections(p_school_id)
    and not app_private.teacher_owns_attendance_register_on(p_school_id, p_year_id, p_section_id, null, p_day) then
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

create function public.list_my_effective_attendance_assignments()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_my_effective_attendance_assignments(); $$;
create function public.get_substitute_attendance_setup(p_school_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.get_substitute_attendance_setup(p_school_id); $$;
create function public.create_substitute_attendance_coverage(
  p_school_id uuid, p_source_assignment_id uuid, p_substitute_teacher_id uuid,
  p_starts_on date, p_ends_on date, p_reason text, p_request_id uuid
)
returns uuid language sql security invoker set search_path = ''
as $$ select app_private.create_substitute_attendance_coverage(
  p_school_id, p_source_assignment_id, p_substitute_teacher_id, p_starts_on, p_ends_on, p_reason, p_request_id); $$;
create function public.revoke_substitute_attendance_coverage(p_school_id uuid, p_coverage_id uuid, p_reason text)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.revoke_substitute_attendance_coverage(p_school_id, p_coverage_id, p_reason); $$;

revoke all on function
  app_private.coverage_scope_is_current(uuid),
  app_private.my_active_attendance_coverages(date),
  app_private.can_manage_substitute_attendance(uuid),
  app_private.create_substitute_attendance_coverage(uuid, uuid, uuid, date, date, text, uuid),
  app_private.revoke_substitute_attendance_coverage(uuid, uuid, text),
  app_private.get_substitute_attendance_setup(uuid),
  app_private.list_my_effective_attendance_assignments(),
  app_private.teacher_has_attendance_coverage(uuid, uuid, uuid, uuid, date),
  app_private.teacher_owns_attendance_register_on(uuid, uuid, uuid, uuid, date),
  app_private.substitute_roster_access(uuid, uuid, uuid, uuid),
  app_private.guard_substitute_attendance_write(),
  public.list_my_effective_attendance_assignments(),
  public.get_substitute_attendance_setup(uuid),
  public.create_substitute_attendance_coverage(uuid, uuid, uuid, date, date, text, uuid),
  public.revoke_substitute_attendance_coverage(uuid, uuid, text)
from public, anon, authenticated, service_role;

grant execute on function
  app_private.create_substitute_attendance_coverage(uuid, uuid, uuid, date, date, text, uuid),
  app_private.revoke_substitute_attendance_coverage(uuid, uuid, text),
  app_private.get_substitute_attendance_setup(uuid),
  app_private.list_my_effective_attendance_assignments(),
  app_private.teacher_owns_attendance_register_on(uuid, uuid, uuid, uuid, date),
  app_private.substitute_roster_access(uuid, uuid, uuid, uuid),
  public.list_my_effective_attendance_assignments(),
  public.get_substitute_attendance_setup(uuid),
  public.create_substitute_attendance_coverage(uuid, uuid, uuid, date, date, text, uuid),
  public.revoke_substitute_attendance_coverage(uuid, uuid, text)
to authenticated;

commit;
