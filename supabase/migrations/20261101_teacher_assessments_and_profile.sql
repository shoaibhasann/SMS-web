-- Teacher assessments and narrowly scoped self-service profile updates.
-- Uses the existing teachers.profile_id relationship and existing assignments.

create table if not exists public.teacher_assessments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  section_id uuid references public.sections(id) on delete set null,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  teacher_id uuid not null references public.teachers(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  assessment_date date not null,
  maximum_marks numeric(8, 2) not null check (maximum_marks > 0),
  description text,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.teacher_assessment_marks (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.teacher_assessments(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  marks_obtained numeric(8, 2) not null check (marks_obtained >= 0),
  remarks text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assessment_id, student_id)
);

create index if not exists teacher_assessments_owner_date_idx
  on public.teacher_assessments (teacher_id, assessment_date desc);
create index if not exists teacher_assessments_scope_idx
  on public.teacher_assessments (school_id, academic_year_id, class_id, section_id, subject_id);
create index if not exists teacher_assessment_marks_student_idx
  on public.teacher_assessment_marks (student_id, assessment_id);

create or replace function public.teacher_assessment_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists teacher_assessments_set_updated_at on public.teacher_assessments;
create trigger teacher_assessments_set_updated_at
before update on public.teacher_assessments
for each row execute function public.teacher_assessment_set_updated_at();

create or replace function public.teacher_assessment_validate_maximum()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.teacher_assessment_marks m
    where m.assessment_id = new.id
      and m.marks_obtained > new.maximum_marks
  ) then
    raise exception 'Maximum marks cannot be lower than marks already entered.';
  end if;
  return new;
end;
$$;

drop trigger if exists teacher_assessments_validate_maximum on public.teacher_assessments;
create trigger teacher_assessments_validate_maximum
before update of maximum_marks on public.teacher_assessments
for each row execute function public.teacher_assessment_validate_maximum();

drop trigger if exists teacher_assessment_marks_set_updated_at on public.teacher_assessment_marks;
create trigger teacher_assessment_marks_set_updated_at
before update on public.teacher_assessment_marks
for each row execute function public.teacher_assessment_set_updated_at();

create or replace function public.teacher_assessment_is_assigned(
  p_teacher_id uuid,
  p_school_id uuid,
  p_academic_year_id uuid,
  p_class_id uuid,
  p_section_id uuid,
  p_subject_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.teachers t
    join public.teacher_subject_assignments tsa on tsa.teacher_id = t.id
    join public.classes c on c.id = p_class_id and c.school_id = p_school_id
    join public.academic_years ay on ay.id = p_academic_year_id and ay.school_id = p_school_id
    where t.id = p_teacher_id
      and t.profile_id = (select auth.uid())
      and t.school_id = p_school_id
      and tsa.academic_year_id = p_academic_year_id
      and tsa.class_id = p_class_id
      and tsa.subject_id = p_subject_id
      and (tsa.section_id is null or tsa.section_id = p_section_id)
      and (
        p_section_id is null
        or exists (
          select 1 from public.sections s
          where s.id = p_section_id and s.class_id = p_class_id
        )
      )
  );
$$;

create or replace function public.teacher_assessment_is_school_admin(p_school_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role in ('super_admin', 'school_admin')
      and (ur.role = 'super_admin' or ur.school_id = p_school_id)
  );
$$;

create or replace function public.teacher_assessment_can_view(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.teacher_assessments a
    where a.id = p_assessment_id
      and (
        public.teacher_assessment_is_school_admin(a.school_id)
        or public.teacher_assessment_is_assigned(
          a.teacher_id, a.school_id, a.academic_year_id,
          a.class_id, a.section_id, a.subject_id
        )
      )
  );
$$;

create or replace function public.teacher_assessment_can_manage(p_assessment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.teacher_assessments a
    where a.id = p_assessment_id
      and (
        public.teacher_assessment_is_school_admin(a.school_id)
        or (
          a.teacher_id = (
            select t.id from public.teachers t where t.profile_id = (select auth.uid())
          )
          and public.teacher_assessment_is_assigned(
            a.teacher_id, a.school_id, a.academic_year_id,
            a.class_id, a.section_id, a.subject_id
          )
        )
      )
  );
$$;

create or replace function public.teacher_assessment_student_is_enrolled(
  p_assessment_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.teacher_assessments a
    join public.enrollments e
      on e.student_id = p_student_id
     and e.class_id = a.class_id
     and e.academic_year_id = a.academic_year_id
     and e.status = 'active'
     and (a.section_id is null or e.section_id = a.section_id)
    where a.id = p_assessment_id
  );
