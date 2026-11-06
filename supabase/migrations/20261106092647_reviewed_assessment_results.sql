begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog;

-- Every source mark writer takes the same parent lock as publication, including
-- trusted deletes/moves; API grading retains its existing permission guards.
create function app_private.lock_result_source_mark()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' then
    perform 1 from public.teacher_assessments where id=new.assessment_id for update;
  elsif tg_op='DELETE' then
    perform 1 from public.teacher_assessments where id=old.assessment_id for update;
  else
    perform 1 from public.teacher_assessments where id in(old.assessment_id,new.assessment_id) order by id for update;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger aa_lock_result_source_mark before insert or update or delete on public.teacher_assessment_marks
for each row execute function app_private.lock_result_source_mark();

create table app_private.assessment_result_submissions(
  id uuid primary key default gen_random_uuid(),assessment_id uuid not null,
  school_id uuid not null references public.schools(id) on delete cascade,
  teacher_id uuid not null,requested_by uuid not null references public.profiles(id),requester_name text not null,
  requested_at timestamptz not null default clock_timestamp(),source_token text not null check(source_token~'^[a-f0-9]{64}$'),
  payload jsonb not null,status text not null default 'pending' check(status in('pending','published','rejected','cancelled')),
  reviewed_by uuid references public.profiles(id),reviewer_name text,review_note text,reviewed_at timestamptz,
  revision integer check(revision>0),unique(assessment_id,revision),
  check((status='pending' and reviewed_by is null and reviewer_name is null and review_note is null and reviewed_at is null and revision is null)
    or(status<>'pending' and reviewed_by is not null and reviewer_name is not null and review_note is not null and reviewed_at is not null)),
  check((status='published')=(revision is not null)),
  check(status='cancelled' or reviewed_by is distinct from requested_by)
);
create unique index assessment_result_one_pending on app_private.assessment_result_submissions(assessment_id) where status='pending';
create index assessment_result_school_queue on app_private.assessment_result_submissions(school_id,status,requested_at desc,id desc);
create index assessment_result_requester on app_private.assessment_result_submissions(requested_by,requested_at desc,id desc);
create index assessment_result_published on app_private.assessment_result_submissions(assessment_id,revision desc) where status='published';
create table app_private.assessment_result_intents(
  actor_id uuid not null references public.profiles(id),request_id uuid not null,assessment_id uuid not null,
  source_token text not null,submission_id uuid not null references app_private.assessment_result_submissions(id),
  primary key(actor_id,request_id)
);
alter table app_private.assessment_result_submissions enable row level security;
alter table app_private.assessment_result_intents enable row level security;
revoke all on app_private.assessment_result_submissions,app_private.assessment_result_intents from public,anon,authenticated,service_role;

create function app_private.guard_assessment_result_submission()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Result publication history cannot be deleted.' using errcode='42501'; end if;
  if old.status<>'pending' or(new.id,new.assessment_id,new.school_id,new.teacher_id,new.requested_by,new.requester_name,
    new.requested_at,new.source_token,new.payload) is distinct from(old.id,old.assessment_id,old.school_id,old.teacher_id,
    old.requested_by,old.requester_name,old.requested_at,old.source_token,old.payload) then
    raise exception 'Submitted result snapshots and final decisions are immutable.' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger guard_assessment_result_submission before update or delete on app_private.assessment_result_submissions
for each row execute function app_private.guard_assessment_result_submission();

create function app_private.result_actor()
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
  perform 1 from auth.users u where u.id=actor and not coalesce(u.is_anonymous,false) and u.deleted_at is null
    and(u.banned_until is null or u.banned_until<=now()) and(u.email_confirmed_at is not null or u.phone_confirmed_at is not null) for share;
  if not found or not exists(select 1 from public.profiles p where p.id=actor and p.is_active) then
    raise exception 'An active verified account is required.' using errcode='42501'; end if;
  return actor;
end;
$$;
create function app_private.lock_result_profiles(p_teacher_profile uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.profiles p where p.id in(auth.uid(),p_teacher_profile) order by p.id for share;
  if not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active) then
    raise exception 'An active account is required.' using errcode='42501'; end if;
