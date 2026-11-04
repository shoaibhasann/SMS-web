begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.academic_year_activations (
  academic_year_id uuid primary key references public.academic_years(id),
  school_id uuid not null references public.schools(id),
  previous_year_id uuid not null references public.academic_years(id),
  reason text not null check (pg_catalog.char_length(reason) between 5 and 300),
  promoted_count integer not null check (promoted_count >= 0),
  actor_id uuid not null,
  activated_at timestamptz not null default clock_timestamp()
);
alter table app_private.academic_year_activations enable row level security;
revoke all on table app_private.academic_year_activations from public, anon, authenticated, service_role;

-- Initial school setup can still create its first current year. Subsequent
-- session changes go through the activation transaction.
create function app_private.guard_academic_year_calendar()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then
      raise exception 'Academic years cannot be deleted by school accounts.' using errcode = '42501';
    elsif tg_op = 'UPDATE' and
      (new.id, new.school_id, new.start_date, new.end_date, new.is_current)
        is distinct from (old.id, old.school_id, old.start_date, old.end_date, old.is_current) then
      raise exception 'Use the academic year activation workflow to switch sessions.' using errcode = '42501';
    elsif tg_op = 'INSERT' and new.is_current and exists (
      select 1 from public.academic_years y where y.school_id = new.school_id
    ) then
      raise exception 'Only the first academic year can be created as current.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger guard_academic_year_calendar
before insert or update or delete on public.academic_years
for each row execute function app_private.guard_academic_year_calendar();

create function app_private.academic_year_activation_checks(
  p_school_id uuid, p_previous_year_id uuid, p_academic_year_id uuid
)
returns table (unplaced integer, invalid_placements integer, pending_corrections integer, destination_count integer)
language sql stable set search_path = ''
as $$
  with source as (
    select e.student_id from public.enrollments e
    join public.students s on s.id = e.student_id and s.school_id = p_school_id and s.status = 'active'
    where e.academic_year_id = p_previous_year_id and e.status = 'active'
  ),
  destination as (
    select e.student_id,
      c.id is not null and sec.id is not null and source.student_id is not null as valid
    from public.enrollments e
    left join source on source.student_id = e.student_id
    left join public.classes c on c.id = e.class_id and c.school_id = p_school_id and c.is_active
    left join public.sections sec on sec.id = e.section_id and sec.school_id = p_school_id and sec.class_id = c.id
    where e.academic_year_id = p_academic_year_id and e.status in ('staged', 'active')
  )
  select
    (select count(*)::integer from source where not exists (
      select 1 from destination d where d.student_id = source.student_id and d.valid
    )),
    (select count(*)::integer from destination d where not d.valid),
    (select count(*)::integer from app_private.attendance_corrections q
      where q.school_id = p_school_id and q.academic_year_id = p_previous_year_id and q.state = 'pending'),
    (select count(*)::integer from destination d where d.valid);
$$;

