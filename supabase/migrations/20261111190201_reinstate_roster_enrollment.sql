-- A School Admin or Principal can reverse a current-year withdrawal on the same pupil
-- record and admission number. The withdrawal row moves into an audited reinstatement
-- record (so a later withdrawal can be recorded again and attendance summaries stop
-- treating the active enrollment as unverified), and the staged next-year promotion that
-- the withdrawal cancelled is restored.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.enrollment_reinstatements (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id),
  student_id uuid not null,
  school_id uuid not null,
  academic_year_id uuid not null,
  class_id uuid not null,
  section_id uuid not null,
  withdrawal_reason text not null,
  withdrawn_by uuid not null,
  withdrawn_at timestamptz not null,
  reason text not null check (char_length(reason) between 5 and 300),
  reinstated_by uuid not null,
  reinstated_at timestamptz not null default clock_timestamp()
);
create index enrollment_reinstatements_school_idx on app_private.enrollment_reinstatements (school_id, reinstated_at desc);
create index enrollment_reinstatements_enrollment_idx on app_private.enrollment_reinstatements (enrollment_id, reinstated_at desc);
alter table app_private.enrollment_reinstatements enable row level security;
revoke all on table app_private.enrollment_reinstatements from public, anon, authenticated, service_role;

create function app_private.reinstate_roster_enrollment(p_school_id uuid, p_enrollment_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  reason_text text := pg_catalog.btrim(pg_catalog.regexp_replace(p_reason, '[[:space:]]+', ' ', 'g'));
  enrollment public.enrollments%rowtype;
  withdrawal app_private.enrollment_withdrawals%rowtype;
begin
  perform 1
  from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;

  if not found then
    raise exception 'You cannot reinstate students for this school.' using errcode = '42501';
  end if;
  if reason_text is null or pg_catalog.length(reason_text) not between 5 and 300 or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Enter a reinstatement reason between 5 and 300 characters.' using errcode = '22023';
  end if;

  select e.* into enrollment
  from public.enrollments e
  join public.students s on s.id = e.student_id and s.school_id = p_school_id and s.status = 'active'
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
  join public.classes c on c.id = e.class_id and c.school_id = s.school_id
  join public.sections section_row on section_row.id = e.section_id
    and section_row.school_id = s.school_id and section_row.class_id = c.id
  where e.id = p_enrollment_id
  for update of e for share of s, y, c, section_row;

  if not found then
    raise exception 'Only a current-year withdrawal can be reinstated.' using errcode = '22023';
  end if;
  if enrollment.status = 'active' and exists (
    select 1 from (
      select r.reinstated_by, r.reason from app_private.enrollment_reinstatements r
      where r.enrollment_id = enrollment.id order by r.reinstated_at desc, r.id desc limit 1
    ) latest
    where latest.reinstated_by = actor_id and latest.reason = reason_text
  ) then
    return enrollment.id;
  end if;
  if enrollment.status is distinct from 'withdrawn' then
    raise exception 'This enrollment is not withdrawn.' using errcode = '22023';
  end if;

  select w.* into withdrawal
  from app_private.enrollment_withdrawals w
  where w.enrollment_id = enrollment.id and w.school_id = p_school_id
  for update;
  if not found then
    raise exception 'This withdrawal has no recorded workflow evidence and cannot be reinstated here.' using errcode = '22023';
  end if;

  insert into app_private.enrollment_reinstatements (
    enrollment_id, student_id, school_id, academic_year_id, class_id, section_id,
    withdrawal_reason, withdrawn_by, withdrawn_at, reason, reinstated_by
  ) values (
    enrollment.id, withdrawal.student_id, withdrawal.school_id, withdrawal.academic_year_id, withdrawal.class_id,
    withdrawal.section_id, withdrawal.reason, withdrawal.withdrawn_by, withdrawal.withdrawn_at, reason_text, actor_id
  );
  delete from app_private.enrollment_withdrawals where enrollment_id = enrollment.id;
  update public.enrollments set status = 'active' where id = enrollment.id;

  -- Undo cancel_staged_roster_promotion for this pupil while the next session is still unopened.
  update public.enrollments target set status = 'staged'
  from app_private.roster_placement_changes change_row
  join public.academic_years target_year on target_year.id = change_row.destination_year_id and not target_year.is_current
  where change_row.school_id = p_school_id and change_row.change_kind = 'promotion'
    and change_row.source_enrollment_id = enrollment.id
    and target.id = change_row.destination_enrollment_id and target.status = 'cancelled';

  return enrollment.id;
end;
$function$;

create function public.reinstate_roster_enrollment(p_school_id uuid, p_enrollment_id uuid, p_reason text)
returns uuid language sql security invoker set search_path = ''
as $function$ select app_private.reinstate_roster_enrollment(p_school_id, p_enrollment_id, p_reason); $function$;

revoke all on function
  app_private.reinstate_roster_enrollment(uuid, uuid, text),
  public.reinstate_roster_enrollment(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function
  app_private.reinstate_roster_enrollment(uuid, uuid, text),
  public.reinstate_roster_enrollment(uuid, uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
