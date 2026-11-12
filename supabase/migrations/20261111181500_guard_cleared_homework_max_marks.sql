-- Clearing max_marks (NULL) on an activity with graded marks slipped past the 'marks>new.max_marks' check, leaving ungradeable marks.
-- Only the transition is refused, so legacy rows already in that state still save unchanged.
-- Read-only pre-deploy check for rows already in that state (restore their maximum manually; not rewritten here):
--   select a.id from public.class_activities a where a.max_marks is null and exists(select 1 from public.activity_submissions s where s.activity_id=a.id and s.marks is not null);
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function app_private.guard_academic_activity_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare log public.class_logs%rowtype; parent_id uuid;
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and (new.id,new.class_log_id) is distinct from (old.id,old.class_log_id) then
    raise exception 'An activity cannot be moved to another log.' using errcode='42501';
  end if;
  parent_id:=case when tg_op='DELETE' then old.class_log_id else new.class_log_id end;
  select * into log from public.class_logs where id=parent_id for update;
  if not found then
    if tg_op='DELETE' then return old; end if;
    raise exception 'The academic parent record is unavailable.' using errcode='42501';
  end if;
  perform app_private.lock_academic_write_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
  if tg_op='DELETE' then
    if exists(select 1 from public.activity_submissions where activity_id=old.id) then
      raise exception 'An activity with student submissions must be preserved.' using errcode='23503';
    end if;
    return old;
  end if;
  if new.max_marks is not null and (new.max_marks<0 or new.max_marks::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Maximum marks must be a finite nonnegative number.' using errcode='22023';
  end if;
  if tg_op='UPDATE' and exists(select 1 from public.activity_submissions where activity_id=old.id)
    and (new.activity_type is distinct from old.activity_type or exists(select 1 from public.activity_submissions where activity_id=old.id and marks is not null and ((new.max_marks is null and old.max_marks is not null) or marks>new.max_marks))) then
    raise exception 'Activity changes would invalidate existing submissions.' using errcode='23503';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_academic_activity_write() from public,anon,authenticated,service_role;

commit;
