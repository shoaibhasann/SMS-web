begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- A pupil Holiday mark on a configured working day is an invalid working-day status that withholds
-- the official rate; closures belong in the school calendar. Existing legacy Holiday rows may still move away.
create or replace function app_private.guard_attendance_calendar_native_write()
returns trigger language plpgsql security invoker set search_path=''
as $$declare day jsonb;begin
 if current_user in('authenticated','anon') then
  day:=app_private.attendance_calendar_native_day(new.school_id,new.attendance_date,
   new.status='holiday' or(tg_op='UPDATE' and old.status='holiday'));
  -- native_day already rejects configured closed days, so configured here means a working day.
  if new.status='holiday' and(tg_op='INSERT' or old.status is distinct from 'holiday')
   and coalesce((day->>'configured')::boolean,false) then
   raise exception 'This is a school working day in the calendar. Declare a school closure in the school calendar instead of marking pupils Holiday.'
    using errcode='22023';
  end if;
 end if;
 return new;
end;$$;
revoke all on function app_private.guard_attendance_calendar_native_write() from public,anon,authenticated,service_role;

commit;