end;
$$;

create view app_private.assessment_result_metadata with(security_invoker=true) as
select a.id as assessment_id,a.school_id,school.name as school_name,a.academic_year_id,y.name as academic_year_name,
  a.class_id,c.name as class_name,a.section_id,sec.name as section_name,a.subject_id,sub.name as subject_name,
  a.teacher_id,coalesce(nullif(btrim(t.full_name),''),t.employee_id) as teacher_name,
  a.name,a.assessment_date,a.maximum_marks,a.updated_at as assessment_updated_at,a.status,t.profile_id as teacher_profile
from public.teacher_assessments a join public.schools school on school.id=a.school_id
join public.academic_years y on y.id=a.academic_year_id and y.school_id=a.school_id
join public.classes c on c.id=a.class_id and c.school_id=a.school_id
join public.subjects sub on sub.id=a.subject_id and sub.school_id=a.school_id
join public.teachers t on t.id=a.teacher_id and t.school_id=a.school_id
left join public.sections sec on sec.id=a.section_id and sec.class_id=a.class_id and sec.school_id=a.school_id
where a.section_id is null or sec.id is not null;
revoke all on app_private.assessment_result_metadata from public,anon,authenticated,service_role;

create function app_private.result_source_eligible(p_assessment_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teacher_assessments a
    join public.teachers t on t.id=a.teacher_id and t.school_id=a.school_id
    join public.profiles p on p.id=t.profile_id and p.school_id=a.school_id and p.is_active
    join public.user_roles ur on ur.user_id=p.id and ur.school_id=a.school_id and ur.role='teacher'
    join public.academic_years y on y.id=a.academic_year_id and y.school_id=a.school_id and y.is_current
    join public.classes c on c.id=a.class_id and c.school_id=a.school_id and c.is_active
    join public.subjects sub on sub.id=a.subject_id and sub.school_id=a.school_id and sub.is_active
    where a.id=p_assessment_id and isfinite(y.start_date) and isfinite(y.end_date)
      and a.assessment_date between y.start_date and y.end_date
      and(a.section_id is null or exists(select 1 from public.sections sec where sec.id=a.section_id and sec.class_id=a.class_id and sec.school_id=a.school_id))
      and exists(select 1 from public.teacher_subject_assignments ta where ta.teacher_id=t.id and ta.academic_year_id=y.id
        and ta.class_id=c.id and ta.subject_id=sub.id and(ta.section_id is null or ta.section_id=a.section_id)));
