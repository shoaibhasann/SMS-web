-- Run as one trusted SQL request. Only new synthetic school records are written and all roll back.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '25s';

create function pg_temp.payment_push_qa_actor(actor_id uuid, session_id uuid, path text)
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
  admin_user uuid := gen_random_uuid();
  admin_session uuid := gen_random_uuid();
  principal_user uuid := gen_random_uuid();
  principal_session uuid := gen_random_uuid();
  guardian_user uuid := gen_random_uuid();
  guardian_session uuid := gen_random_uuid();
  student_user uuid := gen_random_uuid();
  student_session uuid := gen_random_uuid();
  optout_user uuid := gen_random_uuid();
  optout_session uuid := gen_random_uuid();
  guardian_record uuid := gen_random_uuid();
  optout_record uuid := gen_random_uuid();
  pupil uuid := gen_random_uuid();
  demand uuid := gen_random_uuid();
  payment_request uuid := gen_random_uuid();
  reversal_request uuid := gen_random_uuid();
  lease uuid := gen_random_uuid();
  today date := (statement_timestamp() at time zone 'Asia/Kolkata')::date;
  actor record;
  earlier_receipt jsonb;
  receipt jsonb;
  payment uuid;
  guardian_job uuid;
  student_job uuid;
  prepared jsonb;
  detail jsonb;
  read_time timestamptz;
  financial_token text;
  reversal jsonb;
