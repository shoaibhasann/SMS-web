-- Pupil names and admission numbers are shown as plain text everywhere (gate,
-- reports, PDFs). Reject control and invisible bidi/isolate marks on every write
-- path (admission, CSV import, teacher registration, future edit RPCs), with the
-- character class the gate workspace uses. Only changed values are checked, so
-- existing rows stay maintainable and can be cleaned.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_private.reject_student_identity_format_marks()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
declare
  candidates text[];
begin
  if tg_op = 'INSERT' then
    candidates := array[new.first_name, new.middle_name, new.last_name, new.admission_no];
  else
    candidates := array[
      case when new.first_name is distinct from old.first_name then new.first_name end,
      case when new.middle_name is distinct from old.middle_name then new.middle_name end,
      case when new.last_name is distinct from old.last_name then new.last_name end,
      case when new.admission_no is distinct from old.admission_no then new.admission_no end];
  end if;
  if exists (select 1 from pg_catalog.unnest(candidates) as candidate(value)
    where candidate.value ~ '[[:cntrl:]]' or candidate.value ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]') then
    raise exception 'Enter a valid admission number and student name.' using errcode = '22023';
  end if;
  return new;
end;
$function$;

revoke all on function app_private.reject_student_identity_format_marks() from public, anon, authenticated, service_role;

create trigger students_reject_identity_format_marks
before insert or update of first_name, middle_name, last_name, admission_no on public.students
for each row execute function app_private.reject_student_identity_format_marks();

commit;
