begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.attendance_submission_settings (
  school_id uuid primary key references public.schools(id) on delete cascade,
  cutoff_time time(0) without time zone,
  revision bigint not null check (revision > 0),
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  check (extract(second from cutoff_time) = 0)
);

create table app_private.attendance_submission_settings_audit (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  revision bigint not null,
  previous_cutoff_time time(0) without time zone,
  cutoff_time time(0) without time zone,
  reason text not null check (char_length(reason) between 5 and 300),
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  unique (school_id, revision)
);

alter table app_private.attendance_submission_settings enable row level security;
alter table app_private.attendance_submission_settings_audit enable row level security;
revoke all on app_private.attendance_submission_settings,
  app_private.attendance_submission_settings_audit from public, anon, authenticated, service_role;

create function app_private.can_manage_attendance_submission(p_school_id uuid, p_require_admin boolean)
returns boolean language sql stable set search_path = ''
as $$
  select p_school_id is not null and exists (
    select 1 from public.user_roles membership
    join public.profiles profile on profile.id = membership.user_id and profile.is_active
    where membership.user_id = (select auth.uid())
      and ((membership.role = 'super_admin' and membership.school_id is null)
        or (membership.school_id = p_school_id and
          (membership.role = 'school_admin' or (not p_require_admin and membership.role = 'principal'))))
  );
$$;

