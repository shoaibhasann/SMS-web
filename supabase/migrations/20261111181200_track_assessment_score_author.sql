begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog;

-- updated_by follows every write (including remark-only edits), so it cannot
-- prove who entered a score. Track the score author separately for RP-03.
-- No FK: a set-null cascade would be re-pinned by the trigger below. No backfill
-- UPDATE: it would bump updated_at and stale every pending source token; legacy
-- NULLs fall back to updated_by.
alter table public.teacher_assessment_marks add column marks_entered_by uuid;

create function app_private.track_assessment_mark_author()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' or new.marks_obtained is distinct from old.marks_obtained then
    new.marks_entered_by:=(select auth.uid());
  else
    new.marks_entered_by:=coalesce(old.marks_entered_by,old.updated_by);
  end if;
  return new;
end;
$$;
create trigger teacher_assessment_marks_score_author before insert or update on public.teacher_assessment_marks
for each row execute function app_private.track_assessment_mark_author();
revoke all on function app_private.track_assessment_mark_author() from public,anon,authenticated,service_role;

create or replace function app_private.review_assessment_publication(p_submission_id uuid,p_decision text,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=app_private.result_actor();submission app_private.assessment_result_submissions%rowtype;source jsonb;
  reason_text text:=regexp_replace(p_reason,'^[[:space:]]+|[[:space:]]+$','','g');teacher_profile uuid;next_revision integer;
begin
  select * into submission from app_private.assessment_result_submissions s where s.id=p_submission_id;
  if not found or not app_private.has_school_roles(submission.school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot review this submission.' using errcode='42501'; end if;
  select t.profile_id into teacher_profile from public.teachers t where t.id=submission.teacher_id and t.school_id=submission.school_id;
  perform app_private.lock_result_profiles(teacher_profile);
  perform 1 from public.user_roles ur where ur.user_id=actor and((ur.school_id=submission.school_id and ur.role in('school_admin','principal'))
    or(ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'Office review access changed.' using errcode='42501'; end if;
  if p_decision is null or p_decision not in('published','rejected') or reason_text is null or char_length(reason_text) not between 3 and 1000 then
    raise exception 'Choose publish or reject and enter a reason between 3 and 1000 characters.' using errcode='22023'; end if;
  -- Parent first matches grading; pending-request locks are always second.
  perform 1 from public.teacher_assessments a where a.id=submission.assessment_id for update;
  select * into submission from app_private.assessment_result_submissions s where s.id=p_submission_id for update;
  if submission.requested_by=actor or teacher_profile=actor or exists(select 1 from jsonb_array_elements(submission.payload->'pupils') p
    where p->>'mark_updated_by'=actor::text) or submission.status='pending' and exists(select 1 from public.teacher_assessment_marks m
    where m.assessment_id=submission.assessment_id and coalesce(m.marks_entered_by,m.updated_by)=actor) then
    raise exception 'A different administrator or principal must review results you authored or submitted.' using errcode='42501'; end if;
  if submission.status<>'pending' then
    if(submission.status,submission.reviewed_by,submission.review_note)=(p_decision,actor,reason_text) then return submission.id; end if;
    raise exception 'This submission already has a final decision. Refresh its status.' using errcode='PT409'; end if;
  if p_decision='published' then
    perform 1 from public.user_roles ur where ur.user_id=teacher_profile and ur.school_id=submission.school_id and ur.role='teacher' for share;
    source:=app_private.assessment_result_source(submission.assessment_id);
    if not found or source is null or not coalesce((source->>'can_submit')::boolean,false)
      or app_private.assessment_result_token(source)<>submission.source_token then
      raise exception 'The assessment, marks, assignment or roster changed. Reject or cancel this submission and request a fresh review.' using errcode='PT409'; end if;
    select coalesce(max(s.revision),0)+1 into next_revision from app_private.assessment_result_submissions s where s.assessment_id=submission.assessment_id;
  end if;
  update app_private.assessment_result_submissions set status=p_decision,reviewed_by=actor,
    reviewer_name=(select coalesce(nullif(btrim(p.full_name),''),'School office') from public.profiles p where p.id=actor),
    review_note=reason_text,reviewed_at=clock_timestamp(),revision=next_revision where id=submission.id;
  return submission.id;
end;
$$;

create or replace function app_private.get_assessment_result_submission(p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=app_private.result_actor();submission app_private.assessment_result_submissions%rowtype;matches boolean:=null;source jsonb;
begin
  select * into submission from app_private.assessment_result_submissions s where s.id=p_submission_id;
  if not found or not(app_private.has_school_roles(submission.school_id,array['school_admin','principal']::public.app_role[])
    or(submission.requested_by=actor and app_private.result_teacher_access(submission.assessment_id))) then
    raise exception 'You cannot view this submitted result snapshot.' using errcode='42501'; end if;
  if submission.status='pending' then
    source:=app_private.assessment_result_source(submission.assessment_id);
    matches:=coalesce((source->>'can_submit')::boolean,false) and app_private.assessment_result_token(source)=submission.source_token;
    matches:=coalesce(matches,false);
  end if;
  return jsonb_build_object('id',submission.id,'assessment_id',submission.assessment_id,'school_id',submission.school_id,'status',submission.status,
    'source_token',submission.source_token,'requested_by',submission.requested_by,'requester_name',submission.requester_name,'requested_at',submission.requested_at,
    'reviewed_by',submission.reviewed_by,'reviewer_name',submission.reviewer_name,'review_note',submission.review_note,'reviewed_at',submission.reviewed_at,
    'revision',submission.revision,'snapshot',jsonb_build_object('metadata',submission.payload->'metadata','pupils',submission.payload->'pupils'),'source_matches',matches,
    'viewer_entered_marks',submission.status='pending' and exists(select 1 from public.teacher_assessment_marks m
      where m.assessment_id=submission.assessment_id and coalesce(m.marks_entered_by,m.updated_by)=actor));
end;
$$;

revoke all on function public.review_assessment_publication(uuid,text,text),app_private.review_assessment_publication(uuid,text,text),
  public.get_assessment_result_submission(uuid),app_private.get_assessment_result_submission(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.review_assessment_publication(uuid,text,text),app_private.review_assessment_publication(uuid,text,text),
  public.get_assessment_result_submission(uuid),app_private.get_assessment_result_submission(uuid)
  to authenticated;
commit;
