begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_private.academic_manager(p_school_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles membership
    join public.profiles profile on profile.id = membership.user_id and profile.is_active
    where membership.user_id = (select auth.uid()) and (
      (membership.school_id = p_school_id and membership.role in ('school_admin','principal'))
      or (membership.school_id is null and membership.role = 'super_admin')));
$$;

create function app_private.academic_office_read(p_school_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles membership
    join public.profiles profile on profile.id=membership.user_id and profile.is_active
    where membership.user_id=(select auth.uid()) and (
      (membership.school_id=p_school_id and membership.role in ('school_admin','principal','accountant','reception_staff'))
      or (membership.school_id is null and membership.role='super_admin')));
$$;

create function app_private.academic_log_manager(p_log_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.class_logs log where log.id=p_log_id and app_private.academic_manager(log.school_id));
$$;

create function app_private.teacher_academic_scope(
  p_teacher_id uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_subject_id uuid, p_write boolean default false
) returns boolean language sql stable security definer set search_path = '' as $$
  select p_class_id is not null and p_section_id is not null and p_subject_id is not null and exists (
    select 1 from public.teachers teacher
    join public.profiles profile on profile.id = teacher.profile_id and profile.is_active and profile.school_id = teacher.school_id
    join public.user_roles membership on membership.user_id = profile.id and membership.school_id = teacher.school_id and membership.role = 'teacher'
    join public.teacher_subject_assignments assignment on assignment.teacher_id = teacher.id
    join public.academic_years year on year.id = assignment.academic_year_id and year.school_id = teacher.school_id
    join public.classes class on class.id = assignment.class_id and class.school_id = teacher.school_id
    join public.sections section on section.id = assignment.section_id and section.school_id = teacher.school_id and section.class_id = class.id
    join public.subjects subject on subject.id = assignment.subject_id and subject.school_id = teacher.school_id
    where teacher.id = p_teacher_id and profile.id = (select auth.uid()) and teacher.school_id = p_school_id
      and assignment.class_id = p_class_id and assignment.section_id = p_section_id and assignment.subject_id = p_subject_id
      and (p_year_id is null or assignment.academic_year_id = p_year_id)
      and (not p_write and p_year_id is not null or year.is_current)
      and (not p_write or (class.is_active and subject.is_active))
  );
$$;

