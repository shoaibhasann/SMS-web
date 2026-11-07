begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $contracts$
declare constructor record;
begin
 if to_regprocedure('public.set_updated_at()') is null
  or to_regprocedure('public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)') is null
  or to_regprocedure('public.current_admin_school_id()') is null
  or to_regprocedure('public.update_my_teacher_phone(text)') is null
  or to_regprocedure('app_private.update_my_teacher_phone(text)') is not null then
  raise exception 'Review the legacy function contract before hardening access.';
 end if;
 for constructor in select * from(values
  ('app_private.timetable_section_range(uuid,uuid)','range_constructor2'),
  ('app_private.timetable_section_range(uuid,uuid,text)','range_constructor3'),
  ('app_private.timetable_section_multirange()','multirange_constructor0'),
  ('app_private.timetable_section_multirange(app_private.timetable_section_range)','multirange_constructor1'),
  ('app_private.timetable_section_multirange(app_private.timetable_section_range[])','multirange_constructor2')
 ) expected(signature,implementation) loop
  if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang
   where p.oid=to_regprocedure(constructor.signature) and l.lanname='internal'
    and p.prosrc=constructor.implementation and not p.prosecdef and p.provolatile='i') then
   raise exception 'Review the native timetable constructor contract before changing metadata.';
  end if;
 end loop;
 -- These three postgres-owned routines are the reviewed atomic creators. Raw
 -- client INSERT must not bypass their role, catalog and transaction checks.
 if exists(select 1 from(values
  ('public.register_student_for_class_teacher(text)'),
  ('app_private.admit_roster_student(uuid,uuid,uuid,uuid,text,text,text)'),
  ('app_private.change_roster_placement(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)')
 ) expected(signature) left join pg_proc p on p.oid=to_regprocedure(expected.signature)
 where p.oid is null or not p.prosecdef or pg_get_userbyid(p.proowner)<>'postgres') then
  raise exception 'Reviewed roster creators are required before closing raw inserts.';
 end if;
end;$contracts$;

alter function public.set_updated_at() set search_path='';
alter function public.write_audit_log(uuid,text,text,text,uuid,text,jsonb) set search_path='';

-- Platform-owned internal constructors resolve no SQL names. Preserve their
-- metadata, implementations, ownership and exclusion-index dependencies.

create or replace function public.current_admin_school_id()
returns uuid language sql stable security definer set search_path=''
as $$select ur.school_id from public.user_roles ur
 where ur.user_id=auth.uid() and ur.role='school_admin'::public.app_role and ur.school_id is not null
 order by ur.created_at desc limit 1;$$;
revoke execute on function public.current_admin_school_id() from public,anon;

create function app_private.update_my_teacher_phone(p_registered_mobile text)
returns void language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.student_leave_actor();teacher record;
 v_teacher_id uuid;v_school_id uuid;matches integer:=0;
begin
 if p_registered_mobile is not null and char_length(p_registered_mobile)>40 then
  raise exception 'Phone number must be 40 characters or fewer.' using errcode='22023';
 end if;
 for teacher in select t.id,t.school_id from public.teachers t where t.profile_id=actor order by t.id for update loop
  matches:=matches+1;v_teacher_id:=teacher.id;v_school_id:=teacher.school_id;
 end loop;
 if matches<>1 or not exists(select 1 from public.profiles p where p.id=actor and p.is_active and p.school_id=v_school_id) then
  raise exception 'Exactly one coherent active teacher profile is required.' using errcode='42501';
 end if;
 perform 1 from public.schools school where school.id=v_school_id and school.is_active for share;
 if not found then raise exception 'Current school access is required.' using errcode='42501';end if;
 perform 1 from public.user_roles role where role.user_id=actor and role.school_id=v_school_id and role.role='teacher' order by role.id for share;
 if not found or not app_private.staff_mfa_allowed() then
  raise exception 'Current verified Teacher access is required.' using errcode='42501';
 end if;
 update public.teachers t set registered_mobile=nullif(btrim(p_registered_mobile),'')
  where t.id=v_teacher_id and t.school_id=v_school_id and t.profile_id=actor;
end;$$;
create or replace function public.update_my_teacher_phone(p_registered_mobile text)
returns void language sql security invoker set search_path=''
as $$select app_private.update_my_teacher_phone(p_registered_mobile);$$;
revoke all on function public.update_my_teacher_phone(text),app_private.update_my_teacher_phone(text)
 from public,anon,authenticated,service_role;
grant execute on function public.update_my_teacher_phone(text),app_private.update_my_teacher_phone(text)
 to authenticated,service_role;

revoke insert on public.students,public.enrollments from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