begin
  begin
    insert into public.schools(id,name,code) values(school,'Synthetic payment push QA','PAY-PUSH-'||left(school::text,8));
    insert into public.academic_years(id,school_id,name,start_date,end_date,is_current)
      values(school_year,school,'Synthetic payment year',today-30,today+30,true);
    insert into public.classes(id,school_id,name) values(course,school,'Synthetic class');
    insert into public.sections(id,school_id,class_id,name) values(section,school,course,'Synthetic section');
    insert into public.fee_structures(id,school_id,academic_year_id,class_id,name,amount)
      values(structure,school,school_year,course,'Private synthetic tuition',1000);
    for actor in select * from (values
      (admin_user,admin_session,'school_admin'::public.app_role),
      (principal_user,principal_session,'principal'::public.app_role),
      (guardian_user,guardian_session,'parent'::public.app_role),
      (student_user,student_session,'student'::public.app_role),
      (optout_user,optout_session,'parent'::public.app_role)) a(uid,session_id,role)
    loop
      insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
        values(actor.uid,actor.uid::text||'@payment-push-qa.invalid',statement_timestamp(),'{"full_name":"Synthetic payment push QA"}');
      update public.profiles set school_id=school where id=actor.uid;
      insert into public.user_roles(user_id,school_id,role) values(actor.uid,school,actor.role);
      insert into auth.sessions(id,user_id,aal,not_after)
        values(actor.session_id,actor.uid,'aal1',statement_timestamp()+interval '3 minutes');
    end loop;
    insert into public.students(id,school_id,profile_id,admission_no,first_name)
      values(pupil,school,student_user,'QA-PAY-'||pupil::text,'Synthetic Student');
    insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values(pupil,school_year,course,section);
    insert into public.parents(id,school_id,profile_id) values
      (guardian_record,school,guardian_user),(optout_record,school,optout_user);
    insert into public.student_parents(student_id,parent_id,relationship) values
      (pupil,guardian_record,'guardian'),(pupil,optout_record,'guardian');
    insert into public.student_fees(id,school_id,student_id,fee_structure_id,due_date,amount,status)
      values(demand,school,pupil,structure,today+1,1000,'pending');

    perform pg_temp.payment_push_qa_actor(admin_user,admin_session,'/rpc/record_office_fee_payment');
    earlier_receipt := public.record_office_fee_payment(school,demand,100,'cash',gen_random_uuid(),null);
    for actor in select * from (values
      (guardian_user,guardian_session,'parent',true),
      (student_user,student_session,'student',true),
      (optout_user,optout_session,'parent',false)) a(uid,session_id,role,enabled)
    loop
      perform pg_temp.payment_push_qa_actor(actor.uid,actor.session_id,'/rpc/register_my_family_push_device');
      perform public.register_my_family_push_device(actor.role,gen_random_uuid(),repeat('a',64),
        'c'||substr(replace(gen_random_uuid()::text,'-',''),1,21),'android','Rollback payment push QA');
      perform public.set_my_family_push_preferences(actor.role,actor.enabled,false,false,false,0);
    end loop;
    perform pg_temp.payment_push_qa_actor(admin_user,admin_session,'/rpc/record_office_fee_payment');
    receipt := public.record_office_fee_payment(school,demand,125.25,'cash',payment_request,null);
    payment := (receipt->>'payment_id')::uuid;
    if payment is null or public.record_office_fee_payment(school,demand,125.25,'cash',payment_request,null) is distinct from receipt
    then raise exception 'Exact office retry did not return the original payment receipt.'; end if;

    perform set_config('role','none',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{}',true);
    if (select count(*) from public.fee_payments where school_id=school and office_request_id=payment_request) <> 1
      or (select count(*) from app_private.family_fee_payment_publications publication
        where publication.school_id=school and publication.fee_id=demand
          and publication.payment_id in (payment,(earlier_receipt->>'payment_id')::uuid)) <> 2
      or (select count(*) from app_private.family_push_jobs job where job.school_id=school) <> 2
      or (select count(*) from app_private.family_push_jobs job
        join app_private.family_fee_payment_publications publication on publication.payment_id=job.event_id
        where job.school_id=school and job.kind='fee_payment' and job.event_id=payment
          and job.user_id in (guardian_user,student_user) and job.expires_at=publication.recorded_at+interval '24 hours') <> 2
      or exists(select 1 from app_private.family_push_jobs job where job.school_id=school and job.event_id=(earlier_receipt->>'payment_id')::uuid)
    then raise exception 'Recording, retry or opt-in did not match the expected private payment jobs.'; end if;

    -- Assert the untouched governed write queued first. Then align the synthetic receipt
    -- to this multi-statement request's clock so the inbox can read it in the same request.
    update public.fee_payments set paid_at=least(paid_at,statement_timestamp())
      where id=payment and school_id=school and office_request_id=payment_request
        and (paid_at at time zone 'Asia/Kolkata')::date=today and paid_at>statement_timestamp();
    perform pg_temp.payment_push_qa_actor(guardian_user,guardian_session,'/rpc/get_family_fee_payment');
    detail := public.get_family_fee_payment('parent',pupil,payment);
    if detail->>'status' is distinct from 'paid' or detail->>'receipt_no' is distinct from receipt->>'receipt_no'
      or (detail->>'amount')::numeric is distinct from 125.25
      or public.get_family_fee_payment('parent',gen_random_uuid(),payment) is not null
    then raise exception 'Guardian exact receipt or pupil scope differed.'; end if;
    read_time := public.mark_family_notification_read_v8('parent','fee_payment',payment);
    if read_time is null then raise exception 'Guardian payment read receipt was not saved.'; end if;
    perform pg_temp.payment_push_qa_actor(optout_user,optout_session,'/rpc/get_family_fee_payment');
    if public.get_family_fee_payment('parent',pupil,payment) is distinct from detail
    then raise exception 'Turning push off changed authorised payment detail access.'; end if;
    perform public.set_my_family_push_preferences('parent',true,false,false,false,1);

    perform set_config('role','none',true);
    select job.id into strict guardian_job from app_private.family_push_jobs job where job.event_id=payment and job.user_id=guardian_user;
    select job.id into strict student_job from app_private.family_push_jobs job where job.event_id=payment and job.user_id=student_user;
    -- Lease these two fixture jobs directly. Never claim the shared hosted queue.
    update app_private.family_push_jobs set status='leased',lease_id=lease,lease_until=statement_timestamp()+interval '1 minute'
      where id in (guardian_job,student_job);
    perform set_config('role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    prepared := public.prepare_family_push_job(guardian_job,lease);
    if prepared->>'event_id' is distinct from payment::text or prepared->>'kind' is distinct from 'fee_payment'
      or prepared->>'recipient_role' is distinct from 'parent' or prepared ?| array['title','balance','amount','receipt_no','student_id']
      or prepared::text like '%'||(receipt->>'receipt_no')||'%'
    then raise exception 'Prepared payment job was unavailable or exposed receipt detail.'; end if;

    perform pg_temp.payment_push_qa_actor(admin_user,admin_session,'/rpc/request_office_fee_change');
    select entry->>'financial_token' into financial_token
      from jsonb_array_elements(public.get_office_fee_ledger(school,null,pupil,200,0)->'rows') entry
      where entry->>'demand_id'=demand::text;
    reversal := public.request_office_fee_change(school,demand,'payment_reversal',null,payment,
      'Synthetic receipt correction',financial_token,reversal_request);
    perform pg_temp.payment_push_qa_actor(principal_user,principal_session,'/rpc/review_office_fee_change');
    reversal := public.review_office_fee_change((reversal->>'id')::uuid,'approved','Synthetic independent review');
    if reversal->>'state' is distinct from 'approved' or reversal->>'reference' is null
    then raise exception 'Independent review did not approve the synthetic payment reversal.'; end if;

    perform set_config('role','service_role',true);
    perform set_config('request.jwt.claim.sub','',true);
    perform set_config('request.jwt.claims','{"role":"service_role"}',true);
    if public.prepare_family_push_job(student_job,lease) is not null
      or public.finish_family_push_job(guardian_job,lease,'retry','QA_NO_SEND')
    then raise exception 'An independently reversed payment was still preparable or retryable.'; end if;

    perform set_config('role','none',true);
    if (select count(*) from app_private.family_push_jobs job where job.school_id=school
        and job.event_id=payment and job.status='cancelled' and job.result_code='no_longer_eligible') <> 2
      or (select count(*) from app_private.family_push_jobs job where job.school_id=school) <> 2
    then raise exception 'Reversal or later opt-in changed the original payment job identity.'; end if;
    update app_private.office_fee_payment_reversals set approved_at=least(approved_at,statement_timestamp())
      where payment_id=payment and school_id=school and request_id=(reversal->>'id')::uuid
        and business_date=today and approved_at>statement_timestamp();

    perform pg_temp.payment_push_qa_actor(guardian_user,guardian_session,'/rpc/get_family_fee_payment');
    detail := public.get_family_fee_payment('parent',pupil,payment);
    if detail->>'status' is distinct from 'reversed' or detail->>'receipt_no' is distinct from receipt->>'receipt_no'
      or detail->>'reversal_reference' is distinct from reversal->>'reference'
      or (detail->>'amount')::numeric is distinct from 125.25 or (detail->>'net_amount')::numeric is distinct from 0
      or public.mark_family_notification_read_v8('parent','fee_payment',payment) is distinct from read_time
    then raise exception 'Reversal failed to retain exact receipt identity and Guardian read state.'; end if;
    perform pg_temp.payment_push_qa_actor(student_user,student_session,'/rpc/get_family_notification_inbox_v8');
    if not exists(select 1 from jsonb_array_elements(public.get_family_notification_inbox_v8('student')->'notifications') item
      where item->>'source_id'=payment::text and item->>'kind'='fee_payment' and item->>'status'='reversed' and item->>'read_at' is null)
    then raise exception 'Student did not retain the independent unread reversed payment.'; end if;

    raise exception using errcode='P7716', message='Payment push QA passed, discard fixtures';
  exception when sqlstate 'P7716' then
    null;
  end;
  if exists(select 1 from public.schools where id=school)
    or exists(select 1 from auth.users where id in (admin_user,principal_user,guardian_user,student_user,optout_user))
    or exists(select 1 from auth.sessions where id in (admin_session,principal_session,guardian_session,student_session,optout_session))
    or exists(select 1 from public.student_fees where school_id=school)
    or exists(select 1 from public.fee_payments where school_id=school)
    or exists(select 1 from app_private.office_fee_days where school_id=school)
    or exists(select 1 from app_private.office_fee_payment_reversals where school_id=school)
    or exists(select 1 from app_private.family_fee_payment_publications where school_id=school)
    or exists(select 1 from app_private.family_fee_payment_reads where payment_id=payment)
    or exists(select 1 from app_private.family_push_devices where school_id=school)
    or exists(select 1 from app_private.family_push_jobs where school_id=school)
  then raise exception 'Payment push QA rollback left synthetic records.'; end if;
end;
$qa$;

rollback;
select true as governed_payment_retry_and_opt_in, true as private_payload_and_exact_receipt,
  true as independent_approval_suppresses_push, true as reversal_preserves_independent_read_state,
  true as fixture_writes_rolled_back;