$$;

create or replace function public.teacher_assessment_validate_marks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assessment_max numeric(8, 2);
begin
  select a.maximum_marks into assessment_max
  from public.teacher_assessments a
  where a.id = new.assessment_id;

  if assessment_max is null then
    raise exception 'Assessment not found.';
  end if;
  if new.marks_obtained < 0 or new.marks_obtained > assessment_max then
    raise exception 'Marks must be between zero and the assessment maximum.';
  end if;
  if not public.teacher_assessment_student_is_enrolled(new.assessment_id, new.student_id) then
    raise exception 'Student is not actively enrolled in this assessment class and section.';
  end if;

  new.updated_by := (select auth.uid());
  return new;
end;
$$;

drop trigger if exists teacher_assessment_marks_validate on public.teacher_assessment_marks;
create trigger teacher_assessment_marks_validate
before insert or update on public.teacher_assessment_marks
for each row execute function public.teacher_assessment_validate_marks();

alter table public.teacher_assessments enable row level security;
alter table public.teacher_assessment_marks enable row level security;

drop policy if exists teacher_assessments_select on public.teacher_assessments;
create policy teacher_assessments_select
on public.teacher_assessments for select to authenticated
using (
  public.teacher_assessment_is_school_admin(school_id)
  or public.teacher_assessment_is_assigned(
    teacher_id, school_id, academic_year_id, class_id, section_id, subject_id
  )
);

drop policy if exists teacher_assessments_insert on public.teacher_assessments;
create policy teacher_assessments_insert
on public.teacher_assessments for insert to authenticated
with check (
  teacher_id = (select t.id from public.teachers t where t.profile_id = (select auth.uid()))
  and public.teacher_assessment_is_assigned(
    teacher_id, school_id, academic_year_id, class_id, section_id, subject_id
  )
);

drop policy if exists teacher_assessments_update on public.teacher_assessments;
create policy teacher_assessments_update
on public.teacher_assessments for update to authenticated
using (
  teacher_id = (select t.id from public.teachers t where t.profile_id = (select auth.uid()))
  and public.teacher_assessment_is_assigned(
    teacher_id, school_id, academic_year_id, class_id, section_id, subject_id
  )
)
with check (
  teacher_id = (select t.id from public.teachers t where t.profile_id = (select auth.uid()))
  and public.teacher_assessment_is_assigned(
    teacher_id, school_id, academic_year_id, class_id, section_id, subject_id
  )
);

drop policy if exists teacher_assessments_delete on public.teacher_assessments;
create policy teacher_assessments_delete
on public.teacher_assessments for delete to authenticated
using (
  teacher_id = (select t.id from public.teachers t where t.profile_id = (select auth.uid()))
  and public.teacher_assessment_is_assigned(
    teacher_id, school_id, academic_year_id, class_id, section_id, subject_id
  )
);

drop policy if exists teacher_assessments_admin_manage on public.teacher_assessments;
create policy teacher_assessments_admin_manage
on public.teacher_assessments for all to authenticated
using (public.teacher_assessment_is_school_admin(school_id))
with check (public.teacher_assessment_is_school_admin(school_id));

drop policy if exists teacher_assessment_marks_select on public.teacher_assessment_marks;
create policy teacher_assessment_marks_select
on public.teacher_assessment_marks for select to authenticated
using (public.teacher_assessment_can_view(assessment_id));

drop policy if exists teacher_assessment_marks_insert on public.teacher_assessment_marks;
create policy teacher_assessment_marks_insert
on public.teacher_assessment_marks for insert to authenticated
with check (
  public.teacher_assessment_can_manage(assessment_id)
  and public.teacher_assessment_student_is_enrolled(assessment_id, student_id)
);

drop policy if exists teacher_assessment_marks_update on public.teacher_assessment_marks;
create policy teacher_assessment_marks_update
on public.teacher_assessment_marks for update to authenticated
using (public.teacher_assessment_can_manage(assessment_id))
with check (
  public.teacher_assessment_can_manage(assessment_id)
  and public.teacher_assessment_student_is_enrolled(assessment_id, student_id)
);

drop policy if exists teacher_assessment_marks_delete on public.teacher_assessment_marks;
create policy teacher_assessment_marks_delete
on public.teacher_assessment_marks for delete to authenticated
using (public.teacher_assessment_can_manage(assessment_id));