create function app_private.update_attendance_submission_cutoff(
  p_school_id uuid, p_cutoff_time text, p_expected_revision bigint, p_reason text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  requested_cutoff time(0) without time zone;
  settings app_private.attendance_submission_settings%rowtype;
  expected_revision bigint;
  change_reason text := btrim(p_reason);
begin
  perform 1 from public.user_roles membership
  join public.profiles profile on profile.id = membership.user_id and profile.is_active
  where membership.user_id = (select auth.uid())
    and ((membership.role = 'super_admin' and membership.school_id is null)
      or (membership.school_id = p_school_id and membership.role = 'school_admin'))
  for share of membership, profile;
  if not found then
    raise exception 'A school administrator is required to configure attendance cutoff.' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Reload the attendance cutoff before saving.' using errcode = '22023';
  end if;
  if change_reason is null or char_length(change_reason) not between 5 and 300 then
    raise exception 'Enter a change reason between 5 and 300 characters.' using errcode = '22023';
  end if;
  if p_cutoff_time is not null then
    if p_cutoff_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'Enter a valid cutoff in HH:MM IST.' using errcode = '22023';
    end if;
    requested_cutoff := p_cutoff_time::time;
  end if;

  -- Serialize first writes as well as edits to this school's optional setting.
  perform 1 from public.schools school where school.id = p_school_id for update;
  if not found then
    raise exception 'The selected school is unavailable.' using errcode = '42501';
  end if;
  select * into settings from app_private.attendance_submission_settings
  where school_id = p_school_id;
  expected_revision := coalesce(settings.revision, 0);
  if p_expected_revision <> expected_revision then
    raise exception 'Attendance cutoff changed elsewhere. Refresh before saving.' using errcode = '55000';
  end if;
  if requested_cutoff is not distinct from settings.cutoff_time then
    return jsonb_build_object('cutoff_time', to_char(date '2000-01-01' + settings.cutoff_time, 'HH24:MI'), 'revision', expected_revision);
  end if;

  insert into app_private.attendance_submission_settings (school_id, cutoff_time, revision, updated_by)
  values (p_school_id, requested_cutoff, expected_revision + 1, auth.uid())
  on conflict (school_id) do update set cutoff_time = excluded.cutoff_time,
    revision = excluded.revision, updated_by = excluded.updated_by, updated_at = clock_timestamp();
  insert into app_private.attendance_submission_settings_audit
    (school_id, revision, previous_cutoff_time, cutoff_time, reason, changed_by)
  values (p_school_id, expected_revision + 1, settings.cutoff_time, requested_cutoff, change_reason, auth.uid());

  return jsonb_build_object('cutoff_time', to_char(date '2000-01-01' + requested_cutoff, 'HH24:MI'), 'revision', expected_revision + 1);
end;
$$;

create function app_private.get_attendance_submission_monitor(p_school_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  as_of timestamptz := statement_timestamp();
  local_today date := (as_of at time zone 'Asia/Kolkata')::date;
  current_year public.academic_years%rowtype;
  current_year_count integer;
  settings app_private.attendance_submission_settings%rowtype;
  session_state text;
  cutoff_at timestamptz;
  cutoff_reached boolean;
  roster_issue_count integer := 0;
  registers jsonb := '[]'::jsonb;
begin
  if not app_private.can_manage_attendance_submission(p_school_id, false) then
    raise exception 'School administrator or principal access is required for this attendance monitor.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.schools where id = p_school_id) then
    raise exception 'The selected school is unavailable.' using errcode = '42501';
  end if;

  select * into settings from app_private.attendance_submission_settings where school_id = p_school_id;
  cutoff_at := (local_today + settings.cutoff_time) at time zone 'Asia/Kolkata';
  cutoff_reached := coalesce(as_of >= cutoff_at, false);
  select count(*) into current_year_count from public.academic_years where school_id = p_school_id and is_current;
  if current_year_count = 0 then session_state := 'missing';
  elsif current_year_count > 1 then session_state := 'ambiguous';
  else
    select * into current_year from public.academic_years where school_id = p_school_id and is_current;
    session_state := case when local_today between current_year.start_date and current_year.end_date
      then 'active' else 'outside_dates' end;
  end if;

  if session_state = 'active' then
    -- Surface broken legacy mappings separately instead of counting them as a completed register.
    select count(*) into roster_issue_count
    from public.enrollments enrollment
    join public.students pupil on pupil.id = enrollment.student_id and pupil.status = 'active'
    left join public.classes class on class.id = enrollment.class_id
    left join public.sections section on section.id = enrollment.section_id
    where enrollment.academic_year_id = current_year.id and enrollment.status = 'active'
      and (pupil.school_id is distinct from p_school_id or class.school_id is distinct from p_school_id
        or not class.is_active or section.school_id is distinct from p_school_id
        or section.class_id is distinct from enrollment.class_id);

    with roster as (
      select distinct enrollment.student_id, class.id as class_id, class.name as class_name,
        section.id as section_id, section.name as section_name
      from public.enrollments enrollment
      join public.students pupil on pupil.id = enrollment.student_id and pupil.school_id = p_school_id and pupil.status = 'active'
      join public.classes class on class.id = enrollment.class_id and class.school_id = p_school_id and class.is_active
      join public.sections section on section.id = enrollment.section_id and section.school_id = p_school_id
        and section.class_id = class.id
      where enrollment.academic_year_id = current_year.id and enrollment.status = 'active'
    ), progress as (
      select roster.class_id, roster.class_name, roster.section_id, roster.section_name,
        count(*)::integer as expected_count,
        count(*) filter (where exists (
          select 1 from public.attendance mark
          where mark.student_id = roster.student_id and mark.school_id = p_school_id
            and mark.academic_year_id = current_year.id and mark.section_id = roster.section_id
            and mark.attendance_date = local_today and mark.status is not null
        ))::integer as marked_count
      from roster group by roster.class_id, roster.class_name, roster.section_id, roster.section_name
    )
    select coalesce(jsonb_agg(to_jsonb(register) order by register.class_name, register.section_name, register.section_id), '[]'::jsonb)
    into registers
    from (
      select progress.*, expected_count - marked_count as unmarked_count,
        case when marked_count = expected_count then 'complete'
          when marked_count > 0 then 'partial' else 'unmarked' end as status,
        cutoff_reached and marked_count < expected_count as is_pending
      from progress
    ) register;
  end if;

  return jsonb_build_object('day', local_today, 'as_of', as_of, 'timezone', 'Asia/Kolkata',
    'cutoff_time', to_char(date '2000-01-01' + settings.cutoff_time, 'HH24:MI'), 'cutoff_at', cutoff_at,
    'cutoff_reached', cutoff_reached, 'revision', coalesce(settings.revision, 0),
    'can_edit', app_private.can_manage_attendance_submission(p_school_id, true),
    'session_state', session_state,
    'year', case when current_year.id is not null then jsonb_build_object('id', current_year.id,
      'name', current_year.name, 'start_date', current_year.start_date, 'end_date', current_year.end_date) end,
    'roster_issue_count', roster_issue_count, 'sections', registers);
end;
$$;

create function public.get_attendance_submission_monitor(p_school_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.get_attendance_submission_monitor(p_school_id); $$;

create function public.update_attendance_submission_cutoff(
  p_school_id uuid, p_cutoff_time text, p_expected_revision bigint, p_reason text
)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.update_attendance_submission_cutoff(p_school_id, p_cutoff_time, p_expected_revision, p_reason); $$;

revoke all on function app_private.can_manage_attendance_submission(uuid, boolean),
  app_private.update_attendance_submission_cutoff(uuid, text, bigint, text),
  app_private.get_attendance_submission_monitor(uuid),
  public.get_attendance_submission_monitor(uuid), public.update_attendance_submission_cutoff(uuid, text, bigint, text)
from public, anon, authenticated, service_role;
grant execute on function app_private.update_attendance_submission_cutoff(uuid, text, bigint, text),
  app_private.get_attendance_submission_monitor(uuid), public.get_attendance_submission_monitor(uuid),
  public.update_attendance_submission_cutoff(uuid, text, bigint, text) to authenticated;

commit;
