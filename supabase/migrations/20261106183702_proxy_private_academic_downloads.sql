-- Download bytes only through the authenticated server proxy. A SQL policy
-- cannot invalidate previously cached CDN responses: deployment must also
-- purge these buckets (where supported) or verify their old cached URLs expire.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The source lookup below deliberately runs as its caller. The narrow definer
-- bridge only reuses the existing verified account/live-session actor check.
create function app_private.private_academic_file_context()
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare actor uuid:=app_private.result_actor();
begin
  return jsonb_build_object('user_id',actor,
    'homework_limit',coalesce((select least(coalesce(file_size_limit,10485760),10485760) from storage.buckets where id='homework-submissions'),10485760),
    'material_limit',coalesce((select least(coalesce(file_size_limit,20971520),20971520) from storage.buckets where id='study-materials'),20971520));
end;
$$;
revoke all on function app_private.private_academic_file_context() from public,anon,authenticated,service_role;
grant execute on function app_private.private_academic_file_context(),app_private.homework_file_name(text) to authenticated;

-- Keep the metadata SELECTs used by uploads/replacements/deletes, but put
-- the operation gate outside every branch, including school administrators.
-- object.academic_file_grant is set only by the fixed INVOKER RPC below. It
-- never serves bytes or a signed URL and cannot be chosen by Storage clients.
alter policy homework_files_read on storage.objects using (
  bucket_id='homework-submissions'
  and storage.allow_any_operation(array['object.academic_file_grant','object.upload','object.delete','object.delete_many'])
  and (app_private.homework_file_owner(name,coalesce(owner_id,owner::text),false)
    or app_private.homework_file_link_visible(name))
);
alter policy academic_material_files_read on storage.objects using (
  bucket_id='study-materials'
  and storage.allow_any_operation(array['object.academic_file_grant','object.upload','object.upload_update','object.delete','object.delete_many'])
  and (app_private.material_file_manager(name)
    or app_private.material_file_owner(name,coalesce(owner_id,owner::text),false)
    or app_private.material_file_link_visible(name))
);

create function public.authorize_private_academic_file(p_kind text,p_id uuid)
returns jsonb language plpgsql volatile security invoker set search_path = ''
as $$
declare
  file_context jsonb:=app_private.private_academic_file_context();
  actor uuid:=(file_context->>'user_id')::uuid;
  selected_school uuid; selected_bucket text; selected_path text; selected_name text;
  source_path text; legacy_path text; previous_operation text:=current_setting('storage.operation',true);
  object storage.objects%rowtype; parsed uuid[]; size_text text; bytes bigint; mime text; fingerprint text;
begin
  if p_kind is null or p_kind not in ('submission','activity','material') or p_id is null then
    raise exception 'Choose an available academic attachment.' using errcode='22023';
  end if;
  -- These SELECTs retain the exact existing school, teacher assignment,
  -- publication, student and linked-child row policies; no copied permission
  -- predicate and no user-provided bucket/path/user ID is accepted.
  if p_kind='submission' then
    select log.school_id,submission.file_path,submission.file_url,submission.file_name
      into selected_school,source_path,legacy_path,selected_name
      from public.activity_submissions submission
      join public.class_activities activity on activity.id=submission.activity_id
      join public.class_logs log on log.id=activity.class_log_id
      where submission.id=p_id;
    if source_path is not null then selected_bucket:='homework-submissions'; selected_path:=source_path;
    else selected_bucket:='study-materials'; selected_path:=app_private.material_file_key(legacy_path); end if;
  elsif p_kind='activity' then
    select log.school_id,activity.attachment_url into selected_school,source_path
      from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
      where activity.id=p_id;
    selected_bucket:='study-materials'; selected_path:=app_private.material_file_key(source_path);
  else
    select material.school_id,material.file_url into selected_school,source_path
      from public.study_materials material where material.id=p_id;
    selected_bucket:='study-materials'; selected_path:=app_private.material_file_key(source_path);
  end if;
  if selected_school is null or selected_path is null or selected_path='' then
    raise exception 'This attachment is unavailable.' using errcode='42501';
  end if;
  if selected_bucket='homework-submissions' then
    parsed:=app_private.homework_file_scope(selected_path);
    if parsed is null or parsed[1]<>selected_school then
      raise exception 'This attachment is unavailable.' using errcode='42501';
    end if;
  else
    parsed:=app_private.material_file_scope(selected_path);
    if (parsed is null or parsed[1]<>selected_school)
      and app_private.material_file_shared_school(selected_path) is distinct from selected_school then
      raise exception 'This attachment is unavailable.' using errcode='42501';
    end if;
  end if;

  -- Even after the source row was authorized, Storage RLS checks the physical
  -- object's owner/scope/reference in the same caller context. Restore the
  -- gateway's operation on success, early return and every exception path.
  perform set_config('storage.operation','object.academic_file_grant',true);
  select * into object from storage.objects where bucket_id=selected_bucket and name=selected_path;
  perform set_config('storage.operation',coalesce(previous_operation,''),true);
  if object.id is null then raise exception 'This attachment is unavailable.' using errcode='42501'; end if;
  size_text:=object.metadata->>'size';
  if size_text is null or size_text!~'^[0-9]{1,10}$' then
    raise exception 'The attachment size could not be verified.' using errcode='22023';
  end if;
  bytes:=size_text::bigint;
  if bytes<1 or bytes>(case when selected_bucket='homework-submissions' then (file_context->>'homework_limit')::bigint else (file_context->>'material_limit')::bigint end) then
    raise exception 'The attachment is outside the download size limit.' using errcode='22023';
  end if;
  mime:=lower(btrim(coalesce(object.metadata->>'mimetype','')));
  if selected_bucket='homework-submissions' and mime not in ('application/pdf','image/jpeg','image/png') then
    raise exception 'The attachment format could not be verified.' using errcode='22023';
  end if;
  if mime not in ('application/pdf','image/jpeg','image/png','text/plain') then mime:='application/octet-stream'; end if;
  selected_name:=coalesce(app_private.homework_file_name(selected_name),app_private.homework_file_name(selected_path),'attachment');
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(object.id,to_jsonb(object)->>'version',object.updated_at,object.metadata)::text,'UTF8')),'hex');
  return jsonb_build_object('user_id',actor,'school_id',selected_school,'kind',p_kind,'id',p_id,
    'bucket',selected_bucket,'path',selected_path,'file_name',selected_name,'content_type',mime,'byte_size',bytes,'version',fingerprint);
exception when others then
  perform set_config('storage.operation',coalesce(previous_operation,''),true);
  raise;
end;
$$;
revoke all on function public.authorize_private_academic_file(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.authorize_private_academic_file(text,uuid) to authenticated;
commit;
