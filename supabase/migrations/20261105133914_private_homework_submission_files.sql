begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('homework-submissions','homework-submissions',false,10485760,array['application/pdf','image/jpeg','image/png']);

create function app_private.homework_file_location(p_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from (select app_private.homework_file_scope(p_name) s) parsed
    join public.class_activities activity on activity.id=s[6]
    join public.class_logs log on log.id=activity.class_log_id
    join public.academic_years year on year.id=log.academic_year_id and year.school_id=log.school_id
    join public.classes class on class.id=log.class_id and class.school_id=log.school_id
    join public.sections section on section.id=log.section_id and section.school_id=log.school_id and section.class_id=class.id
    join public.subjects subject on subject.id=log.subject_id and subject.school_id=log.school_id
    join public.students pupil on pupil.id=s[7] and pupil.school_id=log.school_id
    where activity.id=s[6] and activity.activity_type='homework'
      and (log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id)
        is not distinct from (s[1],s[2],s[3],s[4],s[5])
  );
$$;

create function app_private.homework_file_owner(p_name text,p_owner text,p_write boolean)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select coalesce(p_owner=(select auth.uid())::text and app_private.homework_file_location(p_name)
    and app_private.homework_student_scope(s[6],s[7],p_write),false)
  from (select app_private.homework_file_scope(p_name) s) parsed;
$$;

-- RLS on the submission row authorizes the pupil, assigned author, linked
-- guardian or scoped office reader. Pending uploads have no such audience.
create function app_private.homework_file_link_visible(p_name text)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select exists(select 1 from public.activity_submissions submission
    cross join lateral(select app_private.homework_file_scope(p_name) s) parsed
    where submission.file_path=p_name and submission.activity_id=s[6] and submission.student_id=s[7]
      and app_private.homework_file_location(p_name));
$$;

create function app_private.homework_file_referenced(p_name text)
returns boolean language sql volatile security definer set search_path = ''
as $$ select exists(select 1 from public.activity_submissions where file_path=p_name); $$;

create policy homework_files_read on storage.objects for select to authenticated
using(bucket_id='homework-submissions'
  and storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info',
    'object.list','object.list_v2','object.upload','object.delete','object.delete_many'])
  and (app_private.homework_file_owner(name,coalesce(owner_id,owner::text),false)
    or app_private.homework_file_link_visible(name)));
create policy homework_files_upload on storage.objects for insert to authenticated
with check(bucket_id='homework-submissions' and storage.allow_only_operation('object.upload')
  and app_private.homework_file_owner(name,coalesce(owner_id,owner::text),true));
-- No UPDATE policy: every version gets a random key. An existing upload cannot
-- be replaced, moved or copied through a permission probe.
create policy homework_files_pending_delete on storage.objects for delete to authenticated
using(bucket_id='homework-submissions' and storage.allow_any_operation(array['object.delete','object.delete_many'])
  and app_private.homework_file_owner(name,coalesce(owner_id,owner::text),false)
  and not app_private.homework_file_referenced(name));

-- A pending DELETE may wait behind submit's object lock. This fresh volatile
-- check runs after that wait, so stale RLS snapshots cannot delete new evidence.
create function app_private.guard_submitted_homework_file()
returns trigger language plpgsql volatile security definer set search_path = ''
as $$
begin
  if old.bucket_id='homework-submissions' and app_private.homework_file_referenced(old.name)
    and (tg_op='DELETE' or (to_jsonb(new)-array['updated_at','last_accessed_at'])
      is distinct from (to_jsonb(old)-array['updated_at','last_accessed_at'])) then
    raise exception 'A submitted homework attachment must be preserved.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;
create trigger guard_submitted_homework_file before update or delete on storage.objects
for each row when(old.bucket_id='homework-submissions') execute function app_private.guard_submitted_homework_file();

revoke all on function app_private.homework_file_location(text),app_private.homework_file_owner(text,text,boolean),
  app_private.homework_file_link_visible(text),app_private.homework_file_referenced(text),app_private.guard_submitted_homework_file()
from public,anon,authenticated,service_role;
grant execute on function app_private.homework_file_location(text),app_private.homework_file_owner(text,text,boolean),
  app_private.homework_file_link_visible(text),app_private.homework_file_referenced(text)
to authenticated;
commit;
