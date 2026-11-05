begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Business optimistic conflicts are HTTP 409, not retryable database
-- serialization failures. PostgREST 14 retries custom 40001 indefinitely.
create or replace function app_private.submit_homework(p_activity_id uuid,p_text_response text,p_file_path text,p_expected_revision bigint,p_request_id uuid,p_file_name text default null)
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
      raise exception 'Your homework changed. Reload before submitting.' using errcode='PT409'; end if;
    if existing.status not in ('pending','submitted') or existing.marks is not null or existing.feedback is not null then
      raise exception 'Reviewed homework is read-only.' using errcode='42501'; end if;
    update public.activity_submissions set text_response=response,file_path=response_path,
      file_name=response_name,status='submitted' where id=existing.id returning * into existing;
  else
    if p_expected_revision is not null then raise exception 'Your homework changed. Reload before submitting.' using errcode='PT409'; end if;
    insert into public.activity_submissions(activity_id,student_id,text_response,file_path,file_name,status)
      values(p_activity_id,pupil.id,response,response_path,response_name,'submitted') returning * into existing;
  end if;
  result:=jsonb_build_object('id',existing.id,'revision',existing.revision,'status',existing.status);
  insert into app_private.homework_write_receipts(request_id,actor_id,action,payload,result) values(p_request_id,auth.uid(),'submit',payload,result);
  return result;
end;
$$;

create or replace function app_private.grade_homework(p_submission_id uuid,p_marks numeric,p_feedback text,p_expected_revision bigint,p_request_id uuid)
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
    raise exception 'The response or grade changed. Reload before grading.' using errcode='PT409'; end if;
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

commit;
