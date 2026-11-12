-- Run on one trusted SQL connection. The synthetic accounts, links and jobs all roll back.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '25s';

create temp table homework_push_qa(facts jsonb not null) on commit drop;

create function pg_temp.homework_push_actor(actor_id uuid, session_id uuid, level text, path text)
returns void language plpgsql as $actor$
begin
  perform set_config('role','authenticated',true);
  perform set_config('request.path',path,true);
  perform set_config('request.jwt.claim.sub',actor_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_id,'session_id',session_id,'aal',level,'role','authenticated')::text,true);
  perform public.check_staff_mfa_request();
end;
$actor$;

do $preflight$
declare
  school constant uuid := '8389c2df-6df2-4e5b-94f2-951f4c6d6aa6';
  teacher constant uuid := '9df6241b-6878-4a3b-b172-9fd808c8bf72';
  teacher_user constant uuid := '4b9b5853-1259-4c71-8e0f-45537f73b5bf';
  school_year constant uuid := 'a6cc16b3-fc1d-45d4-873f-c78a176b0b3f';
  course constant uuid := 'b3519599-fa1d-4a27-bb94-37637c7225cc';
  subject constant uuid := '31a92b40-3741-4647-8277-35f63977eafa';
  teacher_factor uuid;
  log_date date;
begin
  select f.id into teacher_factor from auth.mfa_factors f
    join public.user_roles r on r.user_id=f.user_id and r.school_id=school and r.role='teacher'
    join public.teachers t on t.id=teacher and t.school_id=school and t.profile_id=r.user_id
    where f.user_id=teacher_user and f.factor_type='totp' and f.status='verified' order by f.id limit 1;
  select greatest(y.start_date,least((statement_timestamp() at time zone 'Asia/Kolkata')::date,y.end_date))
    into log_date from public.academic_years y where y.id=school_year and y.school_id=school and y.is_current;
  if teacher_factor is null or log_date is null
    or not exists (select 1 from public.schools s where s.id=school and s.code='SMS-MFA-cac57e88' and s.is_active)
    or not exists (select 1 from public.classes c where c.id=course and c.school_id=school and c.is_active)
    or not exists (select 1 from public.subjects s where s.id=subject and s.school_id=school and s.is_active)
  then raise exception 'Homework push QA needs the designated synthetic school and its verified teacher.'; end if;
  insert into pg_temp.homework_push_qa values (jsonb_build_object(
    'school',school,'teacher',teacher,'teacher_user',teacher_user,'teacher_factor',teacher_factor,
    'year',school_year,'class',course,'subject',subject,'log_date',log_date,
    'teacher_session',gen_random_uuid(),'section',gen_random_uuid(),'peer_section',gen_random_uuid(),
    'parent',gen_random_uuid(),'guardian',gen_random_uuid(),'guardian_session',gen_random_uuid(),
    'student',gen_random_uuid(),'student_session',gen_random_uuid(),'optout',gen_random_uuid(),'optout_session',gen_random_uuid(),
    'pupil',gen_random_uuid(),'sibling',gen_random_uuid()));
end;
$preflight$;

savepoint homework_push_fixtures;

do $draft$
declare
  ctx jsonb := (select facts from pg_temp.homework_push_qa);
  school uuid := (ctx->>'school')::uuid;
  section uuid := (ctx->>'section')::uuid;
  peer_section uuid := (ctx->>'peer_section')::uuid;
  guardian_record uuid := (ctx->>'parent')::uuid;
  pupil uuid := (ctx->>'pupil')::uuid;
  sibling uuid := (ctx->>'sibling')::uuid;
  actor record;
  fid text;
  device uuid;
  devices jsonb := '{}'::jsonb;
  log_data jsonb;
  activities jsonb := '[{"title":"Synthetic homework push QA","activity_type":"homework","description":"Read the example."},{"title":"Synthetic classwork QA","activity_type":"classwork"}]';
  lesson uuid;
  peer_lesson uuid;
  work uuid;
  classwork uuid;
  peer_work uuid;