drop policy if exists teacher_assessment_marks_admin_manage on public.teacher_assessment_marks;
create policy teacher_assessment_marks_admin_manage
on public.teacher_assessment_marks for all to authenticated
using (
  exists (
    select 1
    from public.teacher_assessments a
    where a.id = assessment_id
      and public.teacher_assessment_is_school_admin(a.school_id)
  )
)
with check (
  exists (
    select 1
    from public.teacher_assessments a
    where a.id = assessment_id
      and public.teacher_assessment_is_school_admin(a.school_id)
  )
);

grant select, insert, update, delete on public.teacher_assessments to authenticated;
grant select, insert, update, delete on public.teacher_assessment_marks to authenticated;

drop policy if exists teachers_manage_own_assignments_select on public.teacher_subject_assignments;
create policy teachers_manage_own_assignments_select
on public.teacher_subject_assignments for select to authenticated
using (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_assignments_insert on public.teacher_subject_assignments;
create policy teachers_manage_own_assignments_insert
on public.teacher_subject_assignments for insert to authenticated
with check (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_assignments_update on public.teacher_subject_assignments;
create policy teachers_manage_own_assignments_update
on public.teacher_subject_assignments for update to authenticated
using (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
)
with check (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_assignments_delete on public.teacher_subject_assignments;
create policy teachers_manage_own_assignments_delete
on public.teacher_subject_assignments for delete to authenticated
using (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_class_logs_insert on public.class_logs;
create policy teachers_manage_own_class_logs_insert
on public.class_logs for insert to authenticated
with check (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_class_logs_update on public.class_logs;
create policy teachers_manage_own_class_logs_update
on public.class_logs for update to authenticated
using (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
)
with check (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_class_logs_delete on public.class_logs;
create policy teachers_manage_own_class_logs_delete
on public.class_logs for delete to authenticated
using (
  teacher_id = (
    select t.id from public.teachers t where t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_class_activities_insert on public.class_activities;
create policy teachers_manage_own_class_activities_insert
on public.class_activities for insert to authenticated
with check (
  exists (
    select 1
    from public.class_logs cl
    join public.teachers t on t.id = cl.teacher_id
    where cl.id = class_log_id
      and t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_class_activities_update on public.class_activities;
create policy teachers_manage_own_class_activities_update
on public.class_activities for update to authenticated
using (
  exists (
    select 1
    from public.class_logs cl
    join public.teachers t on t.id = cl.teacher_id
    where cl.id = class_log_id
      and t.profile_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.class_logs cl
    join public.teachers t on t.id = cl.teacher_id
    where cl.id = class_log_id
      and t.profile_id = (select auth.uid())
  )
);

drop policy if exists teachers_manage_own_class_activities_delete on public.class_activities;
create policy teachers_manage_own_class_activities_delete
on public.class_activities for delete to authenticated
using (
  exists (
    select 1
    from public.class_logs cl
    join public.teachers t on t.id = cl.teacher_id
    where cl.id = class_log_id
      and t.profile_id = (select auth.uid())
  )
);

revoke all on function public.teacher_assessment_is_assigned(uuid, uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function public.teacher_assessment_is_school_admin(uuid) from public;
revoke all on function public.teacher_assessment_can_view(uuid) from public;
revoke all on function public.teacher_assessment_can_manage(uuid) from public;
revoke all on function public.teacher_assessment_student_is_enrolled(uuid, uuid) from public;
grant execute on function public.teacher_assessment_is_assigned(uuid, uuid, uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.teacher_assessment_is_school_admin(uuid) to authenticated;
grant execute on function public.teacher_assessment_can_view(uuid) to authenticated;
grant execute on function public.teacher_assessment_can_manage(uuid) to authenticated;
grant execute on function public.teacher_assessment_student_is_enrolled(uuid, uuid) to authenticated;

create or replace function public.update_my_teacher_phone(p_registered_mobile text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_rows integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.';
  end if;
  if p_registered_mobile is not null and length(p_registered_mobile) > 40 then
    raise exception 'Phone number must be 40 characters or fewer.';
  end if;

  update public.teachers
  set registered_mobile = nullif(btrim(p_registered_mobile), '')
  where profile_id = (select auth.uid());

  get diagnostics updated_rows = row_count;
  if updated_rows = 0 then
    raise exception 'Teacher profile was not found for this login.';
  end if;
  if updated_rows > 1 then
    raise exception 'More than one teacher profile is linked to this login.';
  end if;
end;
$$;

revoke all on function public.update_my_teacher_phone(text) from public;
grant execute on function public.update_my_teacher_phone(text) to authenticated;
