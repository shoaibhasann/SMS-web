begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Auth-row locks serialize new native factors/sessions through their real FK
-- checks. Fail closed if a target environment lacks that managed contract.
do $native_lock_contract$
declare relation regclass;begin
 foreach relation in array array['auth.mfa_factors'::regclass,'auth.sessions'::regclass] loop
  if not exists(select 1 from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attname='user_id' and not a.attisdropped
    join pg_attribute target on target.attrelid=c.confrelid and target.attname='id' and not target.attisdropped
    where c.conrelid=relation and c.contype='f' and c.convalidated and c.confrelid='auth.users'::regclass
      and c.conkey=array[a.attnum] and c.confkey=array[target.attnum]) then
   raise exception 'The verified native Auth lock contract is required for guardian recovery.';end if;
 end loop;
end;$native_lock_contract$;

-- Recovery transfers school access to an independently verified login; native
-- Auth accounts, factors and original actor/event records are never rewritten.
create table app_private.guardian_recovery_cases(
 id uuid primary key default gen_random_uuid(),school_id uuid not null references public.schools(id),
 parent_id uuid not null references public.parents(id),old_user_id uuid not null,new_user_id uuid,
 channel text not null check(channel in('email','phone')),contact text not null check(char_length(contact)<=254),
 requires_mfa boolean not null,snapshot_hash text not null,snapshot jsonb not null,
 status text not null default 'pending' check(status in('pending','approved','rejected','cancelled','accepted','expired')),
 version integer not null default 1 check(version>0),requester_id uuid not null,reviewer_id uuid,
 created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
 token_hash bytea,accepted_at timestamptz,
 check(old_user_id<>new_user_id),check(status<>'accepted' or new_user_id is not null),check(reviewer_id is null or reviewer_id<>requester_id),
 check(status not in('approved','accepted') or(token_hash is not null and reviewer_id is not null))
);
create unique index guardian_recovery_one_open on app_private.guardian_recovery_cases(parent_id) where status in('pending','approved');
create unique index guardian_recovery_unique_token on app_private.guardian_recovery_cases(token_hash) where token_hash is not null;
create index guardian_recovery_school_history on app_private.guardian_recovery_cases(school_id,created_at desc,id desc);
create table app_private.guardian_recovery_audit(
 id uuid primary key default gen_random_uuid(),case_id uuid not null references app_private.guardian_recovery_cases(id),
 actor_id uuid not null,action text not null check(action in('requested','approved','rejected','cancelled','accepted')),
 reason text not null check(char_length(reason) between 5 and 300),occurred_at timestamptz not null default clock_timestamp()
);
create table app_private.guardian_recovery_receipts(
 actor_id uuid not null,request_id uuid not null,operation text not null,payload_hash text not null,response jsonb not null,
 created_at timestamptz not null default clock_timestamp(),primary key(actor_id,request_id)
);
create table app_private.guardian_recovery_recipient_history(
 parent_id uuid not null references public.parents(id),school_id uuid not null references public.schools(id),
 previous_user_id uuid not null,through_at timestamptz not null,case_id uuid not null references app_private.guardian_recovery_cases(id),
 primary key(parent_id,previous_user_id)
);
alter table app_private.guardian_recovery_cases enable row level security;
alter table app_private.guardian_recovery_audit enable row level security;
alter table app_private.guardian_recovery_receipts enable row level security;
alter table app_private.guardian_recovery_recipient_history enable row level security;
revoke all on app_private.guardian_recovery_cases,app_private.guardian_recovery_audit,
 app_private.guardian_recovery_receipts,app_private.guardian_recovery_recipient_history from public,anon,authenticated,service_role;

create function app_private.guardian_recovery_hash(p_value jsonb) returns text language sql immutable set search_path=''
as $$select encode(pg_catalog.sha256(convert_to(p_value::text,'UTF8')),'hex');$$;
create function app_private.guardian_recovery_identity() returns uuid language plpgsql security definer set search_path=''
as $$declare actor uuid:=auth.uid();begin
 if not app_private.has_live_school_session() or not app_private.staff_mfa_allowed() then raise exception 'Verify account security before continuing.' using errcode='42501';end if;
 return actor;end;$$;
create function app_private.guardian_recovery_office(p_school_id uuid) returns uuid language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.student_leave_actor();begin
 if not app_private.has_live_school_session() then raise exception 'A current school session is required.' using errcode='42501';end if;
 perform 1 from auth.sessions session join auth.mfa_factors factor on factor.id=session.factor_id
  and factor.user_id=actor and factor.factor_type='totp' and factor.status='verified'
  where session.id=(auth.jwt()->>'session_id')::uuid and session.user_id=actor and session.aal='aal2'
   and(session.not_after is null or session.not_after>clock_timestamp()) for share of session,factor;
 if not found then raise exception 'Current native authenticator verification is required.' using errcode='42501';end if;
 if not app_private.staff_mfa_allowed() or auth.jwt()->>'aal' is distinct from 'aal2' or not exists(select 1 from public.user_roles r
  where r.user_id=actor and r.school_id=p_school_id and r.role in('school_admin','principal')) then
  raise exception 'Current School Admin or Principal authenticator verification is required.' using errcode='42501';end if;
 perform 1 from public.schools where id=p_school_id and is_active for share;
 if not found then raise exception 'Current school access is required.' using errcode='42501';end if;
 perform 1 from public.user_roles where user_id=actor and school_id=p_school_id and role in('school_admin','principal') order by id for share;
 return actor;end;$$;