begin
  insert into public.sections(id,school_id,class_id,name) values
    (section,school,(ctx->>'class')::uuid,'QA HW '||left(section::text,8)),
    (peer_section,school,(ctx->>'class')::uuid,'QA HW '||left(peer_section::text,8));
  insert into public.teacher_subject_assignments(teacher_id,academic_year_id,class_id,section_id,subject_id)
    select (ctx->>'teacher')::uuid,(ctx->>'year')::uuid,(ctx->>'class')::uuid,s.id,(ctx->>'subject')::uuid
    from public.sections s where s.id in (section,peer_section);
  insert into auth.sessions(id,user_id,aal,factor_id,not_after)
    values ((ctx->>'teacher_session')::uuid,(ctx->>'teacher_user')::uuid,'aal2',(ctx->>'teacher_factor')::uuid,statement_timestamp()+interval '3 minutes');

  for actor in select (ctx->>label)::uuid as uid,(ctx->>(label||'_session'))::uuid as session_id,label,role
    from (values ('guardian','parent'::public.app_role),('student','student'::public.app_role),('optout','student'::public.app_role)) as a(label,role)
  loop
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
      values(actor.uid,actor.uid::text||'@homework-push-qa.invalid',statement_timestamp(),'{"full_name":"Synthetic homework push QA"}');
    update public.profiles set school_id=school where id=actor.uid;
    insert into public.user_roles(user_id,school_id,role) values(actor.uid,school,actor.role);
    insert into auth.sessions(id,user_id,aal,not_after) values(actor.session_id,actor.uid,'aal1',statement_timestamp()+interval '3 minutes');
  end loop;

  insert into public.students(id,school_id,profile_id,admission_no,first_name) values
    (pupil,school,(ctx->>'student')::uuid,'QA-HW-'||pupil::text,'Synthetic Student'),
    (sibling,school,(ctx->>'optout')::uuid,'QA-HW-'||sibling::text,'Synthetic Sibling');
  insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values
    (pupil,(ctx->>'year')::uuid,(ctx->>'class')::uuid,section),
    (sibling,(ctx->>'year')::uuid,(ctx->>'class')::uuid,section);
  insert into public.parents(id,school_id,profile_id) values(guardian_record,school,(ctx->>'guardian')::uuid);
  insert into public.student_parents(student_id,parent_id,relationship) values
    (pupil,guardian_record,'guardian'),(sibling,guardian_record,'guardian');

  for actor in select (ctx->>label)::uuid as uid,(ctx->>(label||'_session'))::uuid as session_id,label,role
    from (values ('guardian','parent'),('student','student'),('optout','student')) as a(label,role)
  loop
    perform pg_temp.homework_push_actor(actor.uid,actor.session_id,'aal1','/rpc/register_my_family_push_device');
    fid := 'c'||substr(replace(gen_random_uuid()::text,'-',''),1,21);
    device := (public.register_my_family_push_device(actor.role,gen_random_uuid(),repeat('a',64),fid,'android','Rollback homework push QA')->>'device_id')::uuid;
    perform public.set_my_family_push_preferences(actor.role,actor.label<>'optout',false,false,false,0);
    devices := devices||jsonb_build_object(actor.label||'_device',device,actor.label||'_fid',fid);
  end loop;

  log_data := jsonb_build_object('school_id',school,'academic_year_id',ctx->>'year','class_id',ctx->>'class',
    'section_id',section,'subject_id',ctx->>'subject','log_date',ctx->>'log_date','topic','Synthetic homework push QA','status','draft');
  perform pg_temp.homework_push_actor((ctx->>'teacher_user')::uuid,(ctx->>'teacher_session')::uuid,'aal2','/rpc/save_academic_log');
  lesson := public.save_academic_log(log_data,activities);
  peer_lesson := public.save_academic_log(log_data||jsonb_build_object('section_id',peer_section,'status','published'),jsonb_build_array(activities->0));

  perform set_config('role','none',true);
  select id into strict work from public.class_activities where class_log_id=lesson and activity_type='homework';
  select id into strict classwork from public.class_activities where class_log_id=lesson and activity_type='classwork';
  select id into strict peer_work from public.class_activities where class_log_id=peer_lesson;
  if exists (select 1 from app_private.family_push_jobs where event_id in (work,classwork,peer_work))
    or exists (select 1 from app_private.family_homework_publications where activity_id=work)
  then raise exception 'Draft, classwork or a different section queued homework delivery.'; end if;

  select jsonb_agg(jsonb_build_object('id',id,'title',title,'activity_type',activity_type,'description',description) order by id)
    into activities from public.class_activities where class_log_id=lesson;
  select log_data||jsonb_build_object('id',id,'expected_updated_at',updated_at,'status','published')
    into log_data from public.class_logs where id=lesson;
  perform pg_temp.homework_push_actor((ctx->>'teacher_user')::uuid,(ctx->>'teacher_session')::uuid,'aal2','/rpc/save_academic_log');
  perform public.save_academic_log(log_data,activities);
  perform set_config('role','none',true);

  if (select count(*) from app_private.family_push_jobs where event_id=work and kind='homework_assigned'
      and status='queued' and school_id=school and expires_at>statement_timestamp()
      and ((user_id=(ctx->>'guardian')::uuid and recipient_role='parent' and device_id=(devices->>'guardian_device')::uuid)
        or (user_id=(ctx->>'student')::uuid and recipient_role='student' and device_id=(devices->>'student_device')::uuid))) <> 2
    or (select count(*) from app_private.family_push_jobs where event_id in (work,classwork,peer_work)) <> 2
  then raise exception 'First publish must queue once per eligible opted-in device, even for two linked siblings.'; end if;

  -- A single hosted SQL request can share one statement timestamp across the script.
  -- Model the later family read only after testing the untouched publish and enqueue timestamps.
  update app_private.family_homework_publications set published_at=statement_timestamp()
    where activity_id in (work,peer_work) and published_at>statement_timestamp();

  update pg_temp.homework_push_qa set facts=facts||devices||jsonb_build_object(
    'lesson',lesson,'peer_lesson',peer_lesson,'work',work,'classwork',classwork,'peer_work',peer_work,
    'log_data',log_data,'activities',activities);
