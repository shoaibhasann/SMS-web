-- Run as one trusted SQL request. Only synthetic data is created, and every write rolls back.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '25s';

create function pg_temp.notice_push_qa_actor(actor_id uuid, session_id uuid, level text, path text)
returns void language plpgsql as $actor$
begin
  perform set_config('role','authenticated',true);
  perform set_config('request.path',path,true);
  perform set_config('request.jwt.claim.sub',actor_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_id,'session_id',session_id,'aal',level,'role','authenticated')::text,true);
  perform public.check_staff_mfa_request();
end;
$actor$;

do $qa$
declare
  school constant uuid := '8389c2df-6df2-4e5b-94f2-951f4c6d6aa6';
  admin_user constant uuid := 'c03537de-21db-46ff-a7ac-c94f36e090d6';
  school_year constant uuid := 'a6cc16b3-fc1d-45d4-873f-c78a176b0b3f';
  course constant uuid := 'b3519599-fa1d-4a27-bb94-37637c7225cc';
  admin_factor uuid;
  admin_session uuid := gen_random_uuid();
  guardian_user uuid := gen_random_uuid();
  guardian_session uuid := gen_random_uuid();
  student_user uuid := gen_random_uuid();
  student_session uuid := gen_random_uuid();
  optout_user uuid := gen_random_uuid();
  optout_session uuid := gen_random_uuid();
  guardian_record uuid := gen_random_uuid();
  pupil uuid := gen_random_uuid();
  sibling uuid := gen_random_uuid();
  section uuid := gen_random_uuid();
  peer_section uuid := gen_random_uuid();
  draft uuid := gen_random_uuid();
  schedule uuid := gen_random_uuid();
  other_notice uuid := gen_random_uuid();
  parents_only uuid := gen_random_uuid();
  immediate_publish_time timestamptz := statement_timestamp() - interval '1 minute';
  scheduled_at timestamptz := statement_timestamp() + interval '1 hour';
  notice_expiry timestamptz := statement_timestamp() + interval '3 hours';
  audience jsonb := jsonb_build_object('roles',jsonb_build_array('parent','student'),'class_id',course,'section_id',section);
  actor record;
  guardian_job uuid;
  student_job uuid;
  guardian_schedule_job uuid;
  lease uuid := gen_random_uuid();
  prepared jsonb;
