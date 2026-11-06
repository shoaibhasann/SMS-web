alter table public.parents add column if not exists registered_mobile text;

create or replace function public.activate_teacher(p_employee_id text, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_teacher public.teachers%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select t.* into v_teacher
  from public.teachers t
  where lower(trim(t.employee_id)) = lower(trim(p_employee_id))
    and regexp_replace(coalesce(t.registered_mobile,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
  limit 1;

  if v_teacher.id is null then raise exception 'Teacher verification failed'; end if;

  update public.profiles
    set school_id = v_teacher.school_id,
        updated_at = now()
  where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_teacher.school_id, 'teacher'::public.app_role)
  on conflict do nothing;

  return v_teacher.id;
end;
$$;

create or replace function public.activate_student(p_admission_no text, p_dob date, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select s.* into v_student
  from public.students s
  where lower(trim(s.admission_no)) = lower(trim(p_admission_no))
    and s.dob = p_dob
    and regexp_replace(coalesce(s.registered_mobile,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
  limit 1;

  if v_student.id is null then raise exception 'Student verification failed'; end if;

  update public.profiles
    set school_id = v_student.school_id,
        updated_at = now()
  where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_student.school_id, 'student'::public.app_role)
  on conflict do nothing;

  return v_student.id;
end;
$$;

create or replace function public.activate_parent(p_parent_code text, p_mobile text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.parents%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select p.* into v_parent
  from public.parents p
  where lower(trim(p.guardian_code)) = lower(trim(p_parent_code))
    and regexp_replace(coalesce(p.registered_mobile,''),'[^0-9]','','g') = regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g')
  limit 1;

  if v_parent.id is null then raise exception 'Parent verification failed'; end if;

  update public.profiles
    set school_id = v_parent.school_id,
        updated_at = now()
  where id = auth.uid();

  insert into public.user_roles(user_id, school_id, role)
  values (auth.uid(), v_parent.school_id, 'parent'::public.app_role)
  on conflict do nothing;

  return v_parent.id;
end;
$$;

create or replace function public.current_user_has_any_role(p_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = any(p_roles)
  );
$$;

create or replace function public.current_user_has_role(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    where ur.user_id = auth.uid() and ur.role = p_role
  );
$$;

create or replace function public.assign_school_role(p_user_id uuid, p_school_id uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.current_user_has_any_role(array['super_admin'::public.app_role,'school_admin'::public.app_role]) then
    raise exception 'Not authorized to assign roles';
  end if;

  if p_role = 'super_admin'::public.app_role and not public.current_user_has_role('super_admin'::public.app_role) then
    raise exception 'Only super admin can assign super admin';
  end if;

  insert into public.user_roles(user_id, school_id, role)
  values (p_user_id, p_school_id, p_role)
  on conflict do nothing;
end;
$$;

revoke all on function public.activate_teacher(text,text) from public, anon;
revoke all on function public.activate_student(text,date,text) from public, anon;
revoke all on function public.activate_parent(text,text) from public, anon;
revoke all on function public.assign_school_role(uuid,uuid,public.app_role) from public, anon;
revoke all on function public.current_user_has_any_role(public.app_role[]) from public, anon;
revoke all on function public.current_user_has_role(public.app_role) from public, anon;
grant execute on function public.activate_teacher(text,text) to authenticated;
grant execute on function public.activate_student(text,date,text) to authenticated;
grant execute on function public.activate_parent(text,text) to authenticated;
grant execute on function public.assign_school_role(uuid,uuid,public.app_role) to authenticated;
grant execute on function public.current_user_has_any_role(public.app_role[]) to authenticated;
grant execute on function public.current_user_has_role(public.app_role) to authenticated;
