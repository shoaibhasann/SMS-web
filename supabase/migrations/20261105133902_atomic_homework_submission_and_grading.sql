begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.activity_submissions
  add column revision bigint not null default 0 check(revision between 0 and 9007199254740991),
  add column file_path text,
  add column file_name text check(char_length(file_name)<=180);
create unique index homework_submission_file_unique on public.activity_submissions(file_path) where file_path is not null;
create index homework_submissions_activity_order on public.activity_submissions(activity_id,submitted_at,id);

create table app_private.homework_write_receipts(
  request_id uuid primary key,
  actor_id uuid not null,
  action text not null check(action in ('submit','grade')),
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table app_private.homework_write_receipts enable row level security;
revoke all on app_private.homework_write_receipts from public,anon,authenticated,service_role;

-- Row writes are atomic APIs. SELECT continues through the existing family,
-- teacher and office policies; no caller-controlled flag bypasses this boundary.
revoke insert,update,delete on public.activity_submissions from authenticated;

create function app_private.homework_file_scope(p_path text)
returns uuid[] language plpgsql immutable set search_path='' as $$
declare parts text[]:=string_to_array(p_path,'/');
begin
  if p_path is null or array_length(parts,1)<>8 or parts[8]!~*'^[0-9a-f-]{36}\.(pdf|jpg|jpeg|png)$' then return null; end if;
  return array[parts[1]::uuid,parts[2]::uuid,parts[3]::uuid,parts[4]::uuid,parts[5]::uuid,parts[6]::uuid,parts[7]::uuid,split_part(parts[8],'.',1)::uuid];
exception when invalid_text_representation then return null;
end;
$$;

create function app_private.homework_student_scope(p_activity_id uuid,p_student_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select app_private.student_academic_submission(p_activity_id,p_student_id,p_write) and exists(
    select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    join public.classes class on class.id=log.class_id and class.school_id=log.school_id
    join public.sections section on section.id=log.section_id and section.class_id=class.id and section.school_id=log.school_id
    join public.subjects subject on subject.id=log.subject_id and subject.school_id=log.school_id
    where activity.id=p_activity_id and activity.activity_type='homework'
      and (not p_write or class.is_active and subject.is_active and not exists(
        select 1 from public.activity_submissions submission where submission.activity_id=p_activity_id and submission.student_id=p_student_id
          and (submission.status not in ('pending','submitted') or submission.marks is not null or submission.feedback is not null))));
$$;

create function app_private.homework_teacher_scope(p_activity_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select app_private.teacher_academic_activity(p_activity_id,p_write) and exists(
    select 1 from public.class_activities activity join public.class_logs log on log.id=activity.class_log_id
    where activity.id=p_activity_id and activity.activity_type='homework' and (not p_write or log.status='published'));
$$;

create function app_private.homework_file_name(p_name text)
returns text language sql immutable set search_path='' as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_name,''),'^.*[/\\]','','g'),'[[:cntrl:]]','','g')),180),'');
$$;

create function app_private.validate_homework_file(p_activity_id uuid,p_student_id uuid,p_path text)
returns void language plpgsql security definer set search_path='' as $$
declare parts uuid[]:=app_private.homework_file_scope(p_path); activity public.class_activities%rowtype; log public.class_logs%rowtype;
  object_metadata jsonb; object_owner text; pupil_user uuid; bytes bigint; mime text; extension text;
begin
  select * into activity from public.class_activities where id=p_activity_id;
  select * into log from public.class_logs where id=activity.class_log_id;
  select profile_id into pupil_user from public.students where id=p_student_id;
  if parts is null or (parts[1],parts[2],parts[3],parts[4],parts[5],parts[6],parts[7]) is distinct from
    (log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id,p_activity_id,p_student_id) then
    raise exception 'The attachment is outside this pupil homework scope.' using errcode='42501'; end if;
  select metadata,coalesce(owner_id,owner::text) into object_metadata,object_owner
    from storage.objects where bucket_id='homework-submissions' and name=p_path for share;
  if not found or pupil_user is null or object_owner is distinct from pupil_user::text then
    raise exception 'Upload your own homework attachment before submitting.' using errcode='42501'; end if;
  if coalesce(object_metadata->>'size','')!~'^[0-9]{1,10}$' then
    raise exception 'The uploaded attachment has invalid size metadata.' using errcode='22023'; end if;
  bytes:=(object_metadata->>'size')::bigint; mime:=lower(object_metadata->>'mimetype'); extension:=lower(split_part(p_path,'.',2));
  if bytes<1 or bytes>10485760 or mime is null or not(
    (extension='pdf' and mime='application/pdf') or (extension in ('jpg','jpeg') and mime='image/jpeg') or (extension='png' and mime='image/png')) then
    raise exception 'Upload a PDF, JPEG or PNG no larger than 10 MiB.' using errcode='22023'; end if;
