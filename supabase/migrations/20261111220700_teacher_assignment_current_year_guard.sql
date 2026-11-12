-- API-role teaching assignment writes must target the school's current academic year,
-- so a tab left open across a year activation cannot add or edit rows in the archived session.
-- Trusted backend/migration writes (no API role) are unchanged; deletes are unaffected.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function app_private.validate_teacher_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  -- SHARE locks also serialize non-key ownership changes by trusted backends.
  perform 1 from public.teachers where id=new.teacher_id for share;
  perform 1 from public.academic_years where id=new.academic_year_id for share;
  perform 1 from public.classes where id=new.class_id for share;
  perform 1 from public.subjects where id=new.subject_id for share;
  if new.section_id is not null then
    perform 1 from public.sections where id=new.section_id for share;
  end if;
  -- SECURITY DEFINER changes current_user, but the role GUC still names the API role.
  if pg_catalog.current_setting('role',true) in ('authenticated','anon')
    and not exists (select 1 from public.academic_years y where y.id=new.academic_year_id and y.is_current) then
    raise exception 'Choose the current academic year for this school.' using errcode='22023';
  end if;
  if not app_private.assignment_scope_is_coherent(new.teacher_id,new.academic_year_id,
    new.class_id,new.section_id,new.subject_id,new.is_class_teacher) then
    raise exception 'Assignment teacher, year, class, subject and section must form one school scope; class teachers require a section.';
  end if;
  return new;
end;
$function$;

commit;