create function app_private.lock_academic_write_scope(
  p_teacher_id uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid, p_section_id uuid, p_subject_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if app_private.academic_manager(p_school_id) then
    perform 1 from public.profiles profile join public.user_roles membership on membership.user_id = profile.id
    where profile.id = auth.uid() and profile.is_active and (
      (membership.school_id = p_school_id and membership.role in ('school_admin','principal'))
      or (membership.school_id is null and membership.role = 'super_admin')) for share of profile, membership;
    if not found then raise exception 'Academic management access changed.' using errcode='42501'; end if;
  else
    perform 1 from public.teachers teacher
    join public.profiles profile on profile.id = teacher.profile_id and profile.is_active and profile.school_id = teacher.school_id
    join public.user_roles membership on membership.user_id = profile.id and membership.school_id = teacher.school_id and membership.role='teacher'
    join public.teacher_subject_assignments assignment on assignment.teacher_id = teacher.id
    join public.academic_years year on year.id = assignment.academic_year_id and year.school_id = teacher.school_id and year.is_current
    join public.classes class on class.id = assignment.class_id and class.school_id = teacher.school_id and class.is_active
    join public.sections section on section.id = assignment.section_id and section.school_id = teacher.school_id and section.class_id = class.id
    join public.subjects subject on subject.id = assignment.subject_id and subject.school_id = teacher.school_id and subject.is_active
    where teacher.id = p_teacher_id and teacher.school_id = p_school_id and profile.id = auth.uid()
      and (p_year_id is null or assignment.academic_year_id = p_year_id)
      and assignment.class_id = p_class_id and assignment.section_id = p_section_id and assignment.subject_id = p_subject_id
    for share of teacher, profile, membership, assignment, year, class, section, subject;
    if not found then raise exception 'An active current-session teaching assignment is required.' using errcode='42501'; end if;
  end if;
  -- Check and hold every referenced placement even for office users. UUIDs in
  -- separate foreign keys do not by themselves establish school coherence.
  if p_year_id is not null then
    perform 1 from public.academic_years where id=p_year_id and school_id=p_school_id for share;
    if not found then raise exception 'Academic year is outside this school.' using errcode='42501'; end if;
  end if;
  if p_class_id is not null then
    perform 1 from public.classes where id=p_class_id and school_id=p_school_id for share;
    if not found then raise exception 'Class is outside this school.' using errcode='42501'; end if;
  end if;
  if p_section_id is not null then
    perform 1 from public.sections where id=p_section_id and school_id=p_school_id and class_id=p_class_id for share;
    if not found then raise exception 'Section is outside this class.' using errcode='42501'; end if;
  end if;
  if p_subject_id is not null then
    perform 1 from public.subjects where id=p_subject_id and school_id=p_school_id for share;
    if not found then raise exception 'Subject is outside this school.' using errcode='42501'; end if;
  end if;
  if p_teacher_id is not null then
    perform 1 from public.teachers where id=p_teacher_id and school_id=p_school_id for share;
    if not found then raise exception 'Teacher is outside this school.' using errcode='42501'; end if;
  end if;
end;
$$;

create function app_private.academic_family_scope(p_school_id uuid,p_year_id uuid,p_class_id uuid,p_section_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrollments enrollment
    join public.academic_years year on year.id=enrollment.academic_year_id and year.school_id=p_school_id
    join public.classes class on class.id=enrollment.class_id and class.school_id=p_school_id
    join public.sections section on section.id=enrollment.section_id and section.school_id=p_school_id and section.class_id=class.id
    join public.students student on student.id=enrollment.student_id and student.school_id=p_school_id
    where enrollment.status in ('active','withdrawn')
      and (p_year_id is null or enrollment.academic_year_id=p_year_id)
      and (p_class_id is null or enrollment.class_id=p_class_id)
      and (p_section_id is null or enrollment.section_id=p_section_id)
      and (exists (select 1 from public.profiles profile join public.user_roles membership on membership.user_id=profile.id
        where profile.id=student.profile_id and profile.id=(select auth.uid()) and profile.is_active
          and profile.school_id=p_school_id and membership.school_id=p_school_id and membership.role='student')
        or exists (select 1 from public.student_parents link join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=p_school_id
          join public.profiles profile on profile.id=guardian.profile_id and profile.is_active and profile.school_id=p_school_id
          join public.user_roles membership on membership.user_id=profile.id and membership.school_id=p_school_id and membership.role='parent'
          where link.student_id=student.id and profile.id=(select auth.uid())))
  );
$$;

create function app_private.can_read_academic_log(p_log_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_logs log where log.id=p_log_id and (
    app_private.academic_office_read(log.school_id)
    or app_private.teacher_academic_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,false)
    or (log.status='published' and app_private.academic_family_scope(log.school_id,log.academic_year_id,log.class_id,log.section_id))));
$$;

create function app_private.teacher_academic_activity(p_activity_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    where activity.id=p_activity_id and app_private.teacher_academic_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,p_write));
$$;

create function app_private.teacher_academic_log(p_log_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_logs log where log.id=p_log_id
    and app_private.teacher_academic_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,p_write));
$$;

-- Replace the complete policy sets; permissive legacy owner-only policies must
-- not coexist with the exact-assignment policies and OR around them.
do $$ declare policy record; begin
  for policy in select tablename,policyname from pg_policies where schemaname='public'
    and tablename in ('class_logs','class_activities','study_materials','activity_submissions') loop
    execute format('drop policy %I on public.%I',policy.policyname,policy.tablename);
  end loop;
