begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Full teacher records include the registered mobile and employee identifier.
alter policy tenant_isolation_teachers on public.teachers
  using (app_private.has_school_roles(
    school_id, array['school_admin', 'principal', 'accountant', 'reception_staff']::public.app_role[]
  ));

create policy teachers_select_own on public.teachers
  for select to authenticated
  using (profile_id = (select auth.uid()));

create function app_private.academic_teacher_labels(p_teacher_ids uuid[])
returns table(id uuid, full_name text)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if p_teacher_ids is null or pg_catalog.cardinality(p_teacher_ids) > 200 then
    raise exception 'Request at most 200 teacher labels.' using errcode = '22023';
  end if;

  return query
  select t.id, t.full_name
  from public.teachers t
  where t.id = any(p_teacher_ids)
    and exists (
      select 1
      from public.user_roles ur
      join public.profiles p on p.id = ur.user_id and p.is_active
      where ur.user_id = (select auth.uid())
        and (ur.school_id = t.school_id or (ur.role = 'super_admin' and ur.school_id is null))
    );
end;
$function$;

create function public.academic_teacher_labels(p_teacher_ids uuid[])
returns table(id uuid, full_name text)
language sql stable security invoker set search_path = ''
as $function$
  select * from app_private.academic_teacher_labels(p_teacher_ids);
$function$;

revoke all on function app_private.academic_teacher_labels(uuid[]), public.academic_teacher_labels(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function app_private.academic_teacher_labels(uuid[]), public.academic_teacher_labels(uuid[])
  to authenticated;

commit;