end;
$$;

create function app_private.guard_homework_submission_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if current_setting('role',true) in ('authenticated','anon') then
      raise exception 'Homework submission history must be preserved.' using errcode='42501'; end if;
    return old;
  end if;
  if tg_op='INSERT' then new.revision:=0;
  else new.revision:=old.revision+1;
  end if;
  if current_setting('role',true) not in ('authenticated','anon') then return new; end if;
  if tg_op='UPDATE' then
    if new.file_url is distinct from old.file_url then raise exception 'Legacy submission evidence cannot be replaced.' using errcode='42501'; end if;
    if old.file_path is not null and (new.file_path,new.file_name) is distinct from (old.file_path,old.file_name) then
      raise exception 'A submitted attachment cannot be replaced or removed.' using errcode='42501'; end if;
  elsif new.file_url is not null then raise exception 'Submit an uploaded private file path instead of an external URL.' using errcode='42501';
  end if;
  if new.file_path is not null and (tg_op='INSERT' or old.file_path is distinct from new.file_path) then
    if not app_private.homework_student_scope(new.activity_id,new.student_id,true) then
      raise exception 'Only the pupil may attach homework evidence.' using errcode='42501'; end if;
    if tg_op='UPDATE' and old.file_url is not null then raise exception 'Existing submission evidence must be preserved.' using errcode='42501'; end if;
    perform app_private.validate_homework_file(new.activity_id,new.student_id,new.file_path);
    new.file_name:=coalesce(app_private.homework_file_name(new.file_name),split_part(new.file_path,'/',8));
  end if;
  if new.file_path is null then new.file_name:=null; end if;
  if nullif(btrim(new.text_response),'') is null and new.file_path is null and new.file_url is null then
    raise exception 'Add a response or a private attachment.' using errcode='22023'; end if;
  if char_length(coalesce(new.text_response,''))>10000 or char_length(coalesce(new.feedback,''))>2000 then
    raise exception 'The response or feedback is too long.' using errcode='22023'; end if;
  return new;
end;
$$;
create trigger zz_guard_homework_submission_version before insert or update or delete on public.activity_submissions
for each row execute function app_private.guard_homework_submission_version();

