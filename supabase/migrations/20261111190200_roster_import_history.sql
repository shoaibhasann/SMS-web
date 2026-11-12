-- Student CSV imports and single admissions keep who created the pupil record and when,
-- like the staff and academic-setup imports. Existing receipts stay null instead of being
-- stamped with the migration time; new receipts pick the actor up from the request JWT.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.roster_import_receipts
  add column imported_by uuid,
  add column imported_at timestamptz;
alter table app_private.roster_import_receipts
  alter column imported_by set default auth.uid(),
  alter column imported_at set default pg_catalog.clock_timestamp();

create function app_private.list_roster_imports(p_school_id uuid)
returns table (request_id uuid, student_count integer, imported_by_name text, imported_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $function$
begin
  if p_school_id is null or not exists (
    select 1 from public.user_roles role_row
    join public.profiles profile on profile.id = role_row.user_id and profile.is_active
    where role_row.user_id = (select auth.uid())
      and ((role_row.role = 'super_admin' and role_row.school_id is null)
        or (role_row.school_id = p_school_id and role_row.role in ('school_admin', 'principal')))
  ) then
    raise exception 'You cannot read student imports for this school.' using errcode = '42501';
  end if;
  return query
  select r.request_id, r.student_count,
    case when r.imported_by is not null then coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'School staff') end,
    r.imported_at
  from app_private.roster_import_receipts r left join public.profiles p on p.id = r.imported_by
  where r.school_id = p_school_id
  order by r.imported_at desc nulls last, r.request_id limit 10;
end;
$function$;

create function public.list_roster_imports(p_school_id uuid)
returns table (request_id uuid, student_count integer, imported_by_name text, imported_at timestamptz)
language sql stable security invoker set search_path = ''
as $function$ select * from app_private.list_roster_imports(p_school_id); $function$;

-- One row per pupil created by a signed-in account (single admission, CSV import or
-- class-teacher registration). Seeds, restores and service inserts have no actor and write nothing.
create table app_private.student_admission_audit (
  student_id uuid primary key references public.students(id) on delete cascade,
  school_id uuid not null,
  admitted_by uuid not null,
  admitted_at timestamptz not null default clock_timestamp()
);
create index student_admission_audit_school_idx on app_private.student_admission_audit (school_id, admitted_at desc);
alter table app_private.student_admission_audit enable row level security;
revoke all on table app_private.student_admission_audit from public, anon, authenticated, service_role;

create function app_private.audit_student_admission()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
begin
  if actor_id is not null then
    insert into app_private.student_admission_audit (student_id, school_id, admitted_by)
    values (new.id, new.school_id, actor_id);
  end if;
  return null;
end;
$function$;

create trigger audit_student_admission after insert on public.students
for each row execute function app_private.audit_student_admission();

revoke all on function
  app_private.audit_student_admission(),
  app_private.list_roster_imports(uuid), public.list_roster_imports(uuid)
from public, anon, authenticated, service_role;
grant execute on function app_private.list_roster_imports(uuid), public.list_roster_imports(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
