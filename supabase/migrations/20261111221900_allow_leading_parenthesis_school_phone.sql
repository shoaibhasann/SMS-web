-- Accept office phones that open with an STD code in brackets, e.g. (0522) 2345678; '+(' stays rejected.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create or replace function app_private.save_school_settings(p_school_id uuid,p_expected_revision integer,p_request_id uuid,p_details jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=app_private.school_settings_actor(p_school_id,true);
  previous public.schools%rowtype;
  receipt app_private.school_settings_receipts%rowtype;
  fields text[]:=array['name','board','affiliation_no','address','city','state','pincode','phone','email','website'];
  field text; value text; normalized jsonb:='{}'; before_details jsonb; changed_fields text[];
  reason text:=btrim(p_reason); payload jsonb;
  revision integer; changed boolean; authority text;
begin
  if p_request_id is null or p_expected_revision is null or p_expected_revision<0
    or reason is null or char_length(reason) not between 5 and 300 or reason~'[[:cntrl:]]'
    or p_details is null or jsonb_typeof(p_details)<>'object' then
    raise exception 'Reload school settings and enter valid details with a change reason.' using errcode='22023'; end if;
  if(select count(*) from jsonb_object_keys(p_details))<>cardinality(fields)
    or exists(select 1 from jsonb_object_keys(p_details) key where not key=any(fields)) then
    raise exception 'Only the supported school profile fields may be changed.' using errcode='22023'; end if;
  foreach field in array fields loop
    if jsonb_typeof(p_details->field) not in('string','null') then
      raise exception 'Enter school profile fields as text or empty values.' using errcode='22023'; end if;
    value:=nullif(btrim(p_details->>field),'');
    if field='address' then value:=replace(replace(value,E'\r\n',E'\n'),E'\r',E'\n'); end if;
    if (case when field='address' then replace(value,E'\n','') else value end)~'[[:cntrl:]]'
      or char_length(value)>(case field when 'name' then 160 when 'address' then 1000
        when 'phone' then 24 when 'email' then 254 when 'website' then 300 else 100 end) then
      raise exception 'A school profile field contains unsupported characters or is too long.' using errcode='22023'; end if;
    if field='name' and(value is null or char_length(value)<2) then raise exception 'Enter a school name of 2 to 160 characters.' using errcode='22023'; end if;
    if field='board' and value is not null and value not in('CBSE','UP_BOARD') then raise exception 'Choose an available school board.' using errcode='22023'; end if;
    if field='pincode' and value is not null and value!~'^[0-9]{6}$' then raise exception 'Enter a six-digit pincode.' using errcode='22023'; end if;
    if field='phone' and value is not null and(value!~'^(\+[0-9]|[0-9(])[0-9 ()-]*$'
      or char_length(regexp_replace(value,'[^0-9]','','g')) not between 7 and 15) then
      raise exception 'Enter a valid school office phone number.' using errcode='22023'; end if;
    if field='email' and value is not null then
      if value!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid school email address.' using errcode='22023'; end if;
      value:=lower(value);
    end if;
    if field='website' and value is not null then
      authority:=substring(value from '^https://([^/?#]+)');
      if value~'[[:space:]\\]' or authority is null or authority!~'^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
        or(authority~':[0-9]+$' and split_part(authority,':',2)::integer not between 1 and 65535) then
        raise exception 'Use an HTTPS website without credentials or spaces.' using errcode='22023'; end if;
    end if;
    normalized:=normalized||jsonb_build_object(field,value);
  end loop;
  payload:=jsonb_build_object('school_id',p_school_id,'expected_revision',p_expected_revision,'details',p_details,'reason',p_reason);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from app_private.school_settings_receipts where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload<>payload then raise exception 'This settings retry belongs to different input.' using errcode='PT409'; end if;
    return jsonb_build_object('revision',receipt.revision,'changed',receipt.changed,'replayed',true);
  end if;
  select * into previous from public.schools where id=p_school_id;
  if previous.settings_revision<>p_expected_revision then raise exception 'School settings changed. Reload before saving.' using errcode='PT409'; end if;
  select jsonb_object_agg(item.key,item.value) into before_details from jsonb_each(to_jsonb(previous)) item where item.key=any(fields);
  select coalesce(array_agg(item.field order by item.field),'{}'::text[]) into changed_fields from unnest(fields) item(field)
    where before_details->item.field is distinct from normalized->item.field;
  changed:=cardinality(changed_fields)>0; revision:=previous.settings_revision;
  if changed then
    if revision=2147483647 then raise exception 'The school settings revision limit requires administrator support.' using errcode='22023'; end if;
    revision:=revision+1;
    update public.schools set name=normalized->>'name',board=(normalized->>'board')::public.board_type,
      affiliation_no=normalized->>'affiliation_no',address=normalized->>'address',city=normalized->>'city',state=normalized->>'state',
      pincode=normalized->>'pincode',phone=normalized->>'phone',email=normalized->>'email',website=normalized->>'website',
      settings_revision=revision,updated_at=clock_timestamp() where id=p_school_id;
    insert into app_private.school_settings_audit(school_id,revision,actor_id,request_id,before_details,after_details,changed_fields,reason)
      values(p_school_id,revision,actor,p_request_id,before_details,normalized,changed_fields,reason);
  end if;
  insert into app_private.school_settings_receipts(actor_id,request_id,school_id,payload,revision,changed)
    values(actor,p_request_id,p_school_id,payload,revision,changed);
  return jsonb_build_object('revision',revision,'changed',changed,'replayed',false);
end;
$function$;
revoke all on function app_private.save_school_settings(uuid,integer,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function app_private.save_school_settings(uuid,integer,uuid,jsonb,text) to authenticated;

commit;