$$;
create function app_private.result_teacher_access(p_assessment_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select app_private.result_source_eligible(p_assessment_id) and exists(select 1 from public.teacher_assessments a
    join public.teachers t on t.id=a.teacher_id and t.school_id=a.school_id where a.id=p_assessment_id and t.profile_id=auth.uid());
$$;

-- One SQL snapshot captures the complete roster and source evidence. Missing
-- marks stay NULL, never zero, and out-of-scope stored marks block submission.
create function app_private.assessment_result_source(p_assessment_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
with metadata as(select * from app_private.assessment_result_metadata where assessment_id=p_assessment_id),
raw_roster as(
  select e.id as enrollment_id,e.student_id,e.section_id,e.roll_no,sec.name as section_name,
    s.admission_no,concat_ws(' ',s.first_name,nullif(s.middle_name,''),nullif(s.last_name,'')) as student_name,
    coalesce(s.school_id=m.school_id and s.status='active' and(e.section_id is null or sec.id is not null),false) as coherent
  from metadata m join public.enrollments e on e.academic_year_id=m.academic_year_id and e.class_id=m.class_id
    and e.status='active' and(m.section_id is null or e.section_id=m.section_id)
  left join public.students s on s.id=e.student_id and s.school_id=m.school_id
  left join public.sections sec on sec.id=e.section_id and sec.class_id=e.class_id and sec.school_id=m.school_id
),roster as(
  select r.*,mark.id as mark_id,mark.marks_obtained,mark.remarks,mark.updated_at as mark_updated_at,mark.updated_by as mark_updated_by
  from raw_roster r left join public.teacher_assessment_marks mark on mark.assessment_id=p_assessment_id and mark.student_id=r.student_id where r.coherent
),outside_marks as(
  select mark.* from public.teacher_assessment_marks mark where mark.assessment_id=p_assessment_id
    and not exists(select 1 from roster r where r.student_id=mark.student_id)
),issues as(
  select array_remove(array[
    case when m.status<>'completed' then 'Complete the assessment before submitting results.' end,
    case when not app_private.result_source_eligible(p_assessment_id) then 'The current assignment or school placement is unavailable.' end,
    case when m.maximum_marks::text in('NaN','Infinity','-Infinity') or m.maximum_marks<=0 or m.maximum_marks<>round(m.maximum_marks,2)
      then 'The assessment maximum must be finite, positive and have at most two decimal places.' end,
    case when not exists(select 1 from roster) then 'No active coherent pupils are available for this assessment.' end,
    case when exists(select 1 from raw_roster where not coherent) then 'Some enrollment records are inconsistent. Contact the school office.' end,
    case when exists(select 1 from roster where mark_id is null) then 'Save a score for every active pupil. Missing scores are not zero.' end,
    case when exists(select 1 from roster where marks_obtained::text in('NaN','Infinity','-Infinity') or marks_obtained<0
      or marks_obtained>m.maximum_marks or marks_obtained<>round(marks_obtained,2) or not isfinite(mark_updated_at))
      then 'Some saved marks or versions are invalid. Review them before submitting.' end,
    case when exists(select 1 from outside_marks) then 'Saved marks exist outside the current class roster. Resolve placement before submitting.' end,
    case when not isfinite(m.assessment_updated_at) then 'The assessment version is invalid.' end
  ],null) as messages from metadata m
)
select jsonb_build_object('metadata',to_jsonb(m)-'teacher_profile',
  'pupils',coalesce((select jsonb_agg(jsonb_build_object('student_id',r.student_id,'student_name',r.student_name,'admission_no',r.admission_no,
    'roll_no',r.roll_no,'section_id',r.section_id,'section_name',r.section_name,'enrollment_id',r.enrollment_id,
    'mark_id',r.mark_id,'marks_obtained',r.marks_obtained,'remarks',r.remarks,'mark_updated_at',r.mark_updated_at,'mark_updated_by',r.mark_updated_by)
    order by r.student_id,r.enrollment_id) from roster r),'[]'::jsonb),
  '_outside_marks',coalesce((select jsonb_agg(to_jsonb(o) order by o.student_id,o.id) from outside_marks o),'[]'::jsonb),
  '_inconsistent_enrollments',(select count(*) from raw_roster where not coherent),
  'can_submit',cardinality(i.messages)=0,'issues',to_jsonb(i.messages))
from metadata m cross join issues i;
$$;
create function app_private.assessment_result_token(p_payload jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select encode(extensions.digest(p_payload::text,'sha256'),'hex');
$$;

create function app_private.list_assessment_publication_candidates()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform app_private.result_actor();
  return coalesce((select jsonb_agg(to_jsonb(m)-'teacher_profile' order by m.assessment_date desc,m.assessment_id)
    from app_private.assessment_result_metadata m where app_private.result_teacher_access(m.assessment_id)),'[]'::jsonb);
end;
$$;
create function app_private.preview_assessment_publication(p_assessment_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source jsonb;
begin
  perform app_private.result_actor();
  if not app_private.result_teacher_access(p_assessment_id) then raise exception 'You cannot preview this assessment.' using errcode='42501'; end if;
  perform 1 from public.teacher_assessments where id=p_assessment_id for update;
  if not app_private.result_teacher_access(p_assessment_id) then raise exception 'Assessment access changed.' using errcode='42501'; end if;
  source:=app_private.assessment_result_source(p_assessment_id);
  return(source-array['_outside_marks','_inconsistent_enrollments'])||jsonb_build_object('source_token',app_private.assessment_result_token(source));
end;
$$;

create function app_private.request_assessment_publication(p_assessment_id uuid,p_expected_source_token text,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=app_private.result_actor();intent app_private.assessment_result_intents%rowtype;
  source jsonb;submission_id uuid;school_id uuid;teacher_id uuid;
begin
  perform app_private.lock_result_profiles();
  if p_request_id is null or p_expected_source_token is null or p_expected_source_token!~'^[a-f0-9]{64}$' then
    raise exception 'A reviewed source token and request reference are required.' using errcode='22023'; end if;
  if not app_private.result_teacher_access(p_assessment_id) then raise exception 'You cannot submit this assessment.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur join public.teacher_assessments a on a.id=p_assessment_id
    where ur.user_id=actor and ur.school_id=a.school_id and ur.role='teacher' for share of ur;
  if not found then raise exception 'The Teacher role is unavailable.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('assessment-result-intent:'||actor::text||':'||p_request_id::text,0));
  select * into intent from app_private.assessment_result_intents i where i.actor_id=actor and i.request_id=p_request_id;
  if found then
    if(intent.assessment_id,intent.source_token) is distinct from(p_assessment_id,p_expected_source_token) then
      raise exception 'This request reference already contains a different result submission.' using errcode='PT409'; end if;
    return intent.submission_id;
  end if;
  perform 1 from public.teacher_assessments a where a.id=p_assessment_id for update;
  if not found or not app_private.result_teacher_access(p_assessment_id) then raise exception 'Assessment access changed.' using errcode='42501'; end if;
  source:=app_private.assessment_result_source(p_assessment_id);
  if source is null or not coalesce((source->>'can_submit')::boolean,false)
    or app_private.assessment_result_token(source)<>p_expected_source_token then
    raise exception 'The result source changed or is incomplete. Refresh and review the preview.' using errcode='PT409'; end if;
  if exists(select 1 from app_private.assessment_result_submissions s where s.assessment_id=p_assessment_id and s.status='pending') then
    raise exception 'A submission is already pending. Cancel or review it before resubmitting.' using errcode='PT409'; end if;
  school_id:=(source#>>'{metadata,school_id}')::uuid;teacher_id:=(source#>>'{metadata,teacher_id}')::uuid;
  insert into app_private.assessment_result_submissions(assessment_id,school_id,teacher_id,requested_by,requester_name,source_token,payload)
    values(p_assessment_id,school_id,teacher_id,actor,(select coalesce(nullif(btrim(p.full_name),''),'Teacher') from public.profiles p where p.id=actor),
      p_expected_source_token,source) returning id into submission_id;
  insert into app_private.assessment_result_intents(actor_id,request_id,assessment_id,source_token,submission_id)
    values(actor,p_request_id,p_assessment_id,p_expected_source_token,submission_id);
  return submission_id;
end;
$$;

create function app_private.review_assessment_publication(p_submission_id uuid,p_decision text,p_reason text)
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
    where p->>'mark_updated_by'=actor::text) then
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

create function app_private.cancel_assessment_result_submission(p_submission_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=app_private.result_actor();submission app_private.assessment_result_submissions%rowtype;
  reason_text text:=regexp_replace(p_reason,'^[[:space:]]+|[[:space:]]+$','','g');
begin
  perform app_private.lock_result_profiles();
  select * into submission from app_private.assessment_result_submissions s where s.id=p_submission_id;
  if not found or submission.requested_by<>actor then raise exception 'You cannot cancel this submission.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor and ur.school_id=submission.school_id and ur.role='teacher' for share;
  if not found then raise exception 'An active Teacher role is required.' using errcode='42501'; end if;
  if reason_text is null or char_length(reason_text) not between 3 and 1000 then
    raise exception 'Enter a cancellation reason between 3 and 1000 characters.' using errcode='22023'; end if;
  select * into submission from app_private.assessment_result_submissions s where s.id=p_submission_id for update;
  if submission.status<>'pending' then
    if(submission.status,submission.reviewed_by,submission.review_note)=('cancelled',actor,reason_text) then return submission.id; end if;
    raise exception 'This submission already has a final decision.' using errcode='PT409'; end if;
  update app_private.assessment_result_submissions set status='cancelled',reviewed_by=actor,reviewer_name=submission.requester_name,
    review_note=reason_text,reviewed_at=clock_timestamp() where id=submission.id;
  return submission.id;
end;
$$;

create function app_private.list_assessment_result_submissions(p_school_id uuid default null,p_status text default null,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=app_private.result_actor();result jsonb;
begin
  if p_school_id is not null and not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot view submissions for this school.' using errcode='42501'; end if;
  if p_school_id is null and not exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.role='teacher'
    and ur.school_id=(select p.school_id from public.profiles p where p.id=actor)) then
    raise exception 'An active Teacher role or office school is required.' using errcode='42501'; end if;
  if p_offset is null or p_offset<0 or(p_status is not null and p_status not in('pending','published','rejected','cancelled')) then
    raise exception 'Invalid page or publication status.' using errcode='22023'; end if;
  with permitted as(select s.* from app_private.assessment_result_submissions s where(p_status is null or s.status=p_status)
    and((p_school_id is not null and s.school_id=p_school_id) or(p_school_id is null and s.requested_by=actor and app_private.result_teacher_access(s.assessment_id)))),
  page as(select * from permitted order by requested_at desc,id desc limit 50 offset p_offset)
  select jsonb_build_object('offset',p_offset,'total_count',(select count(*) from permitted),
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'assessment_id',p.assessment_id,'school_id',p.school_id,'status',p.status,
      'requested_at',p.requested_at,'requester_name',p.requester_name,'reviewed_at',p.reviewed_at,'revision',p.revision,
      'metadata',p.payload->'metadata') order by p.requested_at desc,p.id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$$;
create function app_private.get_assessment_result_submission(p_submission_id uuid)
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
    'revision',submission.revision,'snapshot',jsonb_build_object('metadata',submission.payload->'metadata','pupils',submission.payload->'pupils'),'source_matches',matches);
end;
$$;

create function app_private.get_family_assessment_results(p_student_id uuid,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=app_private.result_actor();student_school_id uuid;result jsonb;
begin
  select s.school_id into student_school_id from public.students s join public.profiles profile on profile.id=actor and profile.school_id=s.school_id
    where s.id=p_student_id and((s.profile_id=actor and exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.school_id=s.school_id and ur.role='student'))
      or(exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.school_id=s.school_id and ur.role='parent')
        and exists(select 1 from public.parents parent join public.student_parents link on link.parent_id=parent.id
          where parent.profile_id=actor and parent.school_id=s.school_id and link.student_id=s.id)));
  if not found then raise exception 'You cannot view results for this student.' using errcode='42501'; end if;
  if p_offset is null or p_offset<0 then raise exception 'Invalid result page.' using errcode='22023'; end if;
  with latest as(
    select distinct on(s.assessment_id) s.*,pupil.value as pupil
    from app_private.assessment_result_submissions s cross join lateral jsonb_array_elements(s.payload->'pupils') pupil
    where s.school_id=student_school_id and s.status='published' and pupil.value->>'student_id'=p_student_id::text
    order by s.assessment_id,s.revision desc,s.id desc
  ),page as(select * from latest order by reviewed_at desc,id desc limit 50 offset p_offset)
  select jsonb_build_object('student_id',p_student_id,'school_id',student_school_id,'offset',p_offset,'total_count',(select count(*) from latest),
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'assessment_id',p.assessment_id,'revision',p.revision,
      'published_at',p.reviewed_at,'publisher_name',p.reviewer_name,'metadata',p.payload->'metadata','student_id',p_student_id,
      'student_name',p.pupil->>'student_name','admission_no',p.pupil->>'admission_no','roll_no',p.pupil->>'roll_no',
      'marks_obtained',(p.pupil->>'marks_obtained')::numeric,'maximum_marks',(p.payload#>>'{metadata,maximum_marks}')::numeric,
      'percentage',round((p.pupil->>'marks_obtained')::numeric*100/(p.payload#>>'{metadata,maximum_marks}')::numeric,2),
      'remarks',p.pupil->>'remarks') order by p.reviewed_at desc,p.id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$$;

create function public.list_assessment_publication_candidates() returns jsonb language sql security invoker set search_path=''
as $$ select app_private.list_assessment_publication_candidates(); $$;
create function public.preview_assessment_publication(p_assessment_id uuid) returns jsonb language sql security invoker set search_path=''
as $$ select app_private.preview_assessment_publication(p_assessment_id); $$;
create function public.request_assessment_publication(p_assessment_id uuid,p_expected_source_token text,p_request_id uuid)
returns uuid language sql security invoker set search_path='' as $$ select app_private.request_assessment_publication(p_assessment_id,p_expected_source_token,p_request_id); $$;
create function public.review_assessment_publication(p_submission_id uuid,p_decision text,p_reason text)
returns uuid language sql security invoker set search_path='' as $$ select app_private.review_assessment_publication(p_submission_id,p_decision,p_reason); $$;
create function public.cancel_assessment_result_submission(p_submission_id uuid,p_reason text)
returns uuid language sql security invoker set search_path='' as $$ select app_private.cancel_assessment_result_submission(p_submission_id,p_reason); $$;
create function public.list_assessment_result_submissions(p_school_id uuid default null,p_status text default null,p_offset integer default 0)
returns jsonb language sql security invoker set search_path='' as $$ select app_private.list_assessment_result_submissions(p_school_id,p_status,p_offset); $$;
create function public.get_assessment_result_submission(p_submission_id uuid) returns jsonb language sql security invoker set search_path=''
as $$ select app_private.get_assessment_result_submission(p_submission_id); $$;
create function public.get_family_assessment_results(p_student_id uuid,p_offset integer default 0) returns jsonb language sql security invoker set search_path=''
as $$ select app_private.get_family_assessment_results(p_student_id,p_offset); $$;

revoke all on function app_private.lock_result_source_mark(),app_private.guard_assessment_result_submission(),app_private.result_actor(),
  app_private.lock_result_profiles(uuid),app_private.result_source_eligible(uuid),app_private.result_teacher_access(uuid),
  app_private.assessment_result_source(uuid),app_private.assessment_result_token(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.list_assessment_publication_candidates(),app_private.list_assessment_publication_candidates(),
  public.preview_assessment_publication(uuid),app_private.preview_assessment_publication(uuid),
  public.request_assessment_publication(uuid,text,uuid),app_private.request_assessment_publication(uuid,text,uuid),
  public.review_assessment_publication(uuid,text,text),app_private.review_assessment_publication(uuid,text,text),
  public.cancel_assessment_result_submission(uuid,text),app_private.cancel_assessment_result_submission(uuid,text),
  public.list_assessment_result_submissions(uuid,text,integer),app_private.list_assessment_result_submissions(uuid,text,integer),
  public.get_assessment_result_submission(uuid),app_private.get_assessment_result_submission(uuid),
  public.get_family_assessment_results(uuid,integer),app_private.get_family_assessment_results(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.list_assessment_publication_candidates(),app_private.list_assessment_publication_candidates(),
  public.preview_assessment_publication(uuid),app_private.preview_assessment_publication(uuid),
  public.request_assessment_publication(uuid,text,uuid),app_private.request_assessment_publication(uuid,text,uuid),
  public.review_assessment_publication(uuid,text,text),app_private.review_assessment_publication(uuid,text,text),
  public.cancel_assessment_result_submission(uuid,text),app_private.cancel_assessment_result_submission(uuid,text),
  public.list_assessment_result_submissions(uuid,text,integer),app_private.list_assessment_result_submissions(uuid,text,integer),
  public.get_assessment_result_submission(uuid),app_private.get_assessment_result_submission(uuid),
  public.get_family_assessment_results(uuid,integer),app_private.get_family_assessment_results(uuid,integer)
  to authenticated;
commit;