end;
$draft$;

do $dispatch$
declare
  ctx jsonb := (select facts from pg_temp.homework_push_qa);
  lesson uuid := (ctx->>'lesson')::uuid;
  work uuid := (ctx->>'work')::uuid;
  guardian_record uuid := (ctx->>'parent')::uuid;
  guardian_job uuid;
  student_job uuid;
  lease uuid := gen_random_uuid();
  next_lease uuid := gen_random_uuid();
  prepared jsonb;
  log_data jsonb := ctx->'log_data';
  activities jsonb := ctx->'activities';
begin
  perform pg_temp.homework_push_actor((ctx->>'guardian')::uuid,(ctx->>'guardian_session')::uuid,'aal1','/rpc/get_family_homework');
  if public.get_family_homework('parent',work)->>'id' is distinct from work::text
    or public.get_family_homework('parent',(ctx->>'peer_work')::uuid) is not null
  then raise exception 'Guardian could not open the exact linked homework or could access a peer section.'; end if;

  perform pg_temp.homework_push_actor((ctx->>'student')::uuid,(ctx->>'student_session')::uuid,'aal1','/rpc/get_family_homework');
  if public.get_family_homework('student',work)->>'student_id' is distinct from ctx->>'pupil'
    or public.get_family_homework('student',(ctx->>'classwork')::uuid) is not null
  then raise exception 'Student could not open their homework or could access classwork as homework.'; end if;

  perform pg_temp.homework_push_actor((ctx->>'optout')::uuid,(ctx->>'optout_session')::uuid,'aal1','/rpc/set_my_family_push_preferences');
  if public.get_family_homework('student',work)->>'id' is distinct from work::text
  then raise exception 'Push preference must not change inbox or detail access.'; end if;
  perform public.set_my_family_push_preferences('student',true,false,false,false,1);

  perform set_config('role','none',true);
  select id into strict guardian_job from app_private.family_push_jobs where event_id=work and recipient_role='parent';
  select id into strict student_job from app_private.family_push_jobs where event_id=work and recipient_role='student';

  -- Lease only fixture jobs so a shared hosted queue is never consumed by this test.
  update app_private.family_push_jobs set status='leased',lease_id=lease,lease_until=statement_timestamp()+interval '1 minute'
    where id in (guardian_job,student_job);
  delete from public.student_parents where parent_id=guardian_record and student_id=(ctx->>'pupil')::uuid;
  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  prepared := public.prepare_family_push_job(guardian_job,lease);
  if prepared->>'event_id' is distinct from work::text or prepared->>'kind' is distinct from 'homework_assigned'
    or prepared->>'device_fid' is distinct from ctx->>'guardian_fid' or prepared->>'recipient_role' is distinct from 'parent'
    or prepared->>'platform' is distinct from 'android'
    or public.prepare_family_push_job(guardian_job,lease) is not null
    or not public.finish_family_push_job(guardian_job,lease,'retry','QA_NO_SEND')
  then raise exception 'The remaining linked sibling did not preserve exactly-once preparation and guarded retry.'; end if;

  perform set_config('role','none',true);
  update app_private.family_push_jobs set status='leased',lease_id=next_lease,lease_until=statement_timestamp()+interval '1 minute',
    prepared_at=null,last_outcome=null,result_code=null where id=guardian_job and status='queued';
  if not found then raise exception 'The eligible Guardian job did not requeue.'; end if;
  delete from public.student_parents where parent_id=guardian_record and student_id=(ctx->>'sibling')::uuid;
  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if public.prepare_family_push_job(guardian_job,next_lease) is not null
  then raise exception 'The revoked Guardian job was still dispatchable.'; end if;
  prepared := public.prepare_family_push_job(student_job,lease);
  if prepared->>'event_id' is distinct from work::text or prepared->>'recipient_role' is distinct from 'student'
    or prepared->>'device_fid' is distinct from ctx->>'student_fid'
  then raise exception 'Guardian link revocation changed Student eligibility.'; end if;

  perform set_config('role','none',true);
  select log_data||jsonb_build_object('expected_updated_at',updated_at,'status','draft') into log_data from public.class_logs where id=lesson;
  perform pg_temp.homework_push_actor((ctx->>'teacher_user')::uuid,(ctx->>'teacher_session')::uuid,'aal2','/rpc/save_academic_log');
  perform public.save_academic_log(log_data,activities);
  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  -- null confirms the retry and reports it cancelled as no longer eligible.
  if public.finish_family_push_job(student_job,lease,'retry','QA_NO_SEND') is not null
  then raise exception 'A retry on the unpublished homework job was not recorded.'; end if;
  perform set_config('role','none',true);
  if (select status||'/'||result_code from app_private.family_push_jobs where id=student_job) is distinct from 'cancelled/no_longer_eligible'
  then raise exception 'An unpublished homework job could still retry.'; end if;

  perform set_config('role','none',true);
  select log_data||jsonb_build_object('expected_updated_at',updated_at,'status','published') into log_data from public.class_logs where id=lesson;
  perform pg_temp.homework_push_actor((ctx->>'teacher_user')::uuid,(ctx->>'teacher_session')::uuid,'aal2','/rpc/save_academic_log');
  perform public.save_academic_log(log_data,activities);
  perform set_config('role','none',true);
  select log_data||jsonb_build_object('expected_updated_at',updated_at,'topic','QA edited without resending') into log_data from public.class_logs where id=lesson;
  perform pg_temp.homework_push_actor((ctx->>'teacher_user')::uuid,(ctx->>'teacher_session')::uuid,'aal2','/rpc/save_academic_log');
  perform public.save_academic_log(log_data,activities);
  perform set_config('role','none',true);

  if (select count(*) from app_private.family_push_jobs where event_id=work) <> 2
    or (select count(*) from app_private.family_push_jobs where id in (guardian_job,student_job)
      and status='cancelled' and result_code='no_longer_eligible') <> 2
  then raise exception 'Edit, republish or later opt-in unexpectedly generated new delivery.'; end if;
