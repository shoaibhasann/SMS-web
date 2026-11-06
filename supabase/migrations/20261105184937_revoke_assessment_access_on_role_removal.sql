begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Independent foreign keys do not establish that a placement belongs to one
-- school. Malformed historical rows remain stored, but fail closed at the API.
create function app_private.assessment_scope_is_coherent(
  p_teacher_id uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_subject_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.teachers teacher
    join public.academic_years year on year.id=p_year_id and year.school_id=p_school_id
    join public.classes class on class.id=p_class_id and class.school_id=p_school_id
    join public.subjects subject on subject.id=p_subject_id and subject.school_id=p_school_id
    where teacher.id=p_teacher_id and teacher.school_id=p_school_id
      and (p_section_id is null or exists (
        select 1 from public.sections section where section.id=p_section_id
          and section.school_id=p_school_id and section.class_id=p_class_id))
  );
$$;

create function app_private.assessment_school_admin(p_school_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles membership
    join public.profiles profile on profile.id=membership.user_id and profile.is_active
    where membership.user_id=(select auth.uid()) and (
      (membership.role='school_admin' and membership.school_id=p_school_id)
      or (membership.role='super_admin' and membership.school_id is null))
  );
$$;

create function app_private.assessment_teacher_is_assigned(
  p_teacher_id uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_subject_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.assessment_scope_is_coherent(p_teacher_id,p_school_id,p_year_id,p_class_id,p_section_id,p_subject_id)
    and exists (
      select 1 from public.teachers teacher
      join public.profiles profile on profile.id=teacher.profile_id and profile.is_active
      join public.user_roles membership on membership.user_id=profile.id
        and membership.role='teacher' and membership.school_id=p_school_id
      join public.teacher_subject_assignments assignment on assignment.teacher_id=teacher.id
      where teacher.id=p_teacher_id and teacher.school_id=p_school_id and profile.id=(select auth.uid())
        and assignment.academic_year_id=p_year_id and assignment.class_id=p_class_id
        and assignment.subject_id=p_subject_id
        and (assignment.section_id is null or assignment.section_id=p_section_id)
    );
$$;

create function app_private.assessment_scope_access(
  p_teacher_id uuid, p_school_id uuid, p_year_id uuid, p_class_id uuid,
  p_section_id uuid, p_subject_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.assessment_scope_is_coherent(p_teacher_id,p_school_id,p_year_id,p_class_id,p_section_id,p_subject_id)
    and (app_private.assessment_school_admin(p_school_id)
      or app_private.assessment_teacher_is_assigned(p_teacher_id,p_school_id,p_year_id,p_class_id,p_section_id,p_subject_id));
$$;

create function app_private.assessment_access(p_assessment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teacher_assessments assessment where assessment.id=p_assessment_id
    and app_private.assessment_scope_access(assessment.teacher_id,assessment.school_id,assessment.academic_year_id,
      assessment.class_id,assessment.section_id,assessment.subject_id));
$$;

create function app_private.assessment_student_matches_school(p_assessment_id uuid,p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teacher_assessments assessment
    join public.students student on student.id=p_student_id and student.school_id=assessment.school_id
    where assessment.id=p_assessment_id and app_private.assessment_access(assessment.id));
$$;

create function app_private.assessment_student_is_enrolled(p_assessment_id uuid,p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.assessment_student_matches_school(p_assessment_id,p_student_id) and exists (
    select 1 from public.teacher_assessments assessment
    join public.enrollments enrollment on enrollment.student_id=p_student_id
      and enrollment.academic_year_id=assessment.academic_year_id and enrollment.class_id=assessment.class_id
      and enrollment.status='active' and (assessment.section_id is null or enrollment.section_id=assessment.section_id)
    where assessment.id=p_assessment_id
  );
$$;

-- Keep the API signatures used by existing policies and clients; privileged
-- lookups live in the unexposed schema, not in callable public definers.
create or replace function public.teacher_assessment_is_assigned(
  p_teacher_id uuid,p_school_id uuid,p_academic_year_id uuid,p_class_id uuid,p_section_id uuid,p_subject_id uuid
) returns boolean language sql stable security invoker set search_path = '' as $$
  select app_private.assessment_teacher_is_assigned(p_teacher_id,p_school_id,p_academic_year_id,p_class_id,p_section_id,p_subject_id);
$$;
create or replace function public.teacher_assessment_is_school_admin(p_school_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select app_private.assessment_school_admin(p_school_id);
$$;
create or replace function public.teacher_assessment_can_view(p_assessment_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select app_private.assessment_access(p_assessment_id);
$$;
create or replace function public.teacher_assessment_can_manage(p_assessment_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select app_private.assessment_access(p_assessment_id);
$$;
create or replace function public.teacher_assessment_student_is_enrolled(p_assessment_id uuid,p_student_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select app_private.assessment_student_is_enrolled(p_assessment_id,p_student_id);
$$;

-- These older permissive ALL policies otherwise bypass the active-profile
-- requirement through a different, shared school-admin helper.
drop policy if exists admin_teacher_assessments_all on public.teacher_assessments;
drop policy if exists admin_teacher_assessment_marks_all on public.teacher_assessment_marks;

create policy assessment_coherent_scope on public.teacher_assessments as restrictive for all to authenticated
using (app_private.assessment_scope_access(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id))
with check (app_private.assessment_scope_access(teacher_id,school_id,academic_year_id,class_id,section_id,subject_id));
create policy assessment_mark_coherent_student on public.teacher_assessment_marks as restrictive for all to authenticated
using (app_private.assessment_student_matches_school(assessment_id,student_id))
with check (app_private.assessment_student_matches_school(assessment_id,student_id));

-- Hold the live profile, qualifying role and assignment for the transaction.
-- Each query after a wait gets a fresh snapshot in this volatile write path.
create function app_private.lock_assessment_write_scope(
  p_teacher_id uuid,p_school_id uuid,p_year_id uuid,p_class_id uuid,p_section_id uuid,p_subject_id uuid
) returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from public.profiles profile join public.user_roles membership on membership.user_id=profile.id
    where profile.id=auth.uid() and profile.is_active and (
      (membership.role='school_admin' and membership.school_id=p_school_id)
      or (membership.role='super_admin' and membership.school_id is null))
    for share of profile,membership;
  if not found then
    perform 1 from public.teachers teacher
      join public.profiles profile on profile.id=teacher.profile_id and profile.is_active
      join public.user_roles membership on membership.user_id=profile.id
        and membership.role='teacher' and membership.school_id=p_school_id
      join public.teacher_subject_assignments assignment on assignment.teacher_id=teacher.id
      where teacher.id=p_teacher_id and teacher.school_id=p_school_id and profile.id=auth.uid()
        and assignment.academic_year_id=p_year_id and assignment.class_id=p_class_id
        and assignment.subject_id=p_subject_id
        and (assignment.section_id is null or assignment.section_id=p_section_id)
      for share of teacher,profile,membership,assignment;
    if not found then raise exception 'An active school role and assessment assignment are required.' using errcode='42501'; end if;
  end if;
  perform 1 from public.teachers where id=p_teacher_id and school_id=p_school_id for share;
  if not found then raise exception 'Assessment teacher is outside this school.' using errcode='42501'; end if;
  perform 1 from public.academic_years where id=p_year_id and school_id=p_school_id for share;
  if not found then raise exception 'Assessment year is outside this school.' using errcode='42501'; end if;
  perform 1 from public.classes where id=p_class_id and school_id=p_school_id for share;
  if not found then raise exception 'Assessment class is outside this school.' using errcode='42501'; end if;
  perform 1 from public.subjects where id=p_subject_id and school_id=p_school_id for share;
  if not found then raise exception 'Assessment subject is outside this school.' using errcode='42501'; end if;
  if p_section_id is not null then
    perform 1 from public.sections where id=p_section_id and school_id=p_school_id and class_id=p_class_id for share;
    if not found then raise exception 'Assessment section is outside this class.' using errcode='42501'; end if;
  end if;
  if not app_private.assessment_scope_access(p_teacher_id,p_school_id,p_year_id,p_class_id,p_section_id,p_subject_id) then
    raise exception 'Assessment access changed. Reload and try again.' using errcode='42501';
  end if;
end;
$$;

create function app_private.guard_assessment_write()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op<>'INSERT' then
    perform app_private.lock_assessment_write_scope(old.teacher_id,old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id);
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='UPDATE' and new.id is distinct from old.id then
    raise exception 'An assessment identifier cannot be changed.' using errcode='42501';
  end if;
  if tg_op='UPDATE' and (new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id,new.teacher_id)
    is distinct from (old.school_id,old.academic_year_id,old.class_id,old.section_id,old.subject_id,old.teacher_id)
    and exists (select 1 from public.teacher_assessment_marks where assessment_id=old.id) then
    raise exception 'An assessment with saved marks cannot be moved to another placement or teacher.' using errcode='42501';
  end if;
  perform app_private.lock_assessment_write_scope(new.teacher_id,new.school_id,new.academic_year_id,new.class_id,new.section_id,new.subject_id);
  return new;
end;
$$;
create trigger aa_guard_assessment_write before insert or update or delete on public.teacher_assessments
for each row execute function app_private.guard_assessment_write();

create function app_private.guard_assessment_mark_write()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
declare
  assessment public.teacher_assessments%rowtype;
begin
  if current_setting('role',true) not in ('authenticated','anon') then
    if tg_op='DELETE' then return old; end if;
    -- Keep the original mark-range/enrollment invariant for trusted maintenance
    -- too, without requiring a school user's JWT in a backend seed or job.
    select * into assessment from public.teacher_assessments where id=new.assessment_id for update;
    if not found then raise exception 'Assessment not found.'; end if;
    if new.marks_obtained<0 or new.marks_obtained>assessment.maximum_marks then
      raise exception 'Marks must be between zero and the assessment maximum.' using errcode='22023';
    end if;
    if not exists (select 1 from public.enrollments enrollment where enrollment.student_id=new.student_id
      and enrollment.academic_year_id=assessment.academic_year_id and enrollment.class_id=assessment.class_id
      and enrollment.status='active' and (assessment.section_id is null or enrollment.section_id=assessment.section_id)) then
      raise exception 'Student is not actively enrolled in this assessment class and section.';
    end if;
    new.updated_by:=auth.uid();
    return new;
  end if;
  if tg_op<>'INSERT' then
    select * into assessment from public.teacher_assessments where id=old.assessment_id for update;
    -- A checked assessment DELETE owns its cascading mark deletions. The parent
    -- has already disappeared from this command's view when the FK fires.
    if not found and tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
    if not found then raise exception 'Assessment not found.' using errcode='42501'; end if;
    perform app_private.lock_assessment_write_scope(assessment.teacher_id,assessment.school_id,assessment.academic_year_id,
      assessment.class_id,assessment.section_id,assessment.subject_id);
    if tg_op='DELETE' then return old; end if;
  end if;
  select * into assessment from public.teacher_assessments where id=new.assessment_id for update;
  if not found then raise exception 'Assessment not found.' using errcode='42501'; end if;
  perform app_private.lock_assessment_write_scope(assessment.teacher_id,assessment.school_id,assessment.academic_year_id,
    assessment.class_id,assessment.section_id,assessment.subject_id);
  -- Refresh the parent after any role/scope lock wait before validating marks.
  select * into assessment from public.teacher_assessments where id=new.assessment_id;
  perform 1 from public.students student join public.enrollments enrollment on enrollment.student_id=student.id
    where student.id=new.student_id and student.school_id=assessment.school_id
      and enrollment.academic_year_id=assessment.academic_year_id and enrollment.class_id=assessment.class_id
      and enrollment.status='active' and (assessment.section_id is null or enrollment.section_id=assessment.section_id)
    for share of student,enrollment;
  if not found or not app_private.assessment_student_is_enrolled(new.assessment_id,new.student_id) then
    raise exception 'Student is not actively enrolled in this assessment school, class and section.' using errcode='42501';
  end if;
  if new.marks_obtained<0 or new.marks_obtained>assessment.maximum_marks then
    raise exception 'Marks must be between zero and the assessment maximum.' using errcode='22023';
  end if;
  new.updated_by:=auth.uid();
  return new;
end;
$$;
drop trigger if exists teacher_assessment_marks_validate on public.teacher_assessment_marks;
create trigger teacher_assessment_marks_validate before insert or update or delete on public.teacher_assessment_marks
for each row execute function app_private.guard_assessment_mark_write();

grant usage on schema app_private to authenticated,service_role;
revoke all on public.teacher_assessments,public.teacher_assessment_marks from public,anon,authenticated;
revoke all (id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,description,status,created_at,updated_at)
  on public.teacher_assessments from public,anon,authenticated;
revoke all (id,assessment_id,student_id,marks_obtained,remarks,updated_by,created_at,updated_at)
  on public.teacher_assessment_marks from public,anon,authenticated;
grant select,insert,update,delete on public.teacher_assessments,public.teacher_assessment_marks to authenticated;
revoke all on function
  app_private.assessment_scope_is_coherent(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.assessment_school_admin(uuid),
  app_private.assessment_teacher_is_assigned(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.assessment_scope_access(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.assessment_access(uuid),app_private.assessment_student_matches_school(uuid,uuid),
  app_private.assessment_student_is_enrolled(uuid,uuid),
  app_private.lock_assessment_write_scope(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.guard_assessment_write(),app_private.guard_assessment_mark_write(),
  public.teacher_assessment_is_assigned(uuid,uuid,uuid,uuid,uuid,uuid),
  public.teacher_assessment_is_school_admin(uuid),public.teacher_assessment_can_view(uuid),
  public.teacher_assessment_can_manage(uuid),public.teacher_assessment_student_is_enrolled(uuid,uuid),
  public.teacher_assessment_validate_marks(),public.teacher_assessment_validate_maximum()
from public,anon,authenticated,service_role;
grant execute on function
  app_private.assessment_scope_is_coherent(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.assessment_school_admin(uuid),
  app_private.assessment_teacher_is_assigned(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.assessment_scope_access(uuid,uuid,uuid,uuid,uuid,uuid),
  app_private.assessment_access(uuid),app_private.assessment_student_matches_school(uuid,uuid),
  app_private.assessment_student_is_enrolled(uuid,uuid),
  public.teacher_assessment_is_assigned(uuid,uuid,uuid,uuid,uuid,uuid),
  public.teacher_assessment_is_school_admin(uuid),public.teacher_assessment_can_view(uuid),
  public.teacher_assessment_can_manage(uuid),public.teacher_assessment_student_is_enrolled(uuid,uuid)
to authenticated,service_role;

do $$
declare relation regclass;
begin
  foreach relation in array array['public.teacher_assessments'::regclass,'public.teacher_assessment_marks'::regclass] loop
    if has_table_privilege('anon',relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('anon',relation,'SELECT,INSERT,UPDATE,REFERENCES')
      or has_table_privilege('authenticated',relation,'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      or has_any_column_privilege('authenticated',relation,'REFERENCES') then
      raise exception 'Inherited assessment table privileges must be reviewed before enabling this change.';
    end if;
  end loop;
end;
$$;
commit;