end $$;
alter table public.class_logs enable row level security;
alter table public.class_activities enable row level security;
alter table public.study_materials enable row level security;
alter table public.activity_submissions enable row level security;

create policy academic_logs_office_read on public.class_logs for select to authenticated
using(app_private.academic_office_read(school_id));
create policy academic_logs_manager on public.class_logs for all to authenticated
using(app_private.academic_manager(school_id)) with check(app_private.academic_manager(school_id));
create policy academic_logs_teacher_read on public.class_logs for select to authenticated
using(app_private.teacher_academic_scope(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id,false));
create policy academic_logs_teacher_insert on public.class_logs for insert to authenticated
with check(app_private.teacher_academic_scope(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id,true));
create policy academic_logs_teacher_update on public.class_logs for update to authenticated
using(app_private.teacher_academic_scope(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id,true))
with check(app_private.teacher_academic_scope(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id,true));
create policy academic_logs_teacher_delete on public.class_logs for delete to authenticated
using(app_private.teacher_academic_scope(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id,true));
create policy academic_logs_family on public.class_logs for select to authenticated
using(status='published' and app_private.academic_family_scope(school_id,academic_year_id,class_id,section_id));

create policy academic_activities_read on public.class_activities for select to authenticated
using(app_private.can_read_academic_log(class_log_id));
create policy academic_activities_manager on public.class_activities for all to authenticated
using(app_private.academic_log_manager(class_log_id)) with check(app_private.academic_log_manager(class_log_id));
create policy academic_activities_teacher_insert on public.class_activities for insert to authenticated
with check(app_private.teacher_academic_log(class_log_id,true));
create policy academic_activities_teacher_update on public.class_activities for update to authenticated
using(app_private.teacher_academic_log(class_log_id,true)) with check(app_private.teacher_academic_log(class_log_id,true));
create policy academic_activities_teacher_delete on public.class_activities for delete to authenticated
using(app_private.teacher_academic_log(class_log_id,true));

create policy academic_materials_office_read on public.study_materials for select to authenticated
using(app_private.academic_office_read(school_id));
create policy academic_materials_manager on public.study_materials for all to authenticated
using(app_private.academic_manager(school_id)) with check(app_private.academic_manager(school_id));
create policy academic_materials_teacher on public.study_materials for all to authenticated
using(app_private.teacher_academic_scope(teacher_id,school_id,null,class_id,section_id,subject_id,false))
with check(app_private.teacher_academic_scope(teacher_id,school_id,null,class_id,section_id,subject_id,true));
create policy academic_materials_family on public.study_materials for select to authenticated
using(published_at is not null and published_at<=statement_timestamp() and app_private.academic_family_scope(school_id,null,class_id,section_id));

create function app_private.guard_academic_log_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op<>'DELETE' then
    new.updated_at:=greatest(clock_timestamp(),case when tg_op='UPDATE' and isfinite(old.updated_at)
      then old.updated_at+interval '1 microsecond' else '-infinity'::timestamptz end);
  end if;
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and (new.id,new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id,new.teacher_id,new.log_date)
    is distinct from (old.id,old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id,old.teacher_id,old.log_date) then
    raise exception 'An academic record cannot be moved to another placement, date or teacher.' using errcode='42501';
  end if;
  if tg_op='DELETE' then
    perform app_private.lock_academic_write_scope(old.teacher_id,old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id);
    if exists (select 1 from public.class_activities activity join public.activity_submissions submission on submission.activity_id=activity.id
      where activity.class_log_id=old.id) then
      raise exception 'This log has student submissions and must be preserved.' using errcode='23503';
    end if;
    return old;
  end if;
  perform app_private.lock_academic_write_scope(new.teacher_id,new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id);
  if not exists(select 1 from public.academic_years year where year.id=new.academic_year_id and new.log_date between year.start_date and year.end_date) then
    raise exception 'Choose a log date within the academic year.' using errcode='22023';
  end if;
  if new.status='published' then
    if tg_op='UPDATE' and old.status='published' then new.published_at:=old.published_at; new.published_by:=old.published_by;
    else new.published_at:=clock_timestamp(); new.published_by:=auth.uid(); end if;
  else new.published_at:=null; new.published_by:=null;
  end if;
  return new;