create function app_private.preview_academic_year_activation(
  p_school_id uuid, p_previous_year_id uuid, p_academic_year_id uuid
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  checks record;
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  destination public.academic_years%rowtype;
begin
  if not app_private.can_review_attendance_corrections(p_school_id) then
    raise exception 'You cannot activate academic years for this school.' using errcode = '42501';
  end if;

  select target.* into destination
  from public.academic_years target
  join public.academic_years source on source.id = p_previous_year_id
    and source.school_id = target.school_id and source.is_current
  where target.school_id = p_school_id and target.id = p_academic_year_id
    and not target.is_current and target.start_date > source.end_date;
  if not found then
    raise exception 'Choose a later academic year that starts after the current year ends.' using errcode = '22023';
  end if;

  select * into checks from app_private.academic_year_activation_checks(
    p_school_id, p_previous_year_id, p_academic_year_id
  );
  return pg_catalog.to_jsonb(checks) || pg_catalog.jsonb_build_object(
    'can_start_today', today between destination.start_date and destination.end_date
  );
end;
$$;

create function app_private.activate_academic_year(
  p_school_id uuid, p_previous_year_id uuid, p_academic_year_id uuid, p_reason text
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  reason_text text := pg_catalog.btrim(p_reason);
  checks jsonb;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = v_actor_id and ((ur.school_id = p_school_id and ur.role in ('school_admin', 'principal'))
    or (ur.school_id is null and ur.role = 'super_admin'))
  for share of ur, p;
  if not found then
    raise exception 'You cannot activate academic years for this school.' using errcode = '42501';
  end if;
  if reason_text is null or pg_catalog.char_length(reason_text) not between 5 and 300 then
    raise exception 'Enter an activation reason of 5 to 300 characters.' using errcode = '22023';
  end if;

  -- Serialize with both year promotion and requests for the outgoing year.
  perform 1 from public.academic_years y
  where y.school_id = p_school_id and y.id in (p_previous_year_id, p_academic_year_id)
  order by y.id for update;
  if exists (
    select 1 from app_private.academic_year_activations a
    join public.academic_years y on y.id = a.academic_year_id and y.is_current
    where a.school_id = p_school_id and a.academic_year_id = p_academic_year_id
      and a.previous_year_id = p_previous_year_id and a.actor_id = v_actor_id and a.reason = reason_text
  ) then return p_academic_year_id; end if;

  perform 1 from public.students s
  join public.enrollments e on e.student_id = s.id and e.academic_year_id = p_previous_year_id
  where s.school_id = p_school_id
  order by s.id for share of s;
  perform 1 from public.enrollments e
  join public.classes c on c.id = e.class_id and c.school_id = p_school_id
  join public.sections sec on sec.id = e.section_id and sec.school_id = p_school_id and sec.class_id = c.id
  where e.academic_year_id = p_academic_year_id and e.status in ('staged', 'active')
  order by c.id, sec.id for share of c, sec;

  checks := app_private.preview_academic_year_activation(p_school_id, p_previous_year_id, p_academic_year_id);
  if not (checks->>'can_start_today')::boolean then
    raise exception 'The selected academic year must include today in IST.' using errcode = '22023';
  end if;
  if (checks->>'unplaced')::integer > 0 or (checks->>'invalid_placements')::integer > 0 then
    raise exception 'Resolve missing or invalid student placements before activating the year.' using errcode = '22023';
  end if;
  if (checks->>'pending_corrections')::integer > 0 then
    raise exception 'Review pending attendance corrections before activating the year.' using errcode = '22023';
  end if;

  update public.enrollments set status = 'active'
  where academic_year_id = p_academic_year_id and status = 'staged';
  update public.academic_years set is_current = false where id = p_previous_year_id;
  update public.academic_years set is_current = true where id = p_academic_year_id;
  insert into app_private.academic_year_activations
    (academic_year_id, school_id, previous_year_id, reason, promoted_count, actor_id)
  values (p_academic_year_id, p_school_id, p_previous_year_id, reason_text, (checks->>'destination_count')::integer, v_actor_id);
  return p_academic_year_id;
end;
$$;

create function public.preview_academic_year_activation(p_school_id uuid, p_previous_year_id uuid, p_academic_year_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.preview_academic_year_activation(p_school_id, p_previous_year_id, p_academic_year_id); $$;

create function public.activate_academic_year(p_school_id uuid, p_previous_year_id uuid, p_academic_year_id uuid, p_reason text)
returns uuid language sql security invoker set search_path = ''
as $$ select app_private.activate_academic_year(p_school_id, p_previous_year_id, p_academic_year_id, p_reason); $$;

revoke all on function app_private.guard_academic_year_calendar(),
  app_private.academic_year_activation_checks(uuid, uuid, uuid),
  app_private.preview_academic_year_activation(uuid, uuid, uuid),
  app_private.activate_academic_year(uuid, uuid, uuid, text),
  public.preview_academic_year_activation(uuid, uuid, uuid),
  public.activate_academic_year(uuid, uuid, uuid, text)
from public, anon, authenticated, service_role;

grant execute on function app_private.preview_academic_year_activation(uuid, uuid, uuid),
  app_private.activate_academic_year(uuid, uuid, uuid, text),
  public.preview_academic_year_activation(uuid, uuid, uuid),
  public.activate_academic_year(uuid, uuid, uuid, text) to authenticated;

-- The governed assignment rules already enforce both constraints per year.
-- Retaining the global versions would block the same teacher or section in
-- the new session unless historic assignments were removed.
do $$
begin
  if to_regclass('public.teacher_one_class_teacher_idx') is not null
    and to_regclass('public.uq_one_class_teacher_per_teacher_year') is null then
    raise exception 'Missing the year-scoped teacher assignment index.';
  end if;
  if to_regclass('public.section_one_class_teacher_idx') is not null
    and to_regclass('public.uq_one_class_teacher_per_class_section_year') is null then
    raise exception 'Missing the year-scoped section assignment index.';
  end if;
end;
$$;

drop index if exists public.teacher_one_class_teacher_idx;
drop index if exists public.section_one_class_teacher_idx;

commit;
