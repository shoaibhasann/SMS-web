-- A pending attendance correction can only be approved while the enrollment is
-- active, so withdrawal is blocked until it is reviewed, matching the placement
-- guard and its 55000 code (web-people#5). Copied from
-- 20261104163648_withdraw_roster_enrollment.sql; only the pending check is new.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function app_private.withdraw_roster_enrollment(
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
  if exists (
    select 1 from app_private.attendance_corrections q
    where q.school_id = p_school_id and q.student_id = p_student_id
      and q.academic_year_id = p_academic_year_id and q.state = 'pending'
  ) then
    raise exception 'Resolve this pupil''s pending attendance corrections before withdrawing.' using errcode = '55000';
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

commit;