end;
$$;
create trigger zz_guard_academic_log_write before insert or update or delete on public.class_logs
for each row execute function app_private.guard_academic_log_write();

create function app_private.guard_academic_activity_write()
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
    and (new.activity_type is distinct from old.activity_type or exists(select 1 from public.activity_submissions where activity_id=old.id and marks>new.max_marks)) then
    raise exception 'Activity changes would invalidate existing submissions.' using errcode='23503';
  end if;
  return new;
end;
$$;
create trigger guard_academic_activity_write before insert or update or delete on public.class_activities
for each row execute function app_private.guard_academic_activity_write();

create function app_private.bump_academic_parent_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.class_logs set updated_at=clock_timestamp()
    where id=case when tg_op='DELETE' then old.class_log_id else new.class_log_id end;
  return null;
end;
$$;
create trigger bump_academic_parent_version after insert or update or delete on public.class_activities
for each row execute function app_private.bump_academic_parent_version();

create function app_private.guard_academic_material_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and (new.id,new.school_id,new.class_id,new.section_id,new.subject_id,new.teacher_id)
    is distinct from (old.id,old.school_id,old.class_id,old.section_id,old.subject_id,old.teacher_id) then
    raise exception 'A study material cannot be moved to another placement or teacher.' using errcode='42501';
  end if;
  if tg_op='DELETE' then
    perform app_private.lock_academic_write_scope(old.teacher_id,old.school_id,null,old.class_id,old.section_id,old.subject_id); return old;
  end if;
  perform app_private.lock_academic_write_scope(new.teacher_id,new.school_id,null,new.class_id,new.section_id,new.subject_id); return new;
end;
$$;
create trigger guard_academic_material_write before insert or update or delete on public.study_materials
for each row execute function app_private.guard_academic_material_write();

create function app_private.academic_submission_cohort(p_activity_id uuid,p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    join public.academic_years year on year.id=log.academic_year_id and year.school_id=log.school_id
    join public.classes class on class.id=log.class_id and class.school_id=log.school_id
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=year.id
      and enrollment.class_id=class.id and (log.section_id is null or enrollment.section_id=log.section_id)
    join public.sections section on section.id=enrollment.section_id and section.school_id=log.school_id and section.class_id=class.id
    where activity.id=p_activity_id and activity.activity_type<>'study_material' and enrollment.status in ('active','withdrawn'));
$$;

create function app_private.teacher_academic_submission(p_activity_id uuid,p_student_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.academic_submission_cohort(p_activity_id,p_student_id)
    and app_private.teacher_academic_activity(p_activity_id,p_write);
$$;

create function app_private.student_academic_submission(p_activity_id uuid,p_student_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id and log.status='published'
    join public.academic_years year on year.id=log.academic_year_id and year.school_id=log.school_id
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.profiles profile on profile.id=student.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='student'
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=year.id and enrollment.class_id=log.class_id
      and (log.section_id is null or enrollment.section_id=log.section_id)
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id) and profile.id=(select auth.uid())
      and (not p_write or year.is_current and enrollment.status='active') and enrollment.status in ('active','withdrawn'));
$$;

create function app_private.guardian_academic_submission(p_activity_id uuid,p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id and log.status='published'
    join public.students student on student.id=p_student_id and student.school_id=log.school_id
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=log.academic_year_id
      and enrollment.class_id=log.class_id and (log.section_id is null or enrollment.section_id=log.section_id) and enrollment.status in ('active','withdrawn')
    join public.student_parents link on link.student_id=student.id join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=log.school_id
    join public.profiles profile on profile.id=guardian.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='parent'
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id) and profile.id=(select auth.uid()));
$$;

