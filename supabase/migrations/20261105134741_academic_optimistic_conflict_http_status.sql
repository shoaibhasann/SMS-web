begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Business optimistic conflicts are HTTP 409, not retryable database
-- serialization failures. PostgREST 14 retries custom 40001 indefinitely.
create or replace function app_private.save_academic_log(p_log jsonb,p_activities jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare teacher public.teachers%rowtype; saved public.class_logs%rowtype; log_id uuid; entry jsonb; activity_id uuid; kept uuid[]:='{}';
begin
  if jsonb_typeof(p_log) is distinct from 'object' or jsonb_typeof(p_activities) is distinct from 'array'
    or jsonb_array_length(p_activities)>100 then raise exception 'Invalid academic log payload.' using errcode='22023'; end if;
  select * into teacher from public.teachers where profile_id=auth.uid();
  if not found then raise exception 'A linked teacher is required.' using errcode='42501'; end if;
  if p_log ? 'teacher_id' and p_log->>'teacher_id' is distinct from teacher.id::text then
    raise exception 'The log author cannot be supplied by another teacher.' using errcode='42501';
  end if;
  perform app_private.lock_academic_write_scope(teacher.id,(p_log->>'school_id')::uuid,(p_log->>'academic_year_id')::uuid,
    (p_log->>'class_id')::uuid,(p_log->>'section_id')::uuid,(p_log->>'subject_id')::uuid);
  if coalesce(btrim(p_log->>'topic'),'')='' or char_length(p_log->>'topic')>1000 then
    raise exception 'Enter a topic of 1 to 1000 characters.' using errcode='22023'; end if;
  log_id:=nullif(p_log->>'id','')::uuid;
  if log_id is null then
    insert into public.class_logs(school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,summary,teacher_remark,status)
    values((p_log->>'school_id')::uuid,(p_log->>'academic_year_id')::uuid,(p_log->>'class_id')::uuid,(p_log->>'section_id')::uuid,
      (p_log->>'subject_id')::uuid,teacher.id,(p_log->>'log_date')::date,btrim(p_log->>'topic'),coalesce(btrim(p_log->>'summary'),''),
      nullif(btrim(p_log->>'teacher_remark'),''),coalesce(p_log->>'status','draft')) returning * into saved;
  else
    select * into saved from public.class_logs where id=log_id for update;
    if not found or saved.teacher_id<>teacher.id then raise exception 'This log is unavailable to its author.' using errcode='42501'; end if;
    if nullif(p_log->>'expected_updated_at','') is null then
      raise exception 'Reload this academic log before editing it.' using errcode='22023';
    end if;
    if saved.updated_at is distinct from (p_log->>'expected_updated_at')::timestamptz then
      raise exception 'Academic work changed. Reload before saving your draft.' using errcode='PT409';
    end if;
    if (saved.school_id,saved.academic_year_id,saved.class_id,saved.section_id,saved.subject_id,saved.log_date)
      is distinct from ((p_log->>'school_id')::uuid,(p_log->>'academic_year_id')::uuid,(p_log->>'class_id')::uuid,
        (p_log->>'section_id')::uuid,(p_log->>'subject_id')::uuid,(p_log->>'log_date')::date) then
      raise exception 'An academic record cannot be moved to another placement or date.' using errcode='42501';
    end if;
    update public.class_logs set topic=btrim(p_log->>'topic'),summary=coalesce(btrim(p_log->>'summary'),''),
      teacher_remark=nullif(btrim(p_log->>'teacher_remark'),''),status=coalesce(p_log->>'status',saved.status)
    where id=saved.id returning * into saved;
  end if;
  for entry in select value from jsonb_array_elements(p_activities) loop
    if jsonb_typeof(entry) is distinct from 'object' or coalesce(btrim(entry->>'title'),'')='' then
      raise exception 'Every activity needs a title.' using errcode='22023'; end if;
    activity_id:=nullif(entry->>'id','')::uuid;
    if activity_id is null then
      insert into public.class_activities(class_log_id,activity_type,title,description,due_date,attachment_url,max_marks)
      values(saved.id,(entry->>'activity_type')::public.activity_type,btrim(entry->>'title'),entry->>'description',
        nullif(entry->>'due_date','')::date,nullif(entry->>'attachment_url',''),nullif(entry->>'max_marks','')::numeric) returning id into activity_id;
    else
      if activity_id=any(kept) then raise exception 'Duplicate activity identifier.' using errcode='22023'; end if;
      perform 1 from public.class_activities where id=activity_id and class_log_id=saved.id for update;
      if not found then raise exception 'An activity is outside this log.' using errcode='42501'; end if;
      update public.class_activities set activity_type=(entry->>'activity_type')::public.activity_type,title=btrim(entry->>'title'),
        description=entry->>'description',due_date=nullif(entry->>'due_date','')::date,attachment_url=nullif(entry->>'attachment_url',''),
        max_marks=nullif(entry->>'max_marks','')::numeric where id=activity_id;
    end if;
    kept:=array_append(kept,activity_id);
  end loop;
  delete from public.class_activities where class_log_id=saved.id and not(id=any(kept));
  return saved.id;
end;
$$;

commit;