create function app_private.submit_homework(p_activity_id uuid,p_text_response text,p_file_path text,p_expected_revision bigint,p_request_id uuid,p_file_name text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pupil public.students%rowtype; activity public.class_activities%rowtype; log public.class_logs%rowtype;
  existing public.activity_submissions%rowtype; receipt app_private.homework_write_receipts%rowtype;
  response text:=nullif(btrim(p_text_response,E' \t\n\r'),''); response_path text:=nullif(btrim(p_file_path),''); response_name text:=app_private.homework_file_name(p_file_name);
  payload jsonb; result jsonb;
begin
  if auth.uid() is null or p_request_id is null then raise exception 'Sign in with a pupil account and a request identifier.' using errcode='42501'; end if;
  select * into pupil from public.students where profile_id=auth.uid();
  if not found or not app_private.homework_student_scope(p_activity_id,pupil.id,false) then raise exception 'This homework is unavailable to this pupil.' using errcode='42501'; end if;
  payload:=jsonb_build_object('activity_id',p_activity_id,'text_response',response,'file_path',response_path,'file_name',response_name,'expected_revision',p_expected_revision);
  perform pg_advisory_xact_lock(hashtextextended('homework-request:'||p_request_id::text,0));
  select * into receipt from app_private.homework_write_receipts where request_id=p_request_id;
  if found then
    if (receipt.actor_id,receipt.action,receipt.payload) is distinct from (auth.uid(),'submit'::text,payload) then
      raise exception 'This request identifier belongs to another action.' using errcode='23505'; end if;
    return receipt.result;
  end if;
  select * into activity from public.class_activities where id=p_activity_id;
  select * into log from public.class_logs where id=activity.class_log_id for share;
  select * into activity from public.class_activities where id=p_activity_id and class_log_id=log.id for share;
  if not found or not app_private.homework_student_scope(p_activity_id,pupil.id,true) then
    raise exception 'This homework no longer accepts pupil edits.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('homework-pupil:'||p_activity_id::text||':'||pupil.id::text,0));
  select * into existing from public.activity_submissions where activity_id=p_activity_id and student_id=pupil.id for update;
  if found then
    if p_expected_revision is null or p_expected_revision<>existing.revision then
      raise exception 'Your homework changed. Reload before submitting.' using errcode='40001'; end if;
    if existing.status not in ('pending','submitted') or existing.marks is not null or existing.feedback is not null then
      raise exception 'Reviewed homework is read-only.' using errcode='42501'; end if;
    update public.activity_submissions set text_response=response,file_path=response_path,
      file_name=response_name,status='submitted' where id=existing.id returning * into existing;
  else
    if p_expected_revision is not null then raise exception 'Your homework changed. Reload before submitting.' using errcode='40001'; end if;
    insert into public.activity_submissions(activity_id,student_id,text_response,file_path,file_name,status)
      values(p_activity_id,pupil.id,response,response_path,response_name,'submitted') returning * into existing;
  end if;
  result:=jsonb_build_object('id',existing.id,'revision',existing.revision,'status',existing.status);
  insert into app_private.homework_write_receipts(request_id,actor_id,action,payload,result) values(p_request_id,auth.uid(),'submit',payload,result);
  return result;
end;
$$;

create function app_private.grade_homework(p_submission_id uuid,p_marks numeric,p_feedback text,p_expected_revision bigint,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare submission public.activity_submissions%rowtype; activity public.class_activities%rowtype; log public.class_logs%rowtype;
  receipt app_private.homework_write_receipts%rowtype; note text:=nullif(btrim(p_feedback,E' \t\n\r'),''); payload jsonb; result jsonb;
begin
  if auth.uid() is null or p_request_id is null then raise exception 'Sign in with a teacher account and a request identifier.' using errcode='42501'; end if;
  select * into submission from public.activity_submissions where id=p_submission_id;
  if not found or not app_private.homework_teacher_scope(submission.activity_id,false)
    or not app_private.teacher_academic_submission(submission.activity_id,submission.student_id,false) then
    raise exception 'This pupil submission is unavailable to its assigned teacher.' using errcode='42501'; end if;
  payload:=jsonb_build_object('submission_id',p_submission_id,'marks',p_marks,'feedback',note,'expected_revision',p_expected_revision);
  perform pg_advisory_xact_lock(hashtextextended('homework-request:'||p_request_id::text,0));
  select * into receipt from app_private.homework_write_receipts where request_id=p_request_id;
  if found then
    if (receipt.actor_id,receipt.action,receipt.payload) is distinct from (auth.uid(),'grade'::text,payload) then
      raise exception 'This request identifier belongs to another action.' using errcode='23505'; end if;
    return receipt.result;
  end if;
  select * into activity from public.class_activities where id=submission.activity_id;
  select * into log from public.class_logs where id=activity.class_log_id for share;
  select * into activity from public.class_activities where id=submission.activity_id and class_log_id=log.id for share;
  if not found or not app_private.homework_teacher_scope(activity.id,true) then
    raise exception 'Current assigned teacher access is required to grade homework.' using errcode='42501'; end if;
  perform app_private.lock_academic_write_scope(log.teacher_id,log.school_id,log.academic_year_id,log.class_id,log.section_id,log.subject_id);
  select * into submission from public.activity_submissions where id=p_submission_id for update;
  if not found or p_expected_revision is null or p_expected_revision<>submission.revision then
    raise exception 'The response or grade changed. Reload before grading.' using errcode='40001'; end if;
  if not app_private.teacher_academic_submission(submission.activity_id,submission.student_id,true) then
    raise exception 'The pupil is outside this teacher homework scope.' using errcode='42501'; end if;
  if p_marks is null and note is null or char_length(coalesce(note,''))>2000 or
    (p_marks is not null and (p_marks<0 or p_marks::text in ('NaN','Infinity','-Infinity') or activity.max_marks is null or p_marks>activity.max_marks)) then
    raise exception 'Enter feedback or finite marks within a configured maximum.' using errcode='22023'; end if;
  update public.activity_submissions set marks=p_marks,feedback=note,status='graded' where id=submission.id returning * into submission;
  result:=jsonb_build_object('id',submission.id,'revision',submission.revision,'status',submission.status);
  insert into app_private.homework_write_receipts(request_id,actor_id,action,payload,result) values(p_request_id,auth.uid(),'grade',payload,result);
  return result;
end;
$$;

create function app_private.list_my_homework_submissions(p_activity_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or coalesce(cardinality(p_activity_ids),0)>100 then raise exception 'Choose at most 100 homework activities.' using errcode='22023'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',submission.id,'activity_id',submission.activity_id,'student_id',submission.student_id,
    'text_response',submission.text_response,'file_path',submission.file_path,'file_name',submission.file_name,'submitted_at',submission.submitted_at,
    'status',submission.status,'marks',submission.marks,'feedback',submission.feedback,'revision',submission.revision) order by submission.submitted_at,submission.id),'[]'::jsonb)
    from public.activity_submissions submission where submission.activity_id=any(p_activity_ids)
      and app_private.homework_student_scope(submission.activity_id,submission.student_id,false));