-- Auth-first locks match existing guardian invitation/revocation transactions.
create function app_private.guardian_recovery_snapshot(p_school_id uuid,p_parent_id uuid,p_new_user uuid,p_channel text,p_contact text,p_lock boolean default true)
returns jsonb language plpgsql security definer set search_path=''
as $$declare old_user uuid;target uuid:=p_new_user;parent public.parents%rowtype;previous public.profiles%rowtype;replacement public.profiles%rowtype;
 old_account auth.users%rowtype;new_account auth.users%rowtype;links jsonb;roles jsonb;begin
 select profile_id into old_user from public.parents where id=p_parent_id and school_id=p_school_id;
 if old_user is null or p_channel is null or p_channel not in('email','phone') then
  raise exception 'The guardian recovery target is unavailable.' using errcode='42501';end if;
 if(select count(*) from auth.users where case when p_channel='email' then lower(btrim(email))=p_contact else app_private.guardian_e164_phone(phone)=p_contact end)>1 then
  raise exception 'The replacement contact is ambiguous.' using errcode='42501';end if;
 if target is null then
 select id into target from auth.users where case when p_channel='email' then lower(btrim(email))=p_contact else app_private.guardian_e164_phone(phone)=p_contact end;
 end if;
 if old_user=target then raise exception 'Choose a different replacement account.' using errcode='42501';end if;
 if p_lock then
  perform 1 from auth.users where id=old_user or id=target order by id for update;
  -- Auth-row locks block new factor FK inserts; existing (even unverified)
  -- factor rows must also stay fixed until the reviewed grant commits.
  perform 1 from auth.mfa_factors where user_id=old_user or user_id=target order by id for share;
  perform 1 from public.profiles where id=old_user or id=target order by id for update;
  perform 1 from public.parents where id=p_parent_id for update;
 end if;
 select * into parent from public.parents where id=p_parent_id and school_id=p_school_id and profile_id=old_user;
 select * into previous from public.profiles where id=old_user;
 select * into old_account from auth.users where id=old_user;
 if parent.id is null or not coalesce(previous.is_active,false) or previous.school_id is distinct from p_school_id
  or old_account.id is null or coalesce(old_account.is_anonymous,false) or old_account.deleted_at is not null
  or coalesce(old_account.banned_until>statement_timestamp(),false)
  or(old_account.email_confirmed_at is null and old_account.phone_confirmed_at is null)
  or(select count(*) from public.parents where profile_id=old_user)<>1
  or exists(select 1 from public.students where profile_id=old_user) or exists(select 1 from public.teachers where profile_id=old_user)
  or exists(select 1 from public.user_roles where user_id=old_user and(role<>'parent' or school_id is distinct from p_school_id))
  or not exists(select 1 from public.user_roles where user_id=old_user and role='parent' and school_id=p_school_id) then
  raise exception 'Use a pure guardian account from this school.' using errcode='42501';end if;
 if target is not null then
  select * into replacement from public.profiles where id=target;
  select * into new_account from auth.users where id=target;
  if new_account.id is null or coalesce(new_account.is_anonymous,false) or new_account.deleted_at is not null
   or coalesce(new_account.banned_until>statement_timestamp(),false) or not coalesce(replacement.is_active,false)
   or(replacement.school_id is not null and replacement.school_id<>p_school_id)
   or(p_channel='email' and lower(btrim(new_account.email)) is distinct from p_contact)
   or(p_channel='phone' and app_private.guardian_e164_phone(new_account.phone) is distinct from p_contact)
   or exists(select 1 from public.parents where profile_id=target) or exists(select 1 from public.students where profile_id=target)
   or exists(select 1 from public.teachers where profile_id=target) or exists(select 1 from public.user_roles where user_id=target) then
   raise exception 'Use an unassigned replacement account.' using errcode='42501';end if;
 end if;
 if p_lock then
  perform 1 from public.user_roles where user_id=old_user or user_id=target order by id for share;
  perform 1 from public.student_parents where parent_id=parent.id order by student_id for share;
 end if;
 select jsonb_agg(to_jsonb(link) order by link.student_id) into links from public.student_parents link
  join public.students student on student.id=link.student_id and student.school_id=p_school_id where link.parent_id=parent.id;
 if links is null or jsonb_array_length(links)>1500 or jsonb_array_length(links)<>(select count(*) from public.student_parents where parent_id=parent.id) then
  raise exception 'Review this guardian child mapping before recovery.' using errcode='22023';end if;
 select jsonb_agg(jsonb_build_object('id',id,'role',role,'school_id',school_id) order by id) into roles from public.user_roles where user_id=old_user;
 -- New contact verification and authenticator enrollment are permitted progress,
 -- not edits to the office's reviewed old-guardian/child snapshot.
 return jsonb_build_object('parent',to_jsonb(parent),'old_profile',jsonb_build_object('id',previous.id,'school_id',previous.school_id,'is_active',previous.is_active,'full_name',previous.full_name),
  'new_user_id',p_new_user,'old_contact',jsonb_build_object('email',old_account.email,'email_verified',old_account.email_confirmed_at,'phone',old_account.phone,'phone_verified',old_account.phone_confirmed_at),
  'roles',roles,'links',links,'requires_mfa',exists(select 1 from auth.mfa_factors where user_id=old_user and status='verified'));
