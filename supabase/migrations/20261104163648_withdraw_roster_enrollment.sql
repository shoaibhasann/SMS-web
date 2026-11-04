begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.enrollment_withdrawals (
  enrollment_id uuid primary key references public.enrollments(id),
  student_id uuid not null,
  school_id uuid not null,
  academic_year_id uuid not null,
  class_id uuid not null,
  section_id uuid not null,
  reason text not null check (char_length(reason) between 5 and 300),
  withdrawn_by uuid not null,
  withdrawn_at timestamptz not null default clock_timestamp()
);

create index enrollment_withdrawals_scope_idx
  on app_private.enrollment_withdrawals (school_id, academic_year_id, class_id, section_id, withdrawn_at desc);
alter table app_private.enrollment_withdrawals enable row level security;
revoke all on table app_private.enrollment_withdrawals from public, anon, authenticated, service_role;

create function app_private.guard_roster_withdrawal_status()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'withdrawn' then return new; end if;
  elsif new.status is distinct from 'withdrawn' and old.status is distinct from 'withdrawn' then
    return new;
  elsif (new.id, new.student_id, new.academic_year_id, new.class_id, new.section_id, new.status)
    is not distinct from (old.id, old.student_id, old.academic_year_id, old.class_id, old.section_id, old.status) then
    return new;
  end if;

  if exists (
    select 1 from pg_catalog.pg_roles r
    where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)
  ) or exists (
    select 1
    from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
    where c.oid = tg_relid and r.rolname = current_user and not c.relforcerowsecurity
  ) then
    return new;
  end if;

  raise exception 'Use the school withdrawal workflow to change this enrollment.' using errcode = '42501';
end;
$function$;

create trigger guard_roster_withdrawal_status
before insert or update of id, student_id, academic_year_id, class_id, section_id, status on public.enrollments
for each row execute function app_private.guard_roster_withdrawal_status();

create function app_private.withdraw_roster_enrollment(
  p_school_id uuid, p_academic_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_student_id uuid, p_reason text
)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  reason_text text := pg_catalog.btrim(pg_catalog.regexp_replace(p_reason, '[[:space:]]+', ' ', 'g'));
  enrollment public.enrollments%rowtype;
begin
  perform 1
  from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;

  if not found then
    raise exception 'You cannot withdraw students for this school.' using errcode = '42501';
  end if;
  if reason_text is null or pg_catalog.length(reason_text) not between 5 and 300 or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Enter a withdrawal reason between 5 and 300 characters.' using errcode = '22023';
  end if;

  select e.* into enrollment
  from public.enrollments e
  join public.students s on s.id = e.student_id and s.school_id = p_school_id
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
  join public.classes c on c.id = e.class_id and c.school_id = s.school_id
  join public.sections section_row on section_row.id = e.section_id
    and section_row.school_id = s.school_id and section_row.class_id = c.id
  where e.student_id = p_student_id and e.academic_year_id = p_academic_year_id
    and e.class_id = p_class_id and e.section_id = p_section_id
  for update of e for share of s, y, c, section_row;

  if not found then
    raise exception 'The student is no longer enrolled in the selected current-year class and section.' using errcode = '22023';
  end if;
  if enrollment.status = 'withdrawn' and exists (
    select 1 from app_private.enrollment_withdrawals w
    where w.enrollment_id = enrollment.id and w.withdrawn_by = actor_id and w.reason = reason_text
  ) then
    return enrollment.id;
  end if;
  if enrollment.status is distinct from 'active' then
    raise exception 'This enrollment is no longer active.' using errcode = '22023';
  end if;

  update public.enrollments set status = 'withdrawn' where id = enrollment.id;
  insert into app_private.enrollment_withdrawals (
    enrollment_id, student_id, school_id, academic_year_id, class_id, section_id, reason, withdrawn_by
  ) values (
    enrollment.id, p_student_id, p_school_id, p_academic_year_id, p_class_id, p_section_id, reason_text, actor_id
  );
  return enrollment.id;
end;
$function$;

create function app_private.list_roster_withdrawals(
  p_school_id uuid, p_academic_year_id uuid, p_class_id uuid, p_section_id uuid
)
returns table(enrollment_id uuid, student_name text, admission_no text, reason text, withdrawn_by_name text, withdrawn_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if not exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = (select auth.uid())
      and ((ur.role = 'super_admin' and ur.school_id is null)
        or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  ) then
    raise exception 'You cannot view withdrawals for this school.' using errcode = '42501';
  end if;

  return query
  select w.enrollment_id, pg_catalog.concat_ws(' ', s.first_name, s.middle_name, s.last_name),
    s.admission_no, w.reason, coalesce(p.full_name, 'School staff'), w.withdrawn_at
  from app_private.enrollment_withdrawals w
  join public.students s on s.id = w.student_id and s.school_id = w.school_id
  left join public.profiles p on p.id = w.withdrawn_by
  where w.school_id = p_school_id and w.academic_year_id = p_academic_year_id
    and w.class_id = p_class_id and w.section_id = p_section_id
  order by w.withdrawn_at desc, w.enrollment_id limit 100;
end;
$function$;

create function public.withdraw_roster_enrollment(
  p_school_id uuid, p_academic_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_student_id uuid, p_reason text
)
returns uuid language sql security invoker set search_path = ''
as $function$
  select app_private.withdraw_roster_enrollment(
    p_school_id, p_academic_year_id, p_class_id, p_section_id, p_student_id, p_reason
  );
$function$;

create function public.list_roster_withdrawals(
  p_school_id uuid, p_academic_year_id uuid, p_class_id uuid, p_section_id uuid
)
returns table(enrollment_id uuid, student_name text, admission_no text, reason text, withdrawn_by_name text, withdrawn_at timestamptz)
language sql stable security invoker set search_path = ''
as $function$
  select * from app_private.list_roster_withdrawals(p_school_id, p_academic_year_id, p_class_id, p_section_id);
$function$;

revoke all on function app_private.guard_roster_withdrawal_status()
  from public, anon, authenticated, service_role;
revoke all on function
  app_private.withdraw_roster_enrollment(uuid, uuid, uuid, uuid, uuid, text),
  public.withdraw_roster_enrollment(uuid, uuid, uuid, uuid, uuid, text),
  app_private.list_roster_withdrawals(uuid, uuid, uuid, uuid),
  public.list_roster_withdrawals(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  app_private.withdraw_roster_enrollment(uuid, uuid, uuid, uuid, uuid, text),
  public.withdraw_roster_enrollment(uuid, uuid, uuid, uuid, uuid, text),
  app_private.list_roster_withdrawals(uuid, uuid, uuid, uuid),
  public.list_roster_withdrawals(uuid, uuid, uuid, uuid)
  to authenticated;

commit;
