begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Missing rows have no tuple lock: every reviewed historical writer must join the calendar's school-wide fence.
do $patch$declare definition text;original text;needle text;replacement text;begin
 definition:=pg_get_functiondef('app_private.review_attendance_correction(uuid,text,text)'::regprocedure);
 original:=definition;
 needle:=E'  select * into correction from app_private.attendance_corrections\n  where id = p_request_id for update;';
 replacement:=E'  perform pg_advisory_xact_lock_shared(hashtextextended(\'school-attendance-calendar:\'||correction.school_id::text,0));\n  actor_id:=app_private.attendance_calendar_actor(correction.school_id);\n  if not exists(select 1 from public.user_roles where user_id=actor_id and school_id=correction.school_id and role in(\'school_admin\',\'principal\')) then\n    raise exception \'Current School Admin or Principal review access is required.\' using errcode=\'42501\';end if;\n'||needle;
 if position('Current School Admin or Principal review access' in definition)=0 or position(needle in definition)=0
  or position('school-attendance-calendar:' in definition)>0 then
  raise exception 'Attendance correction review lock contract changed.';end if;
 definition:=replace(definition,needle,replacement);
 if definition=original or position('pg_advisory_xact_lock_shared' in definition)>position('where id = p_request_id for update;' in definition) then
  raise exception 'Attendance correction review must acquire the calendar lock before any row lock.';end if;
 execute definition;
end;$patch$;
notify pgrst,'reload schema';
commit;