begin
  select factor.id into admin_factor from auth.mfa_factors factor
  join public.user_roles membership on membership.user_id=factor.user_id
    and membership.school_id=school and membership.role='school_admin'
  join public.profiles profile on profile.id=factor.user_id and profile.school_id=school and profile.is_active
  where factor.user_id=admin_user and factor.factor_type='totp' and factor.status='verified' order by factor.id limit 1;
  if admin_factor is null
    or not exists(select 1 from public.schools s where s.id=school and s.code='SMS-MFA-cac57e88' and s.is_active)
    or not exists(select 1 from public.academic_years y where y.id=school_year and y.school_id=school and y.is_current)
    or not exists(select 1 from public.classes c where c.id=course and c.school_id=school and c.is_active)
  then raise exception 'Announcement push QA requires the designated synthetic school and verified Admin.'; end if;

  begin
    insert into public.sections(id,school_id,class_id,name) values
      (section,school,course,'QA push '||left(section::text,8)),
      (peer_section,school,course,'QA push '||left(peer_section::text,8));
    insert into auth.sessions(id,user_id,aal,factor_id,not_after)
      values(admin_session,admin_user,'aal2',admin_factor,statement_timestamp()+interval '3 minutes');
    for actor in select * from (values
      (guardian_user,guardian_session,'parent'::public.app_role,true),
      (student_user,student_session,'student'::public.app_role,true),
      (optout_user,optout_session,'student'::public.app_role,false)) a(uid,session_id,role,enabled)
    loop
      insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
        values(actor.uid,actor.uid::text||'@announcement-push-qa.invalid',statement_timestamp(),'{"full_name":"Synthetic announcement push QA"}');
      update public.profiles set school_id=school where id=actor.uid;
      insert into public.user_roles(user_id,school_id,role) values(actor.uid,school,actor.role);
      insert into auth.sessions(id,user_id,aal,not_after)
        values(actor.session_id,actor.uid,'aal1',statement_timestamp()+interval '3 minutes');
    end loop;
    insert into public.students(id,school_id,profile_id,admission_no,first_name) values
      (pupil,school,student_user,'QA-PUSH-'||pupil::text,'Synthetic Student'),
      (sibling,school,optout_user,'QA-PUSH-'||sibling::text,'Synthetic Sibling');
    insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values
      (pupil,school_year,course,section),(sibling,school_year,course,section);
    insert into public.parents(id,school_id,profile_id) values(guardian_record,school,guardian_user);
    insert into public.student_parents(student_id,parent_id,relationship) values
      (pupil,guardian_record,'guardian'),(sibling,guardian_record,'guardian');

    for actor in select * from (values
      (guardian_user,guardian_session,'parent',true),
      (student_user,student_session,'student',true),
      (optout_user,optout_session,'student',false)) a(uid,session_id,role,enabled)
    loop
      perform pg_temp.notice_push_qa_actor(actor.uid,actor.session_id,'aal1','/rpc/register_my_family_push_device');
      perform public.register_my_family_push_device(actor.role,gen_random_uuid(),repeat('a',64),
        'c'||substr(replace(gen_random_uuid()::text,'-',''),1,21),'android','Rollback announcement push QA');
      perform public.set_my_family_push_preferences(actor.role,actor.enabled,false,false,false,0);
    end loop;

    perform pg_temp.notice_push_qa_actor(admin_user,admin_session,'aal2','/notices');
    insert into public.notices(id,school_id,title,content,audience,published_at,expires_at,created_by) values
      (draft,school,'Private QA announcement','Synthetic exact detail.',audience,null,null,admin_user),
      (schedule,school,'Scheduled QA announcement','Synthetic scheduled detail.',audience,scheduled_at,notice_expiry,admin_user),
      (other_notice,school,'Other section QA announcement','Synthetic excluded detail.',
        jsonb_set(audience,'{section_id}',to_jsonb(peer_section)),immediate_publish_time,null,admin_user),
      (parents_only,school,'Parent only QA announcement','Synthetic parent detail.',
        jsonb_set(audience,'{roles}','["parent"]'),immediate_publish_time,null,admin_user);
    perform set_config('role','none',true);
    if exists(select 1 from app_private.family_push_jobs job where job.event_id in (draft,other_notice))
      or (select count(*) from app_private.family_push_jobs job where job.event_id=parents_only and job.kind='announcement') <> 1
      or not exists(select 1 from app_private.family_push_jobs job where job.event_id=parents_only and job.user_id=guardian_user)
    then raise exception 'Draft, section or role audience did not match expected queue scope.'; end if;
    select job.id into strict guardian_schedule_job from app_private.family_push_jobs job
      where job.event_id=schedule and job.user_id=guardian_user and job.kind='announcement'
        and job.next_attempt_at=scheduled_at and job.expires_at=notice_expiry;
    if (select count(*) from app_private.family_push_jobs job where job.event_id=schedule) <> 2
    then raise exception 'Scheduled notice did not queue exactly once per opted-in device.'; end if;

    perform pg_temp.notice_push_qa_actor(admin_user,admin_session,'aal2','/notices');
    update public.notices set published_at=published_at+interval '1 hour' where id=schedule;
    update public.notices set published_at=statement_timestamp()-interval '1 minute' where id=draft;
    perform set_config('role','none',true);
    if not exists(select 1 from app_private.family_push_jobs job
      where job.id=guardian_schedule_job and job.next_attempt_at=scheduled_at+interval '1 hour' and job.expires_at=notice_expiry)
      or (select count(*) from app_private.family_push_jobs job where job.event_id=draft) <> 2
    then raise exception 'Reschedule replaced an existing job or first publish did not deduplicate siblings.'; end if;

    perform pg_temp.notice_push_qa_actor(admin_user,admin_session,'aal2','/notices');
    update public.notices set expires_at=notice_expiry+interval '1 hour' where id=schedule;
    perform set_config('role','none',true);
    if not exists(select 1 from app_private.family_push_jobs job where job.id=guardian_schedule_job
      and job.next_attempt_at=scheduled_at+interval '1 hour' and job.expires_at=notice_expiry+interval '1 hour')
    then raise exception 'Extending scheduled expiry failed to update the same job.'; end if;

    perform pg_temp.notice_push_qa_actor(optout_user,optout_session,'aal1','/rpc/get_family_announcement');
    if public.get_family_announcement('student',draft)->>'content' is distinct from 'Synthetic exact detail.'
      or public.get_family_announcement('student',parents_only) is not null
      or public.get_family_announcement('student',other_notice) is not null
      or public.get_family_announcement('student',schedule) is not null
    then raise exception 'Exact announcement read diverged from the live audience or publication window.'; end if;
    perform public.set_my_family_push_preferences('student',true,false,false,false,1);

    perform set_config('role','none',true);
    select job.id into strict guardian_job from app_private.family_push_jobs job
      where job.event_id=draft and job.kind='announcement' and job.user_id=guardian_user;
    select job.id into strict student_job from app_private.family_push_jobs job
      where job.event_id=draft and job.kind='announcement' and job.user_id=student_user;
    -- Only these synthetic jobs get leased. Hosted QA must not claim the shared queue.
    update app_private.family_push_jobs set status='leased',lease_id=lease,lease_until=statement_timestamp()+interval '1 minute'
      where id in (guardian_job,student_job);
    delete from public.student_parents where parent_id=guardian_record and student_id=pupil;
    perform set_config('role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    prepared := public.prepare_family_push_job(guardian_job,lease);
    if prepared->>'event_id' is distinct from draft::text or prepared->>'kind' is distinct from 'announcement'
      or prepared->>'recipient_role' is distinct from 'parent' or prepared ?| array['title','content','pupil_id']
    then raise exception 'The remaining sibling did not authorize a private announcement prepare.'; end if;

    perform set_config('role','none',true);
    delete from public.student_parents where parent_id=guardian_record and student_id=sibling;
    perform set_config('role','service_role',true);
    if public.finish_family_push_job(guardian_job,lease,'retry','QA_NO_SEND')
    then raise exception 'Losing the final link left a Guardian job retryable.'; end if;

    perform pg_temp.notice_push_qa_actor(admin_user,admin_session,'aal2','/notices');
    update public.notices set published_at=null where id=draft;
    perform set_config('role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    if public.prepare_family_push_job(student_job,lease) is not null
    then raise exception 'Moving a notice to draft left a Student job dispatchable.'; end if;

    perform pg_temp.notice_push_qa_actor(admin_user,admin_session,'aal2','/notices');
    update public.notices set published_at=statement_timestamp() where id=draft;
    update public.notices set content='Edited after first publication.' where id=draft;
    perform set_config('role','none',true);
    if (select count(*) from app_private.family_push_jobs job where job.event_id=draft) <> 2
      or exists(select 1 from app_private.family_push_jobs job where job.event_id in (draft,schedule,other_notice,parents_only) and job.user_id=optout_user)
    then raise exception 'Republish, edit or later opt-in created an unexpected job.'; end if;
    -- Catch only this sentinel. The protected block discards every write.
    raise exception using errcode='P7712', message='Announcement push QA passed, discard fixtures';
  exception when sqlstate 'P7712' then
    null;
  end;

  if exists(select 1 from auth.users where id in (guardian_user,student_user,optout_user))
    or exists(select 1 from auth.sessions where id in (admin_session,guardian_session,student_session,optout_session))
    or exists(select 1 from public.sections where id in (section,peer_section))
    or exists(select 1 from public.notices where id in (draft,schedule,other_notice,parents_only))
    or exists(select 1 from app_private.family_notice_publications where notice_id in (draft,schedule,other_notice,parents_only))
    or exists(select 1 from app_private.family_push_jobs job where job.event_id in (draft,schedule,other_notice,parents_only))
  then raise exception 'Announcement push QA rollback left synthetic records.'; end if;
end;
$qa$;

rollback;
select true as audience_and_opt_in, true as scheduling_and_sibling_dedup,
  true as exact_detail_and_revocation, true as unpublish_and_no_resend, true as fixture_writes_rolled_back;