create function app_private.academic_submission_office(p_activity_id uuid,p_student_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    where activity.id=p_activity_id and app_private.academic_submission_cohort(p_activity_id,p_student_id)
      and (case when p_write then app_private.academic_manager(log.school_id)
      else app_private.academic_office_read(log.school_id) end));
$$;
create policy academic_submissions_office_read on public.activity_submissions for select to authenticated
using(app_private.academic_submission_office(activity_id,student_id,false));
create policy academic_submissions_manager on public.activity_submissions for all to authenticated
using(app_private.academic_submission_office(activity_id,student_id,true)) with check(app_private.academic_submission_office(activity_id,student_id,true));
create policy academic_submissions_teacher_read on public.activity_submissions for select to authenticated
using(app_private.teacher_academic_submission(activity_id,student_id,false));
create policy academic_submissions_teacher_grade on public.activity_submissions for update to authenticated
using(app_private.teacher_academic_submission(activity_id,student_id,true)) with check(app_private.teacher_academic_submission(activity_id,student_id,true));
create policy academic_submissions_student_read on public.activity_submissions for select to authenticated
using(app_private.student_academic_submission(activity_id,student_id,false));
create policy academic_submissions_student_insert on public.activity_submissions for insert to authenticated
with check(app_private.student_academic_submission(activity_id,student_id,true));
create policy academic_submissions_student_update on public.activity_submissions for update to authenticated
using(app_private.student_academic_submission(activity_id,student_id,true)) with check(app_private.student_academic_submission(activity_id,student_id,true));
create policy academic_submissions_guardian_read on public.activity_submissions for select to authenticated
using(app_private.guardian_academic_submission(activity_id,student_id));

create function app_private.guard_academic_submission_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare activity public.class_activities%rowtype; log public.class_logs%rowtype; item public.activity_submissions%rowtype;
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' and (new.id,new.activity_id,new.student_id) is distinct from (old.id,old.activity_id,old.student_id) then
    raise exception 'A submission cannot be reassigned.' using errcode='42501';
  end if;
  if tg_op='DELETE' then item:=old; else item:=new; end if;
  select * into activity from public.class_activities where id=item.activity_id;
  select * into log from public.class_logs where id=activity.class_log_id for share;
  perform 1 from public.class_activities where id=item.activity_id and class_log_id=log.id for share;
  if not found then raise exception 'The homework activity is unavailable.' using errcode='42501'; end if;
  if not app_private.academic_submission_cohort(item.activity_id,item.student_id) then
    raise exception 'The pupil is outside this academic scope.' using errcode='42501';
  end if;
  if app_private.academic_manager(log.school_id) then
    perform app_private.lock_academic_write_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
  elsif app_private.student_academic_submission(item.activity_id,item.student_id,true) then
    if tg_op='DELETE' then raise exception 'Submission history must be preserved.' using errcode='42501'; end if;
    if new.marks is not null or new.feedback is not null or new.status not in ('pending','submitted')
      or (tg_op='UPDATE' and (old.marks is not null or old.feedback is not null or old.status not in ('pending','submitted'))) then
      raise exception 'A pupil cannot set grades or overwrite reviewed work.' using errcode='42501';
    end if;
    perform 1 from public.students student
    join public.profiles profile on profile.id=student.profile_id and profile.is_active and profile.school_id=log.school_id
    join public.user_roles membership on membership.user_id=profile.id and membership.school_id=log.school_id and membership.role='student'
    join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=log.academic_year_id
      and enrollment.class_id=log.class_id and (log.section_id is null or enrollment.section_id=log.section_id) and enrollment.status='active'
    join public.academic_years year on year.id=enrollment.academic_year_id and year.school_id=log.school_id and year.is_current
    where student.id=new.student_id and profile.id=auth.uid() and log.status='published'
    for share of student, profile, membership, enrollment, year;
    if not found then raise exception 'The pupil homework access changed.' using errcode='42501'; end if;
    new.status:='submitted'; new.submitted_at:=clock_timestamp(); return new;
  else
    if tg_op<>'UPDATE' then raise exception 'Only the pupil may submit work.' using errcode='42501'; end if;
    perform app_private.lock_academic_write_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
    if (new.text_response,new.file_url,new.submitted_at) is distinct from (old.text_response,old.file_url,old.submitted_at) then
      raise exception 'A teacher cannot change a pupil response.' using errcode='42501';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.status not in ('pending','submitted','graded','returned') or (new.marks is not null and
    (new.marks<0 or new.marks::text in ('NaN','Infinity','-Infinity') or new.marks>activity.max_marks)) then
    raise exception 'Choose valid feedback, status and marks within the activity maximum.' using errcode='22023';
  end if;
  return new;
