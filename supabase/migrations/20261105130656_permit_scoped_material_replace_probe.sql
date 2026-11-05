begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- Storage's PUT replacement performs an INSERT ... ON CONFLICT permission
-- probe. It therefore needs the same scoped INSERT check as a normal upload.
-- UPDATE's submission-reference/owner/assignment checks remain authoritative.
alter policy academic_material_files_insert on storage.objects to authenticated
with check (bucket_id = 'study-materials' and (
  app_private.material_file_manager(name)
  or (storage.allow_any_operation(array['object.upload', 'object.upload_update'])
    and app_private.material_file_owner(name, coalesce(owner_id, owner::text), true))
));
commit;
