-- Permanent business conflicts must be HTTP 409. SQLSTATE 40001 denotes a
-- retryable serialization failure and PostgREST automatically retries it.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $precondition$
begin
  if not exists(select 1 from pg_proc procedure
    where procedure.oid=to_regprocedure('app_private.save_school_staff_mfa_policy(uuid,integer,boolean,uuid,text)')
      and procedure.prosecdef and procedure.proconfig=array['search_path=""']
      and md5(pg_get_functiondef(procedure.oid))='75821c8fd222159662d704586ff26317') then
    raise exception 'Review the deployed staff MFA policy writer before changing its conflict contract.';
  end if;
end;
$precondition$;

create or replace function app_private.save_school_staff_mfa_policy(p_school_id uuid,p_expected_revision integer,p_required boolean,p_request_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.staff_mfa_policy_actor(p_school_id,true);
  receipt app_private.school_staff_mfa_receipts%rowtype;
  previous_required boolean; revision integer; changed boolean; payload jsonb;
begin
  if p_request_id is null or p_expected_revision is null or p_expected_revision<0 or p_required is null
    or p_reason is null or char_length(btrim(p_reason)) not between 5 and 300 or p_reason~'[[:cntrl:]]' then
    raise exception 'Reload security settings and enter a reason of 5 to 300 characters.' using errcode='22023'; end if;
  payload:=jsonb_build_object('school_id',p_school_id,'expected_revision',p_expected_revision,'required',p_required,'reason',p_reason);
  perform pg_advisory_xact_lock(hashtextextended('staff-mfa:'||actor::text||':'||p_request_id::text,0));
  select * into receipt from app_private.school_staff_mfa_receipts where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload<>payload then raise exception 'This security retry belongs to different input.' using errcode='PT409'; end if;
    return jsonb_build_object('revision',receipt.revision,'required',receipt.required,'changed',receipt.changed,'replayed',true);
  end if;
  select policy.required,policy.revision into previous_required,revision from app_private.school_staff_mfa_policy policy where school_id=p_school_id;
  if not found then previous_required:=false; revision:=0; end if;
  if revision<>p_expected_revision then raise exception 'School security changed. Reload before saving.' using errcode='PT409'; end if;
  if p_required then
    -- Serialize readiness against native factor removal/status changes. A deadlock
    -- victim rolls back safely and retries with the same actor/request receipt.
    perform 1 from auth.mfa_factors factor where factor.factor_type='totp' and factor.status='verified'
      and exists(select 1 from public.profiles profile where profile.id=factor.user_id and profile.is_active
        and exists(select 1 from public.user_roles membership where membership.user_id=profile.id
          and membership.school_id=p_school_id and membership.role not in('parent','student','super_admin')))
      order by factor.id for share;
  end if;
  if p_required and(app_private.school_staff_mfa_counts(p_school_id)->>'enrollment_required_count')::integer>0 then
    raise exception 'Every active staff account must verify an authenticator before enabling this policy.' using errcode='22023'; end if;
  changed:=previous_required is distinct from p_required;
  if changed then
    if revision=2147483647 then raise exception 'The security revision limit requires operator support.' using errcode='22023'; end if;
    revision:=revision+1;
    insert into app_private.school_staff_mfa_policy as policy(school_id,required,revision) values(p_school_id,p_required,revision)
      on conflict(school_id) do update set required=excluded.required,revision=excluded.revision;
    insert into app_private.school_staff_mfa_audit(school_id,revision,required,actor_id,request_id,reason)
      values(p_school_id,revision,p_required,actor,p_request_id,btrim(p_reason));
  end if;
  insert into app_private.school_staff_mfa_receipts(actor_id,request_id,school_id,payload,revision,required,changed)
    values(actor,p_request_id,p_school_id,payload,revision,p_required,changed);
  return jsonb_build_object('revision',revision,'required',p_required,'changed',changed,'replayed',false);
end;
$$;
notify pgrst,'reload schema';
commit;
