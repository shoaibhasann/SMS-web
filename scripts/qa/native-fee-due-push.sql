-- Run as one trusted SQL request. All rows belong to a new synthetic school and roll back.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '25s';

create function pg_temp.fee_push_qa_actor(actor_id uuid, session_id uuid, path text)
returns void language plpgsql as $actor$
begin
  perform set_config('role','authenticated',true);
  perform set_config('request.path',path,true);
  perform set_config('request.jwt.claim.sub',actor_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_id,'session_id',session_id,'aal','aal1','role','authenticated')::text,true);
  perform public.check_staff_mfa_request();
end;
$actor$;

do $qa$
declare
  school uuid := gen_random_uuid();
  school_year uuid := gen_random_uuid();
  course uuid := gen_random_uuid();
  section uuid := gen_random_uuid();
  structure uuid := gen_random_uuid();
  guardian_user uuid := gen_random_uuid();
  guardian_session uuid := gen_random_uuid();
  student_user uuid := gen_random_uuid();
  student_session uuid := gen_random_uuid();
  optout_user uuid := gen_random_uuid();
  optout_session uuid := gen_random_uuid();
  guardian_record uuid := gen_random_uuid();
  pupil uuid := gen_random_uuid();
  optout_pupil uuid := gen_random_uuid();
  due_fee uuid := gen_random_uuid();
  partial_fee uuid := gen_random_uuid();
  old_fee uuid := gen_random_uuid();
  future_fee uuid := gen_random_uuid();
  invalid_fee uuid := gen_random_uuid();
  optout_fee uuid := gen_random_uuid();
  partial_payment uuid := gen_random_uuid();
  settlement uuid := gen_random_uuid();
  lease uuid := gen_random_uuid();
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  next_midnight timestamptz := (today+1)::timestamp at time zone 'Asia/Kolkata';
  read_time timestamptz;
  actor record;
  dispatch_job record;
  prepared jsonb;