end;
$$;

create function app_private.list_homework_submissions_for_grading(p_activity_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare activity public.class_activities%rowtype; log public.class_logs%rowtype;
begin
  if not app_private.homework_teacher_scope(p_activity_id,false) then raise exception 'Assigned teacher access is required.' using errcode='42501'; end if;
  select * into activity from public.class_activities where id=p_activity_id;
  select * into log from public.class_logs where id=activity.class_log_id;
  return jsonb_build_object('activity',jsonb_build_object('id',activity.id,'title',activity.title,'max_marks',activity.max_marks),'students',(
    select coalesce(jsonb_agg(jsonb_build_object('student_id',pupil.id,'first_name',pupil.first_name,'middle_name',pupil.middle_name,'last_name',pupil.last_name,'admission_no',pupil.admission_no,
      'submission',case when submission.id is null then null else jsonb_build_object('id',submission.id,'activity_id',submission.activity_id,'student_id',submission.student_id,
        'text_response',submission.text_response,'file_path',submission.file_path,'file_name',submission.file_name,'submitted_at',submission.submitted_at,
        'status',submission.status,'marks',submission.marks,'feedback',submission.feedback,'revision',submission.revision) end) order by pupil.admission_no,pupil.id),'[]'::jsonb)
    from public.enrollments enrollment join public.students pupil on pupil.id=enrollment.student_id and pupil.school_id=log.school_id
    left join public.activity_submissions submission on submission.student_id=pupil.id and submission.activity_id=activity.id
    where enrollment.academic_year_id=log.academic_year_id and enrollment.class_id=log.class_id and enrollment.section_id=log.section_id and enrollment.status='active'
  ));
end;
$$;

create function public.submit_homework(p_activity_id uuid,p_text_response text,p_file_path text,p_expected_revision bigint,p_request_id uuid,p_file_name text default null)
returns jsonb language sql security invoker set search_path='' as $$
  select app_private.submit_homework(p_activity_id,p_text_response,p_file_path,p_expected_revision,p_request_id,p_file_name);
$$;
create function public.grade_homework(p_submission_id uuid,p_marks numeric,p_feedback text,p_expected_revision bigint,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select app_private.grade_homework(p_submission_id,p_marks,p_feedback,p_expected_revision,p_request_id);
$$;
create function public.list_my_homework_submissions(p_activity_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $$ select app_private.list_my_homework_submissions(p_activity_ids); $$;
create function public.list_homework_submissions_for_grading(p_activity_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$ select app_private.list_homework_submissions_for_grading(p_activity_id); $$;

revoke all on function app_private.homework_file_scope(text),app_private.homework_student_scope(uuid,uuid,boolean),app_private.homework_teacher_scope(uuid,boolean),
  app_private.homework_file_name(text),app_private.validate_homework_file(uuid,uuid,text),app_private.guard_homework_submission_version(),
  app_private.submit_homework(uuid,text,text,bigint,uuid,text),app_private.grade_homework(uuid,numeric,text,bigint,uuid),
  app_private.list_my_homework_submissions(uuid[]),app_private.list_homework_submissions_for_grading(uuid),
  public.submit_homework(uuid,text,text,bigint,uuid,text),public.grade_homework(uuid,numeric,text,bigint,uuid),
  public.list_my_homework_submissions(uuid[]),public.list_homework_submissions_for_grading(uuid)
from public,anon,authenticated,service_role;
grant execute on function app_private.homework_file_scope(text),app_private.homework_student_scope(uuid,uuid,boolean),app_private.homework_teacher_scope(uuid,boolean),
  app_private.submit_homework(uuid,text,text,bigint,uuid,text),app_private.grade_homework(uuid,numeric,text,bigint,uuid),
  app_private.list_my_homework_submissions(uuid[]),app_private.list_homework_submissions_for_grading(uuid),
  public.submit_homework(uuid,text,text,bigint,uuid,text),public.grade_homework(uuid,numeric,text,bigint,uuid),
  public.list_my_homework_submissions(uuid[]),public.list_homework_submissions_for_grading(uuid)
to authenticated;
commit;
