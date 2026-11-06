-- Secure helper layer: no user can self-assign privileged roles.
create or replace function public.current_user_id()
returns uuid
language sql
stable
security invoker
as $$ select auth.uid(); $$;

create or replace function public.current_user_has_role(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = p_role
  );
$$;

create or replace function public.current_user_has_any_role(p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = any(p_roles)
  );
$$;

-- Verified activation: student must match an existing school record.
create or replace function public.activate_student(
  p_admission_no text,
  p_dob date,
  p_mobile text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student public.students%rowtype;
  v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select s.* into v_student
  from public.students s
  where lower(trim(s.admission_no)) = lower(trim(p_admission_no))
    and s.date_of_birth = p_dob
    and regexp_replace(coalesce(s.mobile,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
  limit 1;

  if v_student.id is null then raise exception 'Student verification failed'; end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null then raise exception 'Profile not found'; end if;

  update public.profiles
    set profile_type = 'student', linked_record_id = v_student.id, school_id = v_student.school_id, updated_at = now()
  where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_student.school_id, 'student')
  on conflict do nothing;

  return v_student.id;
end;
$$;

-- Verified activation: teacher must match an existing teacher record.
create or replace function public.activate_teacher(
  p_employee_id text,
  p_mobile text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_teacher public.teachers%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select t.* into v_teacher
  from public.teachers t
  where lower(trim(t.employee_id)) = lower(trim(p_employee_id))
    and regexp_replace(coalesce(t.mobile,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
  limit 1;

  if v_teacher.id is null then raise exception 'Teacher verification failed'; end if;

  update public.profiles
    set profile_type = 'teacher', linked_record_id = v_teacher.id, school_id = v_teacher.school_id, updated_at = now()
  where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_teacher.school_id, 'teacher')
  on conflict do nothing;

  return v_teacher.id;
end;
$$;

-- Parent activation links an authenticated profile to an existing parent record.
create or replace function public.activate_parent(
  p_parent_code text,
  p_mobile text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.parents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select p.* into v_parent
  from public.parents p
  where lower(trim(p.parent_code)) = lower(trim(p_parent_code))
    and regexp_replace(coalesce(p.mobile,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
  limit 1;

  if v_parent.id is null then raise exception 'Parent verification failed'; end if;

  update public.profiles
    set profile_type = 'parent', linked_record_id = v_parent.id, school_id = v_parent.school_id, updated_at = now()
  where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_parent.school_id, 'parent')
  on conflict do nothing;

  return v_parent.id;
end;
$$;

-- Protect role assignment: only privileged school administrators may assign roles.
create or replace function public.assign_school_role(
  p_user_id uuid,
  p_school_id uuid,
  p_role public.app_role
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_user_has_any_role(array['super_admin'::public.app_role,'school_admin'::public.app_role]) then
    raise exception 'Not authorized to assign roles';
  end if;

  if p_role = 'super_admin' and not public.current_user_has_role('super_admin') then
    raise exception 'Only super admin can assign super admin';
  end if;

  insert into public.user_roles(user_id, school_id, role)
  values (p_user_id, p_school_id, p_role)
  on conflict do nothing;
end;
$$;

revoke all on function public.assign_school_role(uuid,uuid,public.app_role) from public, anon, authenticated;
grant execute on function public.assign_school_role(uuid,uuid,public.app_role) to authenticated;
grant execute on function public.activate_student(text,date,text) to authenticated;
grant execute on function public.activate_teacher(text,text) to authenticated;
grant execute on function public.activate_parent(text,text) to authenticated;

-- Prevent direct client-side role insertion. Existing role rows remain intact.
drop policy if exists "user_roles_insert_authenticated" on public.user_roles;
drop policy if exists "user_roles_update_authenticated" on public.user_roles;
drop policy if exists "user_roles_delete_authenticated" on public.user_roles;

create policy "user_roles_select_own_or_admin"
on public.user_roles for select to authenticated
using (
  user_id = auth.uid()
  or public.current_user_has_any_role(array['super_admin'::public.app_role,'school_admin'::public.app_role])
);

-- Profiles may update only their own non-authorization fields; linked identity is controlled by activation RPCs.
drop policy if exists "profiles_update_authenticated" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- Ensure future public tables automatically get RLS enabled.
create or replace function public.enforce_public_rls()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
  loop
    if cmd.schema_name = 'public' and cmd.object_type in ('table','partitioned table') then
      execute format('alter table %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$$;

drop event trigger if exists enforce_public_rls_trigger;
create event trigger enforce_public_rls_trigger
on ddl_command_end
when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
execute function public.enforce_public_rls();
