-- Pupil identity, status and existence change only through governed workflows
-- (admission, activation, withdrawal). API roles keep non-identity demographic
-- edits; SECURITY DEFINER workflows run as the owner and are unaffected.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_private.guard_student_identity()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
begin
  if current_user in ('authenticated', 'anon')
    and (new.id, new.school_id, new.admission_no, new.status, new.dob, new.registered_mobile,
      new.first_name, new.middle_name, new.last_name)
    is distinct from (old.id, old.school_id, old.admission_no, old.status, old.dob, old.registered_mobile,
      old.first_name, old.middle_name, old.last_name) then
    raise exception 'Use the school pupil workflow to change identity or status.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function app_private.guard_student_identity() from public, anon, authenticated, service_role;

create trigger guard_student_identity before update on public.students
for each row execute function app_private.guard_student_identity();

-- Withdrawal is the only removal path: a raw DELETE would cascade away attendance,
-- enrollments, marks and dues (RI cascades bypass guard_roster_placement).
revoke delete, truncate on public.students from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
