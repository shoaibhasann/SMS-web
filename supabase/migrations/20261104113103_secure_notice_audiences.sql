begin;

-- Older management forms saved these three labels in plural form.
update public.notices n
set audience = jsonb_set(n.audience, '{roles}', (
  select jsonb_agg(case item.value
    when '"students"'::jsonb then '"student"'::jsonb
    when '"parents"'::jsonb then '"parent"'::jsonb
    when '"teachers"'::jsonb then '"teacher"'::jsonb
    else item.value
  end order by item.position)
  from jsonb_array_elements(n.audience->'roles') with ordinality as item(value, position)
))
where jsonb_typeof(n.audience->'roles') = 'array'
  and (n.audience->'roles') ?| array['students','parents','teachers'];

-- This boolean helper validates the existing JSON contract without exposing roster rows.
create function app_private.notice_audience_is_valid(p_school_id uuid, p_audience jsonb)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  roles jsonb := p_audience->'roles';
  target_class_id uuid;
  target_section_id uuid;
  target_teacher_id uuid;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if auth.uid() is null then
    return false;
  end if;
  if p_audience = '[]'::jsonb then
    return true;
  end if;
  if jsonb_typeof(p_audience) is distinct from 'object'
     or jsonb_typeof(roles) is distinct from 'array' then
    return false;
  end if;
  if roles = '[]'::jsonb
     or not (roles <@ '["student","parent","teacher","staff"]'::jsonb)
     or (p_audience - array['roles','class_id','section_id','teacher_id']) <> '{}'::jsonb then
    return false;
  end if;

  if p_audience ? 'class_id' then
    if not coalesce(p_audience->>'class_id' ~* uuid_pattern, false) then return false; end if;
    target_class_id := (p_audience->>'class_id')::uuid;
  end if;
  if p_audience ? 'section_id' then
    if not coalesce(p_audience->>'section_id' ~* uuid_pattern, false) then return false; end if;
    target_section_id := (p_audience->>'section_id')::uuid;
  end if;
  if p_audience ? 'teacher_id' then
    if not coalesce(p_audience->>'teacher_id' ~* uuid_pattern, false) then return false; end if;
    target_teacher_id := (p_audience->>'teacher_id')::uuid;
  end if;

  if target_class_id is not null or target_section_id is not null or target_teacher_id is not null then
    if not (roles <@ '["student","parent"]'::jsonb) then return false; end if;
  end if;

  return (target_class_id is null or exists (
    select 1 from public.classes c where c.id = target_class_id and c.school_id = p_school_id
  )) and (target_section_id is null or exists (
    select 1
    from public.sections s
    join public.classes c on c.id = s.class_id and c.school_id = s.school_id
    where s.id = target_section_id and s.school_id = p_school_id
      and (target_class_id is null or s.class_id = target_class_id)
  )) and (target_teacher_id is null or (
    target_class_id is null and target_section_id is null and exists (
      select 1 from public.teachers t where t.id = target_teacher_id and t.school_id = p_school_id
    )
  ));
end;
$$;

create function app_private.can_read_notice_audience(p_school_id uuid, p_audience jsonb)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  roles jsonb := p_audience->'roles';
  target_class_id uuid;
  target_section_id uuid;
  target_teacher_id uuid;
begin
  if actor_id is null or not app_private.notice_audience_is_valid(p_school_id, p_audience) then
    return false;
  end if;
  if p_audience = '[]'::jsonb then
    roles := '["student","parent","teacher","staff"]'::jsonb;
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = actor_id and ur.school_id = p_school_id and (
      (ur.role in ('student', 'parent', 'teacher') and roles ? ur.role::text)
      or (ur.role in ('accountant', 'reception_staff') and roles ? 'staff')
    )
  ) then
    return false;
  end if;

  target_class_id := (p_audience->>'class_id')::uuid;
  target_section_id := (p_audience->>'section_id')::uuid;
  target_teacher_id := (p_audience->>'teacher_id')::uuid;
  if target_class_id is null and target_section_id is null and target_teacher_id is null then
    return true;
  end if;

  return exists (
    select 1
    from public.students s
    join public.enrollments e on e.student_id = s.id and e.status = 'active'
    join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
    join public.classes c on c.id = e.class_id and c.school_id = s.school_id
    left join public.sections section on section.id = e.section_id
      and section.school_id = s.school_id and section.class_id = e.class_id
    where s.school_id = p_school_id and s.status = 'active'
      and (e.section_id is null or section.id is not null)
      and (target_class_id is null or e.class_id = target_class_id)
      and (target_section_id is null or e.section_id = target_section_id)
      and (target_teacher_id is null or exists (
        select 1 from public.teacher_subject_assignments a
        where a.teacher_id = target_teacher_id and a.academic_year_id = y.id and a.class_id = e.class_id
          and (a.section_id is null or a.section_id = e.section_id)
      ))
      and (
        (roles ? 'student' and s.profile_id = actor_id
          and app_private.has_school_roles(p_school_id, array['student']::public.app_role[]))
        or (roles ? 'parent'
          and app_private.has_school_roles(p_school_id, array['parent']::public.app_role[])
          and exists (
            select 1
            from public.student_parents link
            join public.parents p on p.id = link.parent_id and p.school_id = s.school_id
            where link.student_id = s.id and p.profile_id = actor_id
          ))
      )
  );
end;
$$;

-- Existing teacher posts carry the author's teacher_id. Preserve that scope
-- and keep the lookup independent of caller visibility into teacher records.
create function app_private.is_own_teacher_notice_audience(p_school_id uuid, p_audience jsonb)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.teachers t
    where t.profile_id = (select auth.uid()) and t.school_id = p_school_id
      and t.id::text = lower(p_audience->>'teacher_id')
  ) and app_private.notice_audience_is_valid(p_school_id, p_audience);
$$;

revoke all on function app_private.notice_audience_is_valid(uuid, jsonb),
  app_private.can_read_notice_audience(uuid, jsonb),
  app_private.is_own_teacher_notice_audience(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.notice_audience_is_valid(uuid, jsonb),
  app_private.can_read_notice_audience(uuid, jsonb),
  app_private.is_own_teacher_notice_audience(uuid, jsonb)
to authenticated;

alter policy notices_school_read on public.notices
using (
  published_at <= now() and (expires_at is null or expires_at > now())
  and app_private.can_read_notice_audience(school_id, audience)
);

alter policy notices_staff_all on public.notices
using (app_private.has_school_roles(school_id, array['school_admin','principal']::public.app_role[]))
with check (
  app_private.has_school_roles(school_id, array['school_admin','principal']::public.app_role[])
  and app_private.notice_audience_is_valid(school_id, audience)
);

create policy notices_teacher_own on public.notices for all to authenticated
using (
  created_by = (select auth.uid())
  and app_private.has_school_roles(school_id, array['teacher']::public.app_role[])
)
with check (
  created_by = (select auth.uid())
  and app_private.has_school_roles(school_id, array['teacher']::public.app_role[])
  and app_private.is_own_teacher_notice_audience(school_id, audience)
);

create index notices_published_idx on public.notices (published_at desc, id)
where published_at is not null;

commit;