end;
$dispatch$;

rollback to savepoint homework_push_fixtures;

do $cleanup$
declare ctx jsonb := (select facts from pg_temp.homework_push_qa);
begin
  if exists (select 1 from auth.users where id in ((ctx->>'guardian')::uuid,(ctx->>'student')::uuid,(ctx->>'optout')::uuid))
    or exists (select 1 from auth.sessions where id in ((ctx->>'teacher_session')::uuid,(ctx->>'guardian_session')::uuid,
      (ctx->>'student_session')::uuid,(ctx->>'optout_session')::uuid))
    or exists (select 1 from public.sections where id in ((ctx->>'section')::uuid,(ctx->>'peer_section')::uuid))
    or exists (select 1 from public.class_logs where section_id in ((ctx->>'section')::uuid,(ctx->>'peer_section')::uuid))
    or exists (select 1 from app_private.family_push_devices where user_id in ((ctx->>'guardian')::uuid,(ctx->>'student')::uuid,(ctx->>'optout')::uuid))
    or exists (select 1 from app_private.family_push_jobs where user_id in ((ctx->>'guardian')::uuid,(ctx->>'student')::uuid,(ctx->>'optout')::uuid))
  then raise exception 'Homework push QA rollback left synthetic records.'; end if;
end;
$cleanup$;

rollback;
select true as published_opted_in_and_siblings_deduplicated, true as draft_and_peer_section_excluded,
  true as exact_detail_and_guarded_retry, true as revoked_and_unpublished_suppressed,
  true as edits_republish_and_late_opt_in_do_not_resend, true as fixture_writes_rolled_back;