end;
$$;
create trigger guard_academic_submission_write before insert or update or delete on public.activity_submissions
for each row execute function app_private.guard_academic_submission_write();

create function app_private.save_academic_log(p_log jsonb,p_activities jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare teacher public.teachers%rowtype; saved public.class_logs%rowtype; log_id uuid; entry jsonb; activity_id uuid; kept uuid[]:='{}';
begin
  if jsonb_typeof(p_log) is distinct from 'object' or jsonb_typeof(p_activities) is distinct from 'array'
    or jsonb_array_length(p_activities)>100 then raise exception 'Invalid academic log payload.' using errcode='22023'; end if;
  select * into teacher from public.teachers where profile_id=auth.uid();
  if not found then raise exception 'A linked teacher is required.' using errcode='42501'; end if;
  if p_log ? 'teacher_id' and p_log->>'teacher_id' is distinct from teacher.id::text then
    raise exception 'The log author cannot be supplied by another teacher.' using errcode='42501';
  end if;
  perform app_private.lock_academic_write_scope(teacher.id,(p_log->>'school_id')::uuid,(p_log->>'academic_year_id')::uuid,
    (p_log->>'class_id')::uuid,(p_log->>'section_id')::uuid,(p_log->>'subject_id')::uuid);
  if coalesce(btrim(p_log->>'topic'),'')='' or char_length(p_log->>'topic')>1000 then
    raise exception 'Enter a topic of 1 to 1000 characters.' using errcode='22023'; end if;
  log_id:=nullif(p_log->>'id','')::uuid;
  if log_id is null then
    insert into public.class_logs(school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,summary,teacher_remark,status)
    values((p_log->>'school_id')::uuid,(p_log->>'academic_year_id')::uuid,(p_log->>'class_id')::uuid,(p_log->>'section_id')::uuid,
      (p_log->>'subject_id')::uuid,teacher.id,(p_log->>'log_date')::date,btrim(p_log->>'topic'),coalesce(btrim(p_log->>'summary'),''),
      nullif(btrim(p_log->>'teacher_remark'),''),coalesce(p_log->>'status','draft')) returning * into saved;
  else
    select * into saved from public.class_logs where id=log_id for update;
    if not found or saved.teacher_id<>teacher.id then raise exception 'This log is unavailable to its author.' using errcode='42501'; end if;
    if nullif(p_log->>'expected_updated_at','') is null then
      raise exception 'Reload this academic log before editing it.' using errcode='22023';
    end if;
    if saved.updated_at is distinct from (p_log->>'expected_updated_at')::timestamptz then
      raise exception 'Academic work changed. Reload before saving your draft.' using errcode='40001';
    end if;
    if (saved.school_id,saved.academic_year_id,saved.class_id,saved.section_id,saved.subject_id,saved.log_date)
      is distinct from ((p_log->>'school_id')::uuid,(p_log->>'academic_year_id')::uuid,(p_log->>'class_id')::uuid,
        (p_log->>'section_id')::uuid,(p_log->>'subject_id')::uuid,(p_log->>'log_date')::date) then
      raise exception 'An academic record cannot be moved to another placement or date.' using errcode='42501';
    end if;
    update public.class_logs set topic=btrim(p_log->>'topic'),summary=coalesce(btrim(p_log->>'summary'),''),
      teacher_remark=nullif(btrim(p_log->>'teacher_remark'),''),status=coalesce(p_log->>'status',saved.status)
    where id=saved.id returning * into saved;
  end if;
  for entry in select value from jsonb_array_elements(p_activities) loop
    if jsonb_typeof(entry) is distinct from 'object' or coalesce(btrim(entry->>'title'),'')='' then
      raise exception 'Every activity needs a title.' using errcode='22023'; end if;
    activity_id:=nullif(entry->>'id','')::uuid;
    if activity_id is null then
      insert into public.class_activities(class_log_id,activity_type,title,description,due_date,attachment_url,max_marks)
      values(saved.id,(entry->>'activity_type')::public.activity_type,btrim(entry->>'title'),entry->>'description',
        nullif(entry->>'due_date','')::date,nullif(entry->>'attachment_url',''),nullif(entry->>'max_marks','')::numeric) returning id into activity_id;
    else
      if activity_id=any(kept) then raise exception 'Duplicate activity identifier.' using errcode='22023'; end if;
      perform 1 from public.class_activities where id=activity_id and class_log_id=saved.id for update;
      if not found then raise exception 'An activity is outside this log.' using errcode='42501'; end if;
      update public.class_activities set activity_type=(entry->>'activity_type')::public.activity_type,title=btrim(entry->>'title'),
        description=entry->>'description',due_date=nullif(entry->>'due_date','')::date,attachment_url=nullif(entry->>'attachment_url',''),
        max_marks=nullif(entry->>'max_marks','')::numeric where id=activity_id;
    end if;
    kept:=array_append(kept,activity_id);
  end loop;
  delete from public.class_activities where class_log_id=saved.id and not(id=any(kept));
  return saved.id;
end;
$$;
create function public.save_academic_log(p_log jsonb,p_activities jsonb)
returns uuid language sql security invoker set search_path = '' as $$ select app_private.save_academic_log(p_log,p_activities); $$;

revoke all on function app_private.academic_manager(uuid),app_private.academic_office_read(uuid),app_private.academic_log_manager(uuid),
  app_private.teacher_academic_scope(uuid,uuid,uuid,uuid,uuid,uuid,boolean),
  app_private.lock_academic_write_scope(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.academic_family_scope(uuid,uuid,uuid,uuid),app_private.can_read_academic_log(uuid),
  app_private.teacher_academic_activity(uuid,boolean),app_private.teacher_academic_log(uuid,boolean),
  app_private.guard_academic_log_write(),app_private.guard_academic_activity_write(),app_private.guard_academic_material_write(),
  app_private.bump_academic_parent_version(),
  app_private.student_academic_submission(uuid,uuid,boolean),app_private.guardian_academic_submission(uuid,uuid),
  app_private.academic_submission_cohort(uuid,uuid),app_private.teacher_academic_submission(uuid,uuid,boolean),
  app_private.academic_submission_office(uuid,uuid,boolean),app_private.guard_academic_submission_write(),
  app_private.save_academic_log(jsonb,jsonb),public.save_academic_log(jsonb,jsonb)
from public,anon,authenticated,service_role;
grant execute on function app_private.academic_manager(uuid),app_private.academic_office_read(uuid),app_private.academic_log_manager(uuid),
  app_private.teacher_academic_scope(uuid,uuid,uuid,uuid,uuid,uuid,boolean),
  app_private.academic_family_scope(uuid,uuid,uuid,uuid),app_private.can_read_academic_log(uuid),
  app_private.teacher_academic_activity(uuid,boolean),app_private.teacher_academic_log(uuid,boolean),
  app_private.student_academic_submission(uuid,uuid,boolean),app_private.guardian_academic_submission(uuid,uuid),
  app_private.teacher_academic_submission(uuid,uuid,boolean),app_private.academic_submission_office(uuid,uuid,boolean),
  app_private.save_academic_log(jsonb,jsonb),public.save_academic_log(jsonb,jsonb)
to authenticated;

commit;