end;$$;

create function app_private.guardian_recovery_result(p_case app_private.guardian_recovery_cases) returns jsonb language sql stable set search_path=''
as $$select jsonb_build_object('id',p_case.id,'status',p_case.status,'version',p_case.version,'expires_at',p_case.expires_at,'requires_mfa',p_case.requires_mfa);$$;

create function app_private.get_guardian_recovery_workspace(p_school_id uuid,p_admission_no text default null)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.guardian_recovery_office(p_school_id);pupil uuid;guardians jsonb:='[]';history jsonb;begin
 if p_admission_no is not null and btrim(p_admission_no)<>'' then
  if char_length(btrim(p_admission_no))>100 then raise exception 'Enter a valid admission number.' using errcode='22023';end if;
  if(select count(*) from public.students where school_id=p_school_id and admission_no=btrim(p_admission_no))>1 then
   raise exception 'Resolve the ambiguous admission number before recovery.' using errcode='22023';end if;
  select id into pupil from public.students where school_id=p_school_id and admission_no=btrim(p_admission_no);
  if(select count(*) from public.student_parents where student_id=pupil)>20 then raise exception 'Review this student guardian mapping before recovery.' using errcode='22023';end if;
  select coalesce(jsonb_agg(jsonb_build_object('parent_id',p.id,'name',left(coalesce(nullif(btrim(profile.full_name),''),'Guardian'),160),
    'linked_children',(select count(*) from public.student_parents other where other.parent_id=p.id),
    'requires_mfa',exists(select 1 from auth.mfa_factors where user_id=p.profile_id and status='verified')) order by p.id),'[]') into guardians
   from public.student_parents link join public.parents p on p.id=link.parent_id and p.school_id=p_school_id
   join public.profiles profile on profile.id=p.profile_id and profile.school_id=p_school_id and profile.is_active
   where link.student_id=pupil and not exists(select 1 from public.user_roles where user_id=p.profile_id and(role<>'parent' or school_id is distinct from p_school_id));
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'parent_id',c.parent_id,'guardian_name',left(coalesce(nullif(btrim(c.snapshot#>>'{old_profile,full_name}'),''),'Guardian'),160),
  'channel',c.channel,'contact',c.contact,'status',case when c.status in('pending','approved') and c.expires_at<=statement_timestamp() then 'expired' else c.status end,
  'version',c.version,'expires_at',c.expires_at,'requires_mfa',c.requires_mfa,'created_at',c.created_at,
  'requester_name',left(requester.full_name,160),'reviewer_name',left(reviewer.full_name,160),
  'can_review',c.status='pending' and c.expires_at>statement_timestamp() and c.requester_id<>actor,
  'can_cancel',c.status in('pending','approved') and c.expires_at>statement_timestamp() and(actor=c.requester_id or actor is not distinct from c.reviewer_id)) order by c.created_at desc,c.id desc),'[]') into history
  from(select * from app_private.guardian_recovery_cases where school_id=p_school_id order by created_at desc,id desc limit 50)c
  left join public.profiles requester on requester.id=c.requester_id and requester.school_id=p_school_id
  left join public.profiles reviewer on reviewer.id=c.reviewer_id and reviewer.school_id=p_school_id;
 return jsonb_build_object('school_id',p_school_id,'guardians',guardians,'cases',history,'cases_limit',50,
  'total_cases',(select count(*) from app_private.guardian_recovery_cases where school_id=p_school_id));
end;$$;

create function app_private.request_guardian_account_recovery(p_school_id uuid,p_parent_id uuid,p_channel text,p_contact text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.guardian_recovery_office(p_school_id);target uuid;contact text:=lower(btrim(p_contact));snap jsonb;fingerprint text;result jsonb;
 receipt app_private.guardian_recovery_receipts%rowtype;c app_private.guardian_recovery_cases%rowtype;begin
 if p_request_id is null or p_reason is null or char_length(btrim(p_reason)) not between 5 and 300 or p_reason~'[[:cntrl:]]'
  or contact is null or char_length(contact)>254 or p_channel is null or p_channel not in('email','phone')
  or(p_channel='email' and contact!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
  or(p_channel='phone' and contact!~'^\+91[6-9][0-9]{9}$') then raise exception 'Use a valid verified contact and a 5–300 character reason.' using errcode='22023';end if;
 fingerprint:=app_private.guardian_recovery_hash(jsonb_build_array(p_school_id,p_parent_id,p_channel,contact,btrim(p_reason)));
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery:'||actor::text||':'||p_request_id::text,0));
 select * into receipt from app_private.guardian_recovery_receipts where actor_id=actor and request_id=p_request_id;
 if found then if receipt.operation<>'request' or receipt.payload_hash<>fingerprint then raise exception 'This retry belongs to different recovery input.' using errcode='PT409';end if;return receipt.response;end if;
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery-school-budget:'||p_school_id::text,0));
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery-parent:'||p_parent_id::text,0));
 select id into target from auth.users where case when p_channel='email' then lower(btrim(email))=contact
   else app_private.guardian_e164_phone(phone)=contact end;
 snap:=app_private.guardian_recovery_snapshot(p_school_id,p_parent_id,target,p_channel,contact);
 update app_private.guardian_recovery_cases set status='expired',version=version+1 where parent_id=p_parent_id and status in('pending','approved') and expires_at<=statement_timestamp();
 if exists(select 1 from app_private.guardian_recovery_cases where parent_id=p_parent_id and status in('pending','approved')) then
  raise exception 'A recovery is already open for this guardian. Review or cancel it first.' using errcode='PT409';end if;
 if(select count(*) from app_private.guardian_recovery_cases where school_id=p_school_id and created_at>=statement_timestamp()-interval '1 day')>=1000 then
  raise exception 'The daily recovery limit requires operator review.' using errcode='22023';end if;
 insert into app_private.guardian_recovery_cases(school_id,parent_id,old_user_id,new_user_id,channel,contact,requires_mfa,snapshot_hash,snapshot,requester_id,expires_at)
  values(p_school_id,p_parent_id,(snap#>>'{old_profile,id}')::uuid,target,p_channel,contact,(snap->>'requires_mfa')::boolean,app_private.guardian_recovery_hash(snap),snap,actor,clock_timestamp()+interval '1 day') returning * into c;
 insert into app_private.guardian_recovery_audit(case_id,actor_id,action,reason) values(c.id,actor,'requested',btrim(p_reason));
 result:=app_private.guardian_recovery_result(c);
 insert into app_private.guardian_recovery_receipts(actor_id,request_id,operation,payload_hash,response) values(actor,p_request_id,'request',fingerprint,result);
 return result;end;$$;

create function app_private.review_guardian_account_recovery(p_case_id uuid,p_expected_version integer,p_decision text,p_reason text,p_request_id uuid,p_claim_token text default null)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;scope uuid;parent_id uuid;c app_private.guardian_recovery_cases%rowtype;receipt app_private.guardian_recovery_receipts%rowtype;
 fingerprint text;result jsonb;snap jsonb;begin
 select school_id,cases.parent_id into scope,parent_id from app_private.guardian_recovery_cases cases where id=p_case_id;
 actor:=app_private.guardian_recovery_office(scope);
 if p_case_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1 or p_decision is null
  or p_decision not in('approve','reject','cancel') or p_reason is null or char_length(btrim(p_reason)) not between 5 and 300 or p_reason~'[[:cntrl:]]'
  or(p_decision='approve' and(p_claim_token is null or p_claim_token!~'^[a-f0-9]{64}$'))
  or(p_decision<>'approve' and p_claim_token is not null) then raise exception 'Review valid recovery input and a 5–300 character reason.' using errcode='22023';end if;
 fingerprint:=app_private.guardian_recovery_hash(jsonb_build_array(p_case_id,p_expected_version,p_decision,btrim(p_reason),p_claim_token));
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery:'||actor::text||':'||p_request_id::text,0));
 select * into receipt from app_private.guardian_recovery_receipts where actor_id=actor and request_id=p_request_id;
 if found then if receipt.operation<>'review' or receipt.payload_hash<>fingerprint then raise exception 'This retry belongs to different recovery input.' using errcode='PT409';end if;
  return receipt.response||case when p_decision='approve' then jsonb_build_object('token',p_claim_token) else '{}'::jsonb end;end if;
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery-parent:'||parent_id::text,0));
 select * into c from app_private.guardian_recovery_cases where id=p_case_id for update;
 if c.version<>p_expected_version or c.status not in('pending','approved') or c.expires_at<=statement_timestamp()
  or(c.status='approved' and p_decision<>'cancel') then raise exception 'This recovery changed or expired. Reload before reviewing.' using errcode='PT409';end if;
 if p_decision in('approve','reject') and c.requester_id=actor then raise exception 'A different School Admin or Principal must review this recovery.' using errcode='42501';end if;
 if p_decision='cancel' and actor<>c.requester_id and actor is distinct from c.reviewer_id then
  raise exception 'Only the requester or reviewer can cancel this recovery.' using errcode='42501';end if;
 if p_decision='approve' then
  perform app_private.guardian_recovery_lock_officers(c.requester_id,actor,c.school_id);
  snap:=app_private.guardian_recovery_snapshot(c.school_id,c.parent_id,c.new_user_id,c.channel,c.contact);
  if app_private.guardian_recovery_hash(snap)<>c.snapshot_hash then raise exception 'The guardian, contact, roles or child mapping changed. Request a new reviewed recovery.' using errcode='PT409';end if;
 end if;
 update app_private.guardian_recovery_cases set status=case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'cancelled' end,
  reviewer_id=case when p_decision in('approve','reject') then actor else reviewer_id end,version=version+1,
  expires_at=case when p_decision='approve' then clock_timestamp()+interval '1 day' else expires_at end,
  token_hash=case when p_decision='approve' then pg_catalog.sha256(convert_to(p_claim_token,'UTF8')) else token_hash end where id=c.id returning * into c;
 insert into app_private.guardian_recovery_audit(case_id,actor_id,action,reason) values(c.id,actor,c.status,btrim(p_reason));
 result:=app_private.guardian_recovery_result(c);
 insert into app_private.guardian_recovery_receipts(actor_id,request_id,operation,payload_hash,response) values(actor,p_request_id,'review',fingerprint,result);
 return result||case when p_decision='approve' then jsonb_build_object('token',p_claim_token) else '{}'::jsonb end;
end;$$;

create function app_private.guardian_recovery_officer_current(p_user uuid,p_school uuid) returns boolean language sql stable security definer set search_path=''
as $$select exists(select 1 from public.profiles p join auth.users u on u.id=p.id join public.schools school on school.id=p.school_id and school.is_active
 where p.id=p_user and p.school_id=p_school and p.is_active and not coalesce(u.is_anonymous,false) and u.deleted_at is null
 and(u.banned_until is null or u.banned_until<=statement_timestamp()) and(u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
 and exists(select 1 from public.user_roles r where r.user_id=p.id and r.school_id=p_school and r.role in('school_admin','principal')));$$;

-- An approval may outlive its original native session, but each officer's
-- current verified identity, active school profile and authority must survive
-- the entire grant transaction. Locks serialize role/identity revocation.
create function app_private.guardian_recovery_lock_officers(p_requester uuid,p_reviewer uuid,p_school uuid)
returns void language plpgsql security definer set search_path=''
as $$declare locked integer;begin
 if p_requester is null or p_reviewer is null or p_requester=p_reviewer then raise exception 'Two current independent school officers are required.' using errcode='42501';end if;
 perform 1 from auth.users u where u.id in(p_requester,p_reviewer) and not coalesce(u.is_anonymous,false)
  and u.deleted_at is null and(u.banned_until is null or u.banned_until<=clock_timestamp())
  and(u.email_confirmed_at is not null or u.phone_confirmed_at is not null) order by u.id for share;
 get diagnostics locked=row_count;
 if locked<>2 then raise exception 'Two current independent school officers are required.' using errcode='42501';end if;
 perform 1 from public.profiles p where p.id in(p_requester,p_reviewer) and p.is_active and p.school_id=p_school order by p.id for share;
 get diagnostics locked=row_count;
 if locked<>2 then raise exception 'Two current independent school officers are required.' using errcode='42501';end if;
 perform 1 from public.user_roles r where r.user_id in(p_requester,p_reviewer) and r.school_id=p_school
  and r.role in('school_admin','principal') order by r.user_id,r.id for share;
 if(select count(distinct user_id) from public.user_roles where user_id in(p_requester,p_reviewer) and school_id=p_school and role in('school_admin','principal'))<>2
  or not app_private.guardian_recovery_officer_current(p_requester,p_school) or not app_private.guardian_recovery_officer_current(p_reviewer,p_school) then
  raise exception 'Two current independent school officers are required.' using errcode='42501';end if;
end;$$;

create function app_private.guardian_recovery_claim(p_token text) returns app_private.guardian_recovery_cases
language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.guardian_recovery_identity();c app_private.guardian_recovery_cases%rowtype;begin
 if p_token is null or p_token!~'^[a-f0-9]{64}$' then raise exception 'This recovery link is unavailable.' using errcode='42501';end if;
 select * into c from app_private.guardian_recovery_cases where token_hash=pg_catalog.sha256(convert_to(p_token,'UTF8')) and(new_user_id is null or new_user_id=actor)
  and(status='accepted' or(status='approved' and expires_at>statement_timestamp()));
 if c.id is null or(c.status='approved' and(not app_private.guardian_recovery_officer_current(c.requester_id,c.school_id) or not app_private.guardian_recovery_officer_current(c.reviewer_id,c.school_id))) or(c.status='accepted' and not exists(select 1 from public.parents p join public.user_roles r on r.user_id=p.profile_id and r.school_id=p.school_id and r.role='parent' where p.id=c.parent_id and p.profile_id=actor)) or(c.status<>'accepted' and not exists(select 1 from auth.users u where u.id=actor and
  (case when c.channel='email' then u.email_confirmed_at is not null and lower(btrim(u.email))=c.contact
   else u.phone_confirmed_at is not null and app_private.guardian_e164_phone(u.phone)=c.contact end))) then
  raise exception 'This recovery link is unavailable.' using errcode='42501';end if;
 if c.status='approved' and app_private.guardian_recovery_hash(app_private.guardian_recovery_snapshot(c.school_id,c.parent_id,c.new_user_id,c.channel,c.contact,false))<>c.snapshot_hash then raise exception 'The reviewed guardian recovery changed.' using errcode='PT409';end if;
 return c;end;$$;
create function app_private.get_my_guardian_recovery_claim(p_token text) returns jsonb language plpgsql security definer set search_path=''
as $$declare c app_private.guardian_recovery_cases:=app_private.guardian_recovery_claim(p_token);begin
 return jsonb_build_object('school_name',(select left(name,160) from public.schools where id=c.school_id and is_active),
 'status',c.status,'requires_mfa',c.requires_mfa,'linked_children',jsonb_array_length(c.snapshot->'links'),'expires_at',c.expires_at);end;$$;
create function app_private.accept_guardian_account_recovery(p_token text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.guardian_recovery_identity();c app_private.guardian_recovery_cases%rowtype;
 receipt app_private.guardian_recovery_receipts%rowtype;fingerprint text;snap jsonb;result jsonb;accepted_time timestamptz;begin
 if p_request_id is null or p_token is null or p_token!~'^[a-f0-9]{64}$' then raise exception 'This recovery link is unavailable.' using errcode='42501';end if;
 fingerprint:=app_private.guardian_recovery_hash(jsonb_build_array(p_token));
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery:'||actor::text||':'||p_request_id::text,0));
 select * into receipt from app_private.guardian_recovery_receipts where actor_id=actor and request_id=p_request_id;
 if found then
  if receipt.operation<>'accept' or receipt.payload_hash<>fingerprint then raise exception 'This retry belongs to different recovery input.' using errcode='PT409';end if;
  if not exists(select 1 from public.parents p join public.user_roles r on r.user_id=p.profile_id and r.school_id=p.school_id and r.role='parent'
   where p.id=(receipt.response->>'parent_id')::uuid and p.profile_id=actor and exists(select 1 from public.student_parents where parent_id=p.id)) then
   raise exception 'Current guardian access is required.' using errcode='42501';end if;
  return receipt.response||jsonb_build_object('replayed',true);end if;
 c:=app_private.guardian_recovery_claim(p_token);
 if c.status='accepted' then return jsonb_build_object('school_id',c.school_id,'parent_id',c.parent_id,'linked_children',(select count(*) from public.student_parents where parent_id=c.parent_id),'replayed',true);end if;
 perform pg_advisory_xact_lock(hashtextextended('guardian-recovery-parent:'||c.parent_id::text,0));
 perform app_private.guardian_recovery_lock_officers(c.requester_id,c.reviewer_id,c.school_id);
 perform 1 from app_private.guardian_recovery_cases where id=c.id for update;
 if not found then raise exception 'This recovery link is unavailable.' using errcode='42501';end if;
 select * into c from app_private.guardian_recovery_cases where id=c.id;
 if c.status='accepted' and c.new_user_id=actor and exists(select 1 from public.parents where id=c.parent_id and profile_id=actor) then return jsonb_build_object('school_id',c.school_id,'parent_id',c.parent_id,'linked_children',(select count(*) from public.student_parents where parent_id=c.parent_id),'replayed',true);end if;
 if c.status<>'approved' or c.expires_at<=statement_timestamp() then raise exception 'This recovery link is unavailable.' using errcode='42501';end if;
 -- Lock and recheck the actual claimant before resolving a not-yet-created
 -- destination. Contact recycling between preview and acceptance cannot bind
 -- the case to a different native identity.
 perform 1 from auth.users where id=c.old_user_id or id=actor order by id for update;
 perform app_private.student_leave_actor();
 if not exists(select 1 from auth.users u where u.id=actor and
  case when c.channel='email' then u.email_confirmed_at is not null and lower(btrim(u.email))=c.contact
   else u.phone_confirmed_at is not null and app_private.guardian_e164_phone(u.phone)=c.contact end)
  or not app_private.guardian_recovery_officer_current(c.requester_id,c.school_id)
  or not app_private.guardian_recovery_officer_current(c.reviewer_id,c.school_id) then
  raise exception 'This recovery link is unavailable.' using errcode='42501';end if;
 snap:=app_private.guardian_recovery_snapshot(c.school_id,c.parent_id,c.new_user_id,c.channel,c.contact);
 if app_private.guardian_recovery_hash(snap)<>c.snapshot_hash then raise exception 'The reviewed guardian recovery changed. Ask the school for a new review.' using errcode='PT409';end if;
 perform 1 from auth.sessions where id=(auth.jwt()->>'session_id')::uuid and user_id=actor and(not_after is null or not_after>clock_timestamp()) for share;
 if not found or not app_private.has_live_school_session() or not app_private.staff_mfa_allowed() then raise exception 'A current verified replacement session is required.' using errcode='42501';end if;
 if c.requires_mfa and(auth.jwt()->>'aal' is distinct from 'aal2' or not app_private.staff_mfa_allowed()
  or not app_private.has_verified_staff_totp(actor)) then raise exception 'Verify a replacement authenticator before recovering this guardian access.' using errcode='42501';end if;
 accepted_time:=clock_timestamp();
 insert into app_private.guardian_recovery_recipient_history(parent_id,school_id,previous_user_id,through_at,case_id)
  values(c.parent_id,c.school_id,c.old_user_id,accepted_time,c.id);
 update public.parents set profile_id=actor,registered_mobile=(select case when phone_confirmed_at is not null then app_private.guardian_e164_phone(phone) end from auth.users where id=actor)
  where id=c.parent_id and school_id=c.school_id and profile_id=c.old_user_id;
 update public.profiles set school_id=c.school_id where id=actor;
 insert into public.user_roles(user_id,school_id,role) values(actor,c.school_id,'parent');
 delete from public.user_roles where user_id=c.old_user_id and role='parent' and school_id=c.school_id;
 update public.profiles set is_active=false where id=c.old_user_id;
 update app_private.guardian_invitations set revoked_at=accepted_time where accepted_at is null and revoked_at is null
  and school_id=c.school_id and(intended_user_id=c.old_user_id or email=c.snapshot#>>'{old_contact,email}'
    or phone=app_private.guardian_e164_phone(c.snapshot#>>'{old_contact,phone}'));
 update app_private.family_push_devices set generation=generation+case when revoked_at is null then 1 else 0 end,
  revoked_at=coalesce(revoked_at,accepted_time) where user_id=c.old_user_id and recipient_role='parent';
 update app_private.family_push_jobs set status='cancelled',finished_at=accepted_time,result_code='guardian_recovered'
  where user_id=c.old_user_id and recipient_role='parent' and status in('queued','leased');
 update app_private.family_push_preferences set enabled=false,version=version+1 where user_id=c.old_user_id and recipient_role='parent' and enabled;
 update app_private.guardian_recovery_cases set status='accepted',new_user_id=actor,accepted_at=accepted_time,version=version+1 where id=c.id;
 insert into app_private.guardian_recovery_audit(case_id,actor_id,action,reason) values(c.id,actor,'accepted','Verified replacement guardian accepted school access recovery');
 result:=jsonb_build_object('school_id',c.school_id,'parent_id',c.parent_id,'linked_children',jsonb_array_length(snap->'links'),'replayed',false);
 insert into app_private.guardian_recovery_receipts(actor_id,request_id,operation,payload_hash,response) values(actor,p_request_id,'accept',fingerprint,result);
 return result;end;$$;

-- A bounded past-owner alias preserves old read state without re-addressing
-- immutable events or exposing future events if the old login is ever reused.
create function app_private.guardian_recovery_recipient(p_recipient uuid,p_parent uuid,p_created_at timestamptz)
returns boolean language sql stable security definer set search_path=''
as $$select exists(select 1 from public.parents p join public.profiles profile on profile.id=p.profile_id and profile.is_active and profile.school_id=p.school_id
 where p.id=p_parent and p.profile_id=auth.uid() and(p_recipient=auth.uid() or exists(select 1 from app_private.guardian_recovery_recipient_history h
 where h.parent_id=p.id and h.school_id=p.school_id and h.previous_user_id=p_recipient and p_created_at<=h.through_at)));$$;
create function app_private.guardian_recovery_event_recipient(p_recipient uuid,p_school uuid,p_student uuid,p_created_at timestamptz,p_role text)
returns boolean language sql stable security definer set search_path=''
as $$select case when p_role='student' then p_recipient=auth.uid() when p_role='parent' then exists(
 select 1 from public.parents p join public.student_parents link on link.parent_id=p.id and link.student_id=p_student
 where p.school_id=p_school and app_private.guardian_recovery_recipient(p_recipient,p.id,p_created_at)) else false end;$$;

do $notification_updates$
declare definition text;signature text;
begin
 signature:='app_private.eligible_guardian_absence_alerts(uuid)';definition:=pg_get_functiondef(to_regprocedure(signature));
 if position('guardian.profile_id = a.recipient_user_id' in definition)=0 or position('a.recipient_user_id = (select auth.uid())' in definition)=0 then
  raise exception 'Review guardian absence eligibility before adding bounded recovery history.';end if;
 definition:=replace(definition,'guardian.profile_id = a.recipient_user_id','app_private.guardian_recovery_recipient(a.recipient_user_id,guardian.id,a.created_at)');
 definition:=replace(definition,'a.recipient_user_id = (select auth.uid())','guardian.profile_id = (select auth.uid())');execute definition;
 signature:='app_private.eligible_family_notifications(text)';definition:=pg_get_functiondef(to_regprocedure(signature));
 if position('event.recipient_user_id=auth.uid()' in definition)=0 or position('receiver.recipient_user_id=event.recipient_user_id' in definition)=0 then
  raise exception 'Review family notification eligibility before adding bounded recovery history.';end if;
 definition:=replace(definition,'event.recipient_user_id=auth.uid()','app_private.guardian_recovery_event_recipient(event.recipient_user_id,event.school_id,event.student_id,event.created_at,p_role)');
 definition:=replace(definition,'receiver.recipient_user_id=event.recipient_user_id','receiver.recipient_user_id=auth.uid()');execute definition;
 foreach signature in array array['app_private.mark_family_notification_read(text,text,uuid)','app_private.mark_all_family_notifications_read(text)',
  'app_private.mark_guardian_absence_alert_read(uuid)','app_private.mark_all_guardian_absence_alerts_read()'] loop
  definition:=pg_get_functiondef(to_regprocedure(signature));
  if position('eligible_' in definition)=0 then raise exception 'Reviewed notification eligibility is required for recovery read writes.';end if;
  definition:=replace(definition,'and event.recipient_user_id=actor','');
  definition:=replace(definition,'where event.recipient_user_id=actor and','where');
  definition:=replace(definition,'and a.recipient_user_id = (select auth.uid())','');
  definition:=regexp_replace(definition,'where alert\.recipient_user_id = \(select auth.uid\(\)\)[[:space:]]+and','where','g');
  execute definition;
 end loop;
end;$notification_updates$;

create function app_private.guardian_recovery_phone_schools(p_user_id uuid,p_phone text) returns setof uuid
language plpgsql security definer set search_path=''
as $$declare c app_private.guardian_recovery_cases%rowtype;begin
 for c in select * from app_private.guardian_recovery_cases where channel='phone' and contact=p_phone and status='approved'
  and expires_at>statement_timestamp() and(new_user_id is null or new_user_id=p_user_id) loop
  if app_private.guardian_recovery_officer_current(c.requester_id,c.school_id) and app_private.guardian_recovery_officer_current(c.reviewer_id,c.school_id)
   and app_private.guardian_phone_recipient_allowed(p_phone,c.school_id)
   and not exists(select 1 from auth.users u where u.id=p_user_id and app_private.guardian_e164_phone(u.phone) is distinct from p_phone)
   and not exists(select 1 from public.profiles p where p.id=p_user_id and(not p.is_active or(p.school_id is not null and p.school_id<>c.school_id)))
   and not exists(select 1 from public.user_roles r where r.user_id=p_user_id)
   and not exists(select 1 from public.parents p where p.profile_id=p_user_id)
   and not exists(select 1 from public.students s where s.profile_id=p_user_id)
   and not exists(select 1 from public.teachers t where t.profile_id=p_user_id) then
   begin
    if app_private.guardian_recovery_hash(app_private.guardian_recovery_snapshot(c.school_id,c.parent_id,c.new_user_id,c.channel,c.contact,false))=c.snapshot_hash then return next c.school_id;end if;
   exception when sqlstate '42501' or sqlstate '22023' then null;end;
  end if;
 end loop;
end;$$;
do $phone_budget$
declare definition text;
begin
 definition:=pg_get_functiondef('app_private.reserve_guardian_sms(uuid,text,text,integer,integer,integer)'::regprocedure);
 if position('  ) eligible;' in definition)=0 then raise exception 'Review the existing SMS school context before adding approved recovery.';end if;
 definition:=replace(definition,'  ) eligible;',E'    union\n    select recovery.school_id from app_private.guardian_recovery_phone_schools(p_user_id,p_phone) recovery(school_id)\n  ) eligible;');
 execute definition;
end;$phone_budget$;

create function public.get_guardian_recovery_workspace(p_school_id uuid,p_admission_no text default null) returns jsonb language sql security invoker set search_path=''
as $$select app_private.get_guardian_recovery_workspace(p_school_id,p_admission_no);$$;
create function public.request_guardian_account_recovery(p_school_id uuid,p_parent_id uuid,p_channel text,p_contact text,p_reason text,p_request_id uuid) returns jsonb language sql security invoker set search_path=''
as $$select app_private.request_guardian_account_recovery(p_school_id,p_parent_id,p_channel,p_contact,p_reason,p_request_id);$$;
create function public.review_guardian_account_recovery(p_case_id uuid,p_expected_version integer,p_decision text,p_reason text,p_request_id uuid,p_claim_token text default null) returns jsonb language sql security invoker set search_path=''
as $$select app_private.review_guardian_account_recovery(p_case_id,p_expected_version,p_decision,p_reason,p_request_id,p_claim_token);$$;
create function public.get_my_guardian_recovery_claim(p_token text) returns jsonb language sql security invoker set search_path=''
as $$select app_private.get_my_guardian_recovery_claim(p_token);$$;
create function public.accept_guardian_account_recovery(p_token text,p_request_id uuid) returns jsonb language sql security invoker set search_path=''
as $$select app_private.accept_guardian_account_recovery(p_token,p_request_id);$$;

do $access$
declare procedure record;
begin
 for procedure in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('app_private','public') and(p.proname like '%guardian%recovery%' or p.proname='guardian_recovery_hash') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',procedure.signature);
 end loop;
end;$access$;
grant execute on function app_private.get_guardian_recovery_workspace(uuid,text),public.get_guardian_recovery_workspace(uuid,text),
 app_private.request_guardian_account_recovery(uuid,uuid,text,text,text,uuid),public.request_guardian_account_recovery(uuid,uuid,text,text,text,uuid),
 app_private.review_guardian_account_recovery(uuid,integer,text,text,uuid,text),public.review_guardian_account_recovery(uuid,integer,text,text,uuid,text),
 app_private.get_my_guardian_recovery_claim(text),public.get_my_guardian_recovery_claim(text),
 app_private.accept_guardian_account_recovery(text,uuid),public.accept_guardian_account_recovery(text,uuid),
 app_private.guardian_recovery_recipient(uuid,uuid,timestamptz),app_private.guardian_recovery_event_recipient(uuid,uuid,uuid,timestamptz,text) to authenticated;
notify pgrst,'reload schema';
commit;
