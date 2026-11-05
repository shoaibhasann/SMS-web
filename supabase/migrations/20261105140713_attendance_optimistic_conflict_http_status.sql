begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Intentional business conflicts map to HTTP 409. SQLSTATE 40001 is reserved
-- for actual serialization failures and is retried by PostgREST 14.
CREATE OR REPLACE FUNCTION app_private.request_attendance_correction(p_school_id uuid, p_year_id uuid, p_section_id uuid, p_student_id uuid, p_day date, p_expected_id uuid, p_expected_revision bigint, p_status attendance_status, p_reason text, p_request_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'Attendance changed since you opened the register. Reload before requesting a correction.' using errcode = 'PT409';
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
$function$;

CREATE OR REPLACE FUNCTION app_private.review_attendance_correction(p_request_id uuid, p_decision text, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      raise exception 'The original attendance changed. Reject this request and ask the teacher to reload.' using errcode = 'PT409';
    end if;

    if correction.before_record is null then
      insert into public.attendance (school_id, academic_year_id, section_id, student_id, attendance_date, status, marked_by)
      values (correction.school_id, correction.academic_year_id, correction.section_id, correction.student_id,
        correction.attendance_date, correction.requested_status, actor_id)
      on conflict (student_id, attendance_date) do nothing
      returning * into existing_mark;
      if not found then
        raise exception 'Attendance was added while this request was reviewed.' using errcode = 'PT409';
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
$function$;

commit;