begin
  begin
    insert into public.schools(id,name,code) values(school,'Synthetic fee push QA','FEE-PUSH-'||left(school::text,8));
    insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values(school_year,school,'Synthetic fee push year',today-30,today+30,true);
    insert into public.classes(id,school_id,name) values(course,school,'Synthetic class');
    insert into public.sections(id,school_id,class_id,name) values(section,school,course,'Synthetic section');
    insert into public.fee_structures(id,school_id,academic_year_id,class_id,name,amount)
      values(structure,school,school_year,course,'Private synthetic tuition',1000);
    for actor in select * from (values
      (guardian_user,guardian_session,'parent'::public.app_role,true),
      (student_user,student_session,'student'::public.app_role,true),
      (optout_user,optout_session,'student'::public.app_role,false)) a(uid,session_id,role,enabled)
    loop
      insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
        values(actor.uid,actor.uid::text||'@fee-push-qa.invalid',statement_timestamp(),'{"full_name":"Synthetic fee push QA"}');
      update public.profiles set school_id=school where id=actor.uid;
      insert into public.user_roles(user_id,school_id,role) values(actor.uid,school,actor.role);
      insert into auth.sessions(id,user_id,aal,not_after)
        values(actor.session_id,actor.uid,'aal1',statement_timestamp()+interval '3 minutes');
    end loop;
    insert into public.students(id,school_id,profile_id,admission_no,first_name) values
      (pupil,school,student_user,'QA-FEE-'||pupil::text,'Synthetic Student'),
      (optout_pupil,school,optout_user,'QA-FEE-'||optout_pupil::text,'Synthetic Optout');
    insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values
      (pupil,school_year,course,section),(optout_pupil,school_year,course,section);
    insert into public.parents(id,school_id,profile_id) values(guardian_record,school,guardian_user);
    insert into public.student_parents(student_id,parent_id,relationship) values(pupil,guardian_record,'guardian');
    for actor in select * from (values
      (guardian_user,guardian_session,'parent',true),
      (student_user,student_session,'student',true),
      (optout_user,optout_session,'student',false)) a(uid,session_id,role,enabled)
    loop
      perform pg_temp.fee_push_qa_actor(actor.uid,actor.session_id,'/rpc/register_my_family_push_device');
      perform public.register_my_family_push_device(actor.role,gen_random_uuid(),repeat('a',64),
        'c'||substr(replace(gen_random_uuid()::text,'-',''),1,21),'android','Rollback fee push QA');
      perform public.set_my_family_push_preferences(actor.role,actor.enabled,false,false,false,0);
    end loop;

    perform set_config('role','none',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{}',true);
    insert into public.student_fees(id,school_id,student_id,fee_structure_id,due_date,amount,status) values
      (due_fee,school,pupil,structure,today,1000,'pending'),
      (partial_fee,school,pupil,structure,today,1000,'pending'),
      (old_fee,school,pupil,structure,today-1,1000,'pending'),
      (future_fee,school,pupil,structure,today+1,1000,'pending'),
      (invalid_fee,school,pupil,structure,today,-50,'pending'),
      (optout_fee,school,optout_pupil,structure,today,1000,'pending');
    insert into public.fee_payments(id,school_id,student_fee_id,student_id,receipt_no,amount,payment_method,status,paid_at)
      values(partial_payment,school,partial_fee,pupil,'QA-FEE-PUSH-'||partial_payment::text,250,'cash','paid',statement_timestamp());

    perform pg_temp.fee_push_qa_actor(guardian_user,guardian_session,'/rpc/get_family_fee_due');
    if (public.get_family_fee_due('parent',pupil,partial_fee)->>'balance')::numeric is distinct from 750
      or public.get_family_fee_due('parent',optout_pupil,optout_fee) is not null
    then raise exception 'Canonical balance or Guardian pupil scope differed.'; end if;
    read_time := public.mark_family_notification_read_v8('parent','fee_due',partial_fee);
    if read_time is null then raise exception 'Fee read receipt was not recorded.'; end if;

    perform set_config('role','none',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{}',true);
    -- The scoped enqueuer and direct leases leave the shared hosted worker queue untouched.
    perform app_private.enqueue_family_fee_due_push(20,school);
    perform app_private.enqueue_family_fee_due_push(20,school);
    if (select count(*) from app_private.family_push_jobs job where job.school_id=school) <> 4
      or (select count(*) from app_private.family_push_jobs job where job.school_id=school
        and job.kind='fee_due' and job.event_id in (due_fee,partial_fee)
        and job.user_id in (guardian_user,student_user) and job.expires_at=next_midnight) <> 4
      or exists(select 1 from app_private.family_push_jobs job where job.school_id=school
        group by job.event_id,job.device_id having count(*)>1)
    then raise exception 'Due-today scope, opt-in, midnight expiry or fee/device deduplication differed.'; end if;
    update app_private.family_push_jobs set status='leased',lease_id=lease,lease_until=statement_timestamp()+interval '1 minute'
      where school_id=school;

    insert into public.fee_payments(id,school_id,student_fee_id,student_id,receipt_no,amount,payment_method,status,paid_at)
      values(settlement,school,due_fee,pupil,'QA-FEE-PUSH-'||settlement::text,1000,'cash','paid',statement_timestamp());
    perform pg_temp.fee_push_qa_actor(guardian_user,guardian_session,'/rpc/get_family_fee_due');
    if public.get_family_fee_due('parent',pupil,due_fee) is not null
      or public.mark_family_notification_read_v8('parent','fee_due',partial_fee) is distinct from read_time
    then raise exception 'Settlement or the Guardian receipt did not follow the current ledger.'; end if;

    perform set_config('role','none',true);
    delete from public.student_parents where parent_id=guardian_record and student_id=pupil;
    for dispatch_job in select id,event_id,recipient_role from app_private.family_push_jobs where school_id=school
    loop
      perform set_config('role','service_role',true);
      perform set_config('request.jwt.claim.sub','',true);
      perform set_config('request.jwt.claims','{"role":"service_role"}',true);
      prepared := public.prepare_family_push_job(dispatch_job.id,lease);
      if dispatch_job.event_id=due_fee or dispatch_job.recipient_role='parent' then
        if prepared is not null then raise exception 'Settled or unlinked fee reminder was prepared.'; end if;
      elsif prepared->>'event_id' is distinct from partial_fee::text or prepared->>'kind' is distinct from 'fee_due'
        or prepared->>'recipient_role' is distinct from 'student' or prepared ?| array['title','balance','amount','student_id']
      then raise exception 'The still-eligible Student could not prepare a private fee reminder.'; end if;
      perform set_config('role','none',true);
    end loop;
    perform pg_temp.fee_push_qa_actor(student_user,student_session,'/rpc/get_family_notification_inbox_v8');
    if not exists(select 1 from jsonb_array_elements(public.get_family_notification_inbox_v8('student')->'notifications') item
      where item->>'source_id'=partial_fee::text and item->>'kind'='fee_due' and item->>'read_at' is null)
    then raise exception 'Preparing a Student fee reminder changed its unread receipt.'; end if;

    -- The exception block rolls back only our synthetic scope before the cleanup check.
    raise exception using errcode='P7715', message='Fee push QA passed, discard fixtures';
  exception when sqlstate 'P7715' then
    null;
  end;
  if exists(select 1 from public.schools where id=school)
    or exists(select 1 from auth.users where id in (guardian_user,student_user,optout_user))
    or exists(select 1 from auth.sessions where id in (guardian_session,student_session,optout_session))
    or exists(select 1 from public.student_fees where school_id=school)
    or exists(select 1 from public.fee_payments where school_id=school)
    or exists(select 1 from app_private.office_fee_days where school_id=school)
    or exists(select 1 from app_private.family_push_devices where school_id=school)
    or exists(select 1 from app_private.family_push_jobs where school_id=school)
    or exists(select 1 from app_private.family_fee_due_reads where fee_id in (due_fee,partial_fee))
  then raise exception 'Fee push QA rollback left synthetic rows.'; end if;
end;
$qa$;

rollback;
select true as due_today_balance_scope_and_opt_in, true as midnight_expiry_and_dedup,
  true as live_settlement_and_link_revocation, true as private_payload_and_independent_receipts,
  true as fixture_writes_rolled_back;
