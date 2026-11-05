begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- No material objects existed at inspection. Future teacher uploads carry the
-- complete assignment tuple; guessing or linking another path cannot expand it.
create function app_private.material_file_scope(p_name text)
returns uuid[] language plpgsql immutable set search_path = ''
as $$
declare parts text[] := string_to_array(p_name, '/');
begin
  if p_name is null or array_length(parts, 1) <> 7 or parts[7] !~ '^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{1,10}$' then return null; end if;
  perform split_part(parts[7], '.', 1)::uuid;
  return array[parts[1]::uuid, parts[2]::uuid, parts[3]::uuid, parts[4]::uuid, parts[5]::uuid, parts[6]::uuid];
exception when invalid_text_representation then return null;
end;
$$;

create function app_private.material_file_manager(p_name text)
returns boolean language plpgsql stable security invoker set search_path = ''
as $$
begin
  return app_private.academic_manager(split_part(p_name, '/', 1)::uuid);
exception when invalid_text_representation then return false;
end;
$$;

-- School-wide material metadata is office-authored (teacher_id NULL). Keep
-- that existing audience without allowing a teacher to broadcast their file.
create function app_private.material_file_shared_school(p_name text)
returns uuid language plpgsql immutable set search_path = ''
as $$
declare parts text[] := string_to_array(p_name, '/');
begin
  if p_name is null or array_length(parts,1) <> 3 or parts[2] <> 'shared'
    or parts[3] !~ '^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{1,10}$' then return null; end if;
  perform split_part(parts[3], '.', 1)::uuid;
  return parts[1]::uuid;
exception when invalid_text_representation then return null;
end;
$$;

create function app_private.material_file_key(p_url text)
returns text language sql immutable set search_path = ''
as $$
  select case
    when p_url like 'study-materials/%' then substr(p_url, length('study-materials/') + 1)
    when strpos(p_url, '/storage/v1/object/authenticated/study-materials/') > 0
      then split_part(split_part(p_url, '/storage/v1/object/authenticated/study-materials/', 2), '?', 1)
    when strpos(p_url, '/storage/v1/object/sign/study-materials/') > 0
      then split_part(split_part(p_url, '/storage/v1/object/sign/study-materials/', 2), '?', 1)
    else p_url end;
$$;
create function app_private.material_file_reference(p_url text, p_name text)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(app_private.material_file_key(p_url) = p_name, false);
$$;

create index academic_material_file_reference_idx on public.study_materials (app_private.material_file_key(file_url));
create index academic_activity_file_reference_idx on public.class_activities (app_private.material_file_key(attachment_url));
create index academic_submission_file_reference_idx on public.activity_submissions (app_private.material_file_key(file_url));

create function app_private.material_file_owner(p_name text, p_owner text, p_write boolean)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select coalesce(p_owner = (select auth.uid())::text
    and app_private.teacher_academic_scope(s[6], s[1], s[2], s[3], s[4], s[5], p_write), false)
  from (select app_private.material_file_scope(p_name) s) parsed;
$$;

-- Intentionally INVOKER: a file reference never grants more than the row's own
-- RLS. The metadata tuple must also equal the physical file's assignment tuple.
create function app_private.material_file_link_visible(p_name text)
returns boolean language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from public.study_materials material
    cross join lateral (select app_private.material_file_scope(p_name) s) parsed
    where (material.school_id, material.class_id, material.section_id, material.subject_id, material.teacher_id)
      is not distinct from (s[1], s[3], s[4], s[5], s[6])
      and app_private.material_file_reference(material.file_url, p_name)
  ) or exists (
    select 1 from public.class_activities activity
    join public.class_logs log on log.id = activity.class_log_id
    cross join lateral (select app_private.material_file_scope(p_name) s) parsed
    where (log.school_id, log.academic_year_id, log.class_id, log.section_id, log.subject_id, log.teacher_id)
      is not distinct from (s[1], s[2], s[3], s[4], s[5], s[6])
      and app_private.material_file_reference(activity.attachment_url, p_name)
  ) or exists (
    select 1 from public.study_materials material
    where material.school_id = app_private.material_file_shared_school(p_name)
      and material.teacher_id is null and app_private.material_file_reference(material.file_url, p_name)
  );
$$;

-- This boolean exposes no metadata. It prevents teacher deletion of a file that
-- still backs published work or submitted homework, even if a caller cannot
-- select a particular reference. Managers retain explicit school authority.
create function app_private.material_file_referenced(p_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.study_materials material
    where app_private.material_file_reference(material.file_url, p_name))
    or exists (select 1 from public.class_activities activity
      where app_private.material_file_reference(activity.attachment_url, p_name))
    or exists (select 1 from public.activity_submissions submission
      where app_private.material_file_reference(submission.file_url, p_name));
$$;

create function app_private.material_file_submission_referenced(p_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.activity_submissions submission
    where app_private.material_file_reference(submission.file_url, p_name));
$$;

drop policy study_materials_authenticated_access on storage.objects;
create policy academic_material_files_read on storage.objects for select to authenticated
using (bucket_id = 'study-materials' and (
  app_private.material_file_manager(name)
  or (storage.allow_any_operation(array['object.get_authenticated', 'object.get_authenticated_info',
    'object.head_authenticated_info', 'object.list', 'object.list_v2', 'object.sign', 'object.sign_many',
    'object.upload', 'object.upload_update', 'object.delete', 'object.delete_many', 'render.image_authenticated'])
    and (app_private.material_file_owner(name, coalesce(owner_id, owner::text), false)
      or app_private.material_file_link_visible(name)))
));
create policy academic_material_files_insert on storage.objects for insert to authenticated
with check (bucket_id = 'study-materials' and (
  app_private.material_file_manager(name)
  or (storage.allow_only_operation('object.upload')
    and app_private.material_file_owner(name, coalesce(owner_id, owner::text), true))
));
create policy academic_material_files_update on storage.objects for update to authenticated
using (bucket_id = 'study-materials' and (app_private.material_file_manager(name)
  or (storage.allow_any_operation(array['object.upload', 'object.upload_update'])
    and app_private.material_file_owner(name, coalesce(owner_id, owner::text), true)
    and not app_private.material_file_submission_referenced(name))))
with check (bucket_id = 'study-materials' and (app_private.material_file_manager(name)
  or (storage.allow_any_operation(array['object.upload', 'object.upload_update'])
    and app_private.material_file_owner(name, coalesce(owner_id, owner::text), true)
    and not app_private.material_file_submission_referenced(name))));
create policy academic_material_files_delete on storage.objects for delete to authenticated
using (bucket_id = 'study-materials' and (app_private.material_file_manager(name)
  or (storage.allow_any_operation(array['object.delete', 'object.delete_many'])
    and app_private.material_file_owner(name, coalesce(owner_id, owner::text), true)
    and not app_private.material_file_referenced(name))));

revoke all on function
  app_private.material_file_scope(text), app_private.material_file_manager(text),
  app_private.material_file_shared_school(text),
  app_private.material_file_key(text),
  app_private.material_file_reference(text, text), app_private.material_file_owner(text, text, boolean),
  app_private.material_file_link_visible(text), app_private.material_file_referenced(text),
  app_private.material_file_submission_referenced(text)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.material_file_scope(text), app_private.material_file_manager(text),
  app_private.material_file_shared_school(text),
  app_private.material_file_key(text),
  app_private.material_file_reference(text, text), app_private.material_file_owner(text, text, boolean),
  app_private.material_file_link_visible(text), app_private.material_file_referenced(text),
  app_private.material_file_submission_referenced(text)
to authenticated;
commit;
