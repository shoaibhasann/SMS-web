begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Reviewed debt posting is deliberately separate from cash collection.
create index students_fee_admission_lookup_idx on public.students(school_id,lower(btrim(admission_no)));

create table app_private.office_fee_batches (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id),
  request_id uuid not null,
  actor_id uuid not null,
  kind text not null check (kind in ('monthly','opening')),
  payload jsonb not null,
  preview_token text not null,
  result jsonb not null default '{}'::jsonb,
  posted_at timestamptz not null default clock_timestamp(),
  unique (school_id,request_id)
);
create index office_fee_batches_school_posted_idx
  on app_private.office_fee_batches (school_id,posted_at desc,id);

create table app_private.office_fee_opening_structures (
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id),
  fee_structure_id uuid not null unique references public.fee_structures(id),
  primary key (school_id,academic_year_id)
);

create table app_private.office_fee_openings (
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id),
  student_id uuid not null references public.students(id),
  student_fee_id uuid not null unique references public.student_fees(id),
  batch_id uuid not null references app_private.office_fee_batches(id),
  as_of_date date not null,
  source_reference text not null,
  reason text not null,
  primary key (school_id,academic_year_id,student_id)
);

create table app_private.office_fee_batch_items (
  batch_id uuid not null references app_private.office_fee_batches(id),
  student_fee_id uuid not null references public.student_fees(id),
  was_created boolean not null,
  snapshot jsonb not null,
  primary key (batch_id,student_fee_id)
);

alter table app_private.office_fee_batches enable row level security;
alter table app_private.office_fee_opening_structures enable row level security;
alter table app_private.office_fee_openings enable row level security;
alter table app_private.office_fee_batch_items enable row level security;
revoke all on app_private.office_fee_batches, app_private.office_fee_opening_structures,
  app_private.office_fee_openings, app_private.office_fee_batch_items
  from public,anon,authenticated,service_role;

create function app_private.guard_opening_fee_structure()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is not null and exists (
    select 1 from app_private.office_fee_opening_structures map where map.fee_structure_id=old.id
  ) then
    raise exception 'Opening-balance structures are managed by the reviewed opening-balance flow.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger guard_opening_fee_structure
  before update or delete on public.fee_structures
  for each row execute function app_private.guard_opening_fee_structure();

create function app_private.guard_opening_fee_debt()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is not null and exists (
    select 1 from app_private.office_fee_openings opening where opening.student_fee_id=old.id
  ) then
    raise exception 'Posted opening balances cannot be rewritten or deleted.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger guard_opening_fee_debt
  before delete or update of school_id,student_id,fee_structure_id,billing_period,due_date,amount,discount,late_fee,created_at
  on public.student_fees for each row execute function app_private.guard_opening_fee_debt();

create function app_private.preview_office_fee_batch(p_school_id uuid,p_kind text,p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  year_id uuid;
  year_row public.academic_years%rowtype;
  structure_id uuid;
  structure_row public.fee_structures%rowtype;
  scope_class_id uuid;
  scope_section_id uuid;
  billing_month date;
  due_date date;
  as_of_date date;
  source_reference text;
  reason text;
  row_info record;
  input_row jsonb;
  item jsonb;
  details jsonb := '[]'::jsonb;
  detail_items jsonb[] := '{}'::jsonb[];
  duplicate_admissions jsonb := '{}'::jsonb;
  visible_rows jsonb;
  existing_rows jsonb;
  existing_fee public.student_fees%rowtype;
  mapped_opening app_private.office_fee_openings%rowtype;
  mapped_student public.students%rowtype;
  mapped_enrollment public.enrollments%rowtype;
  mapped_class public.classes%rowtype;
  mapped_section public.sections%rowtype;
  match_count integer;
  active_count integer;
  item_number integer := 0;
  item_amount numeric;
  item_status text;
  item_message text;
  admission text;
  ready_count integer;
  existing_count integer;
  error_count integer;
  ready_amount numeric;
  existing_amount numeric;
  snapshot jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot prepare fee batches for this school.' using errcode='42501';
  end if;
  if p_kind is null or p_kind not in ('monthly','opening') or p_payload is null
    or jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>1048576 then
    raise exception 'Choose a supported fee batch and a bounded object payload.' using errcode='22023';
  end if;
  if (p_kind='monthly' and p_payload-array['academic_year_id','fee_structure_id','billing_period','due_date','class_id','section_id']<>'{}'::jsonb)
    or (p_kind='opening' and p_payload-array['academic_year_id','as_of_date','source_reference','reason','rows']<>'{}'::jsonb) then
    raise exception 'The fee batch contains unsupported fields.' using errcode='22023';
  end if;
  begin
    year_id := (p_payload->>'academic_year_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid current academic year.' using errcode='22023';
  end;
  select * into year_row from public.academic_years
    where id=year_id and school_id=p_school_id and is_current;
  if not found or year_row.start_date>year_row.end_date then
    raise exception 'Choose this school''s current academic year.' using errcode='22023';
  end if;

  if p_kind='monthly' then
    begin
      structure_id := (p_payload->>'fee_structure_id')::uuid;
      scope_class_id := (p_payload->>'class_id')::uuid;
      scope_section_id := (p_payload->>'section_id')::uuid;
      if coalesce(p_payload->>'billing_period','') !~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'
        or coalesce(p_payload->>'due_date','') !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'Choose a billing month and due date.' using errcode='22023';
      end if;
      billing_month := ((p_payload->>'billing_period')||'-01')::date;
      due_date := (p_payload->>'due_date')::date;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
      raise exception 'Choose valid fee, scope, billing month and due date values.' using errcode='22023';
    end;
    select * into structure_row from public.fee_structures
      where id=structure_id and school_id=p_school_id and academic_year_id=year_id;
    if not found or structure_row.frequency<>'monthly' or structure_row.amount<=0 or structure_row.amount='NaN'::numeric
      or exists(select 1 from app_private.office_fee_opening_structures os where os.fee_structure_id=structure_id)
      or billing_month>year_row.end_date or billing_month+interval '1 month'<=year_row.start_date
      or not isfinite(due_date) or due_date<year_row.start_date or due_date>year_row.end_date or due_date<billing_month then
      raise exception 'Choose a positive monthly structure and dates within its current academic year.' using errcode='22023';
    end if;
    if scope_class_id is not null and not exists(select 1 from public.classes c where c.id=scope_class_id and c.school_id=p_school_id and c.is_active)
      or scope_section_id is not null and (scope_class_id is null or not exists(select 1 from public.sections s where s.id=scope_section_id and s.school_id=p_school_id and s.class_id=scope_class_id))
      or structure_row.class_id is not null and scope_class_id is not null and structure_row.class_id<>scope_class_id then
      raise exception 'Choose a matching school class and section.' using errcode='22023';
    end if;
    for row_info in
      select student.*,enrollment.id as enrollment_id,enrollment.class_id as enrolled_class_id,
        enrollment.section_id as enrolled_section_id,cls.name as class_name,cls.is_active as class_active,
        cls.school_id as class_school,section.name as section_name,section.school_id as section_school,
        section.class_id as section_class,
        (select count(*) from public.enrollments all_enrollment where all_enrollment.student_id=student.id
          and all_enrollment.academic_year_id=year_id and all_enrollment.status='active') as enrollment_count
      from public.students student
      join public.enrollments enrollment on enrollment.student_id=student.id and enrollment.academic_year_id=year_id and enrollment.status='active'
      left join public.classes cls on cls.id=enrollment.class_id
      left join public.sections section on section.id=enrollment.section_id
      where student.school_id=p_school_id and student.status='active'
        and (structure_row.class_id is null or enrollment.class_id=structure_row.class_id)
        and (scope_class_id is null or enrollment.class_id=scope_class_id)
        and (scope_section_id is null or enrollment.section_id=scope_section_id)
      order by student.id,enrollment.id
      limit 1501
    loop
      item_number := item_number+1;
      if item_number>1500 then raise exception 'A fee batch supports at most 1,500 pupils. Narrow the class scope.' using errcode='22023'; end if;
      select coalesce(jsonb_agg(to_jsonb(sf) order by sf.id),'[]'::jsonb) into existing_rows
        from public.student_fees sf where sf.student_id=row_info.id and sf.fee_structure_id=structure_id
          and sf.billing_period=p_payload->>'billing_period';
      existing_fee := null;
      if jsonb_array_length(existing_rows)=1 then
        select * into existing_fee from jsonb_populate_record(null::public.student_fees,existing_rows->0);
      end if;
      item_status := case when jsonb_array_length(existing_rows)=0 then 'ready' else 'existing' end;
      item_message := case when item_status='ready' then 'New monthly demand.' else 'Existing demand retained without changes.' end;
      item_amount := case when item_status='ready' then structure_row.amount else existing_fee.amount end;
      if row_info.enrollment_count<>1 or row_info.class_school is distinct from p_school_id or not coalesce(row_info.class_active,false)
        or row_info.section_school is distinct from p_school_id or row_info.section_class is distinct from row_info.enrolled_class_id then
        item_status := 'error'; item_message := 'Review this pupil''s active class and section mapping.';
      elsif jsonb_array_length(existing_rows)>1 or (existing_fee.id is not null and (existing_fee.school_id<>p_school_id
        or existing_fee.amount<0 or existing_fee.amount='NaN'::numeric or existing_fee.discount<0
        or existing_fee.discount='NaN'::numeric or existing_fee.late_fee<0 or existing_fee.late_fee='NaN'::numeric)) then
        item_status := 'error'; item_message := 'Review duplicate or invalid existing demands before posting.';
      end if;
      if item_amount='NaN'::numeric or item_amount<0 then item_amount:=null; end if;
      detail_items := array_append(detail_items,jsonb_build_object(
        'row_number',item_number,'student_id',row_info.id,'admission_no',row_info.admission_no,
        'student_name',concat_ws(' ',row_info.first_name,row_info.middle_name,row_info.last_name),
        'class_name',row_info.class_name,'section_name',row_info.section_name,'amount',item_amount,
        'status',item_status,'message',item_message,'demand_id',existing_fee.id,
        '_snapshot',jsonb_build_object('enrollment_id',row_info.enrollment_id,'class_id',row_info.enrolled_class_id,
          'section_id',row_info.enrolled_section_id,'enrollment_count',row_info.enrollment_count,
          'class_active',row_info.class_active,'existing',(select coalesce(jsonb_agg(value-'status'),'[]'::jsonb) from jsonb_array_elements(existing_rows)))));
    end loop;
  else
    begin
      if coalesce(p_payload->>'as_of_date','') !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'Choose an opening balance date.' using errcode='22023';
      end if;
      as_of_date := (p_payload->>'as_of_date')::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'Choose a valid opening balance date.' using errcode='22023';
    end;
    source_reference := btrim(p_payload->>'source_reference'); reason := btrim(p_payload->>'reason');
    if not isfinite(as_of_date) or as_of_date<year_row.start_date or as_of_date>year_row.end_date
      or as_of_date>(statement_timestamp() at time zone 'Asia/Kolkata')::date
      or coalesce(length(source_reference),0) not between 1 and 120 or coalesce(length(reason),0) not between 1 and 500
      or jsonb_typeof(p_payload->'rows') is distinct from 'array' then
      raise exception 'Use a current-year date up to today, a source reference, reason and opening-balance rows.' using errcode='22023';
    end if;
    if jsonb_array_length(p_payload->'rows') not between 1 and 1500 then
      raise exception 'An opening balance batch needs between 1 and 1,500 rows.' using errcode='22023';
    end if;
    select coalesce(jsonb_object_agg(duplicates.admission,true),'{}'::jsonb) into duplicate_admissions
      from (select lower(btrim(value->>'admission_no')) as admission from jsonb_array_elements(p_payload->'rows')
        where jsonb_typeof(value)='object' and jsonb_typeof(value->'admission_no')='string'
        group by lower(btrim(value->>'admission_no')) having count(*)>1) duplicates;
    for input_row in select value from jsonb_array_elements(p_payload->'rows') loop
      item_number := item_number+1;
      item_status := 'ready'; item_message := 'New opening outstanding debt; no receipt is created.'; item_amount := null;
      admission := btrim(input_row->>'admission_no');
      mapped_student := null; mapped_enrollment := null; mapped_class := null; mapped_section := null;
      mapped_opening := null; existing_fee := null;
      if jsonb_typeof(input_row)<>'object' then
        item_status := 'error'; item_message := 'Each opening balance row must be an object.';
      elsif input_row-array['admission_no','amount']<>'{}'::jsonb
        or jsonb_typeof(input_row->'admission_no') is distinct from 'string'
        or coalesce(length(admission),0) not between 1 and 100 then
        item_status := 'error'; item_message := 'Enter a valid admission number and amount only.';
      elsif jsonb_typeof(input_row->'amount') is distinct from 'string'
        or coalesce(input_row->>'amount','') !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then
        item_status := 'error'; item_message := 'Enter a positive decimal amount with up to two decimal places.';
      else
        item_amount := (input_row->>'amount')::numeric;
        if item_amount<=0 or item_amount>9999999999.99 then
          item_status := 'error'; item_message := 'The opening balance must be positive and within the supported amount.';
        end if;
      end if;
      if item_status='ready' then
        if duplicate_admissions ? lower(admission) then item_status:='error'; item_message:='The admission number appears more than once in this batch.'; end if;
      end if;
      if item_status='ready' then
        select count(*) into match_count from public.students s where s.school_id=p_school_id and lower(btrim(s.admission_no))=lower(admission);
        if match_count<>1 then
          item_status:='error'; item_message:='Admission number is missing or ambiguous in this school.';
        else
          select * into mapped_student from public.students s where s.school_id=p_school_id and lower(btrim(s.admission_no))=lower(admission);
          select count(*) into active_count from public.enrollments e where e.student_id=mapped_student.id and e.academic_year_id=year_id and e.status='active';
          if mapped_student.status<>'active' or active_count<>1 then
            item_status:='error'; item_message:='This pupil needs exactly one active current-year enrollment.';
          else
            select * into mapped_enrollment from public.enrollments e where e.student_id=mapped_student.id and e.academic_year_id=year_id and e.status='active';
            select * into mapped_class from public.classes c where c.id=mapped_enrollment.class_id;
            select * into mapped_section from public.sections s where s.id=mapped_enrollment.section_id;
            if mapped_class.school_id is distinct from p_school_id or not coalesce(mapped_class.is_active,false)
              or mapped_section.school_id is distinct from p_school_id or mapped_section.class_id is distinct from mapped_class.id then
              item_status:='error'; item_message:='Review this pupil''s class and section mapping.';
            end if;
          end if;
        end if;
      end if;
      if item_status='ready' then
        select * into mapped_opening from app_private.office_fee_openings o
          where o.school_id=p_school_id and o.academic_year_id=year_id and o.student_id=mapped_student.id;
        if found then
          select * into existing_fee from public.student_fees sf where sf.id=mapped_opening.student_fee_id;
          if not found or existing_fee.school_id<>p_school_id or existing_fee.student_id<>mapped_student.id
            or existing_fee.amount<=0 or existing_fee.amount='NaN'::numeric then
            item_status:='error'; item_message:='Review the existing opening balance before posting.';
          else
            item_status:='existing'; item_message:='This pupil already has a posted opening balance for this year; it is retained.';
            item_amount:=existing_fee.amount;
          end if;
        end if;
      end if;
      detail_items := array_append(detail_items,jsonb_build_object(
        'row_number',item_number,'student_id',mapped_student.id,'admission_no',coalesce(mapped_student.admission_no,admission,''),
        'student_name',coalesce(nullif(concat_ws(' ',mapped_student.first_name,mapped_student.middle_name,mapped_student.last_name),''),'Unmatched pupil'),
        'class_name',mapped_class.name,'section_name',mapped_section.name,'amount',item_amount,'status',item_status,
        'message',item_message,'demand_id',existing_fee.id,
        '_snapshot',jsonb_build_object('enrollment_id',mapped_enrollment.id,'student_status',mapped_student.status,
          'class_id',mapped_enrollment.class_id,'section_id',mapped_enrollment.section_id,'class_active',mapped_class.is_active,
          'existing_opening',to_jsonb(mapped_opening),'existing_demand',to_jsonb(existing_fee)-'status')));
    end loop;
  end if;

  details:=to_jsonb(detail_items);
  select count(*) filter(where value->>'status'='ready'),count(*) filter(where value->>'status'='existing'),
    count(*) filter(where value->>'status'='error'),coalesce(sum((value->>'amount')::numeric) filter(where value->>'status'='ready'),0),
    coalesce(sum((value->>'amount')::numeric) filter(where value->>'status'='existing'),0),
    coalesce(jsonb_agg(value-'_snapshot' order by (value->>'row_number')::integer),'[]'::jsonb)
  into ready_count,existing_count,error_count,ready_amount,existing_amount,visible_rows from jsonb_array_elements(details);
  snapshot := jsonb_build_object('school_id',p_school_id,'actor_id',auth.uid(),'kind',p_kind,'payload',p_payload,
    'year',to_jsonb(year_row),'structure',case when p_kind='monthly' then to_jsonb(structure_row) else null end,'rows',details);
  return jsonb_build_object('kind',p_kind,'academic_year_id',year_id,'preview_token',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),'rows',visible_rows,
    'summary',jsonb_build_object('ready_count',ready_count,'existing_count',existing_count,'error_count',error_count,
      'ready_amount',ready_amount,'existing_amount',existing_amount,'total_amount',ready_amount+existing_amount),
    'can_post',ready_count>0 and error_count=0);
end;
$$;

create function app_private.post_office_fee_batch(
  p_school_id uuid,p_kind text,p_payload jsonb,p_preview_token text,p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid:=auth.uid();
  actor_name text;
  previous app_private.office_fee_batches%rowtype;
  preview jsonb;
  item jsonb;
  lock_student uuid;
  year_id uuid;
  opening_structure_id uuid;
  demand_id uuid;
  batch_id uuid:=gen_random_uuid();
  posted_at timestamptz:=clock_timestamp();
  posted_result jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot post fee batches for this school.' using errcode='42501';
  end if;
  -- Pin authority while the reviewed financial operation is being committed.
  select full_name into actor_name from public.profiles where id=actor_id and is_active for share;
  if not found then raise exception 'Your active finance account could not be verified.' using errcode='42501'; end if;
  perform 1 from public.user_roles ur where ur.user_id=actor_id
    and ((ur.school_id=p_school_id and ur.role in ('school_admin','principal','accountant'))
      or (ur.school_id is null and ur.role='super_admin')) order by ur.id for share;
  if not found then raise exception 'Your school finance permission has changed.' using errcode='42501'; end if;
  if p_request_id is null or coalesce(p_preview_token,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Review the batch before posting it.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-fee-batch-request:'||p_school_id::text||':'||p_request_id::text,0));
  select * into previous from app_private.office_fee_batches where school_id=p_school_id and request_id=p_request_id;
  if found then
    if previous.actor_id<>actor_id or previous.kind is distinct from p_kind or previous.payload is distinct from p_payload
      or previous.preview_token is distinct from p_preview_token then
      raise exception 'This fee batch request already posted a different reviewed payload.' using errcode='23505';
    end if;
    return previous.result;
  end if;
  preview:=app_private.preview_office_fee_batch(p_school_id,p_kind,p_payload);
  year_id:=(preview->>'academic_year_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('office-fee-batch-school-year:'||p_school_id::text||':'||year_id::text,0));

  -- Match the existing single-demand lock BEFORE taking roster/year locks.
  -- This prevents duplicate billing and avoids a lock-order inversion with it.
  for lock_student in select distinct (value->>'student_id')::uuid from jsonb_array_elements(preview->'rows')
    where value->>'student_id' is not null order by 1 loop
    if p_kind='monthly' then
      perform pg_advisory_xact_lock(hashtextextended('office-fee-demand:'||lock_student::text||':'||
        (p_payload->>'fee_structure_id')||':'||(p_payload->>'billing_period'),0));
    else
      perform pg_advisory_xact_lock(hashtextextended('office-fee-opening:'||p_school_id::text||':'||year_id::text||':'||lock_student::text,0));
    end if;
  end loop;
  -- Take a compatible year share lock before dependent roster locks, matching
  -- placement/activation ordering without inverting withdrawal's joined locks.
  -- New admissions after the final selected-set read belong to a later batch.
  perform 1 from public.academic_years y where y.id=year_id and y.school_id=p_school_id for share;
  perform 1 from public.students s where s.school_id=p_school_id order by s.id for share;
  perform 1 from public.enrollments e join public.students s on s.id=e.student_id and s.school_id=p_school_id
    where e.academic_year_id=year_id order by e.id for share of e;
  perform 1 from public.classes c where c.school_id=p_school_id order by c.id for share;
  perform 1 from public.sections s where s.school_id=p_school_id order by s.id for share;
  if p_kind='monthly' then
    perform 1 from public.fee_structures fs where fs.id=(p_payload->>'fee_structure_id')::uuid for share;
  end if;
  preview:=app_private.preview_office_fee_batch(p_school_id,p_kind,p_payload);
  if preview->>'preview_token'<>p_preview_token then
    raise exception 'The reviewed roster, fee structure or existing demands changed. Preview the batch again.' using errcode='PT409';
  end if;
  if not (preview->>'can_post')::boolean then
    raise exception 'Resolve row errors and include at least one new demand before posting.' using errcode='22023';
  end if;

  insert into app_private.office_fee_batches(id,school_id,academic_year_id,request_id,actor_id,kind,payload,preview_token,posted_at)
    values(batch_id,p_school_id,year_id,p_request_id,actor_id,p_kind,p_payload,p_preview_token,posted_at);
  if p_kind='opening' then
    select map.fee_structure_id into opening_structure_id from app_private.office_fee_opening_structures map
      where map.school_id=p_school_id and map.academic_year_id=year_id;
    if not found then
      insert into public.fee_structures(school_id,academic_year_id,class_id,name,frequency,amount)
        values(p_school_id,year_id,null,'Opening balance','one_time',0) returning id into opening_structure_id;
      insert into app_private.office_fee_opening_structures(school_id,academic_year_id,fee_structure_id)
        values(p_school_id,year_id,opening_structure_id);
    end if;
  end if;
  for item in select value from jsonb_array_elements(preview->'rows') order by value->>'student_id' loop
    if item->>'status'='ready' then
      if p_kind='monthly' then
        demand_id:=app_private.issue_office_fee_demand(p_school_id,(item->>'student_id')::uuid,
          (p_payload->>'fee_structure_id')::uuid,p_payload->>'billing_period',(p_payload->>'due_date')::date);
      else
        insert into public.student_fees(school_id,student_id,fee_structure_id,billing_period,due_date,amount)
          values(p_school_id,(item->>'student_id')::uuid,opening_structure_id,'OPENING:'||year_id::text,
            (p_payload->>'as_of_date')::date,(item->>'amount')::numeric) returning id into demand_id;
        insert into app_private.office_fee_openings(school_id,academic_year_id,student_id,student_fee_id,batch_id,as_of_date,source_reference,reason)
          values(p_school_id,year_id,(item->>'student_id')::uuid,demand_id,batch_id,(p_payload->>'as_of_date')::date,
            btrim(p_payload->>'source_reference'),btrim(p_payload->>'reason'));
      end if;
    else
      demand_id:=(item->>'demand_id')::uuid;
    end if;
    insert into app_private.office_fee_batch_items(batch_id,student_fee_id,was_created,snapshot)
      values(batch_id,demand_id,item->>'status'='ready',item);
  end loop;
  posted_result:=jsonb_build_object('batch_id',batch_id,'kind',p_kind,'academic_year_id',year_id,'posted_at',posted_at,
    'posted_by_name',coalesce(actor_name,'Office user'),'created_count',(preview->'summary'->>'ready_count')::integer,
    'existing_count',(preview->'summary'->>'existing_count')::integer,'total_amount',(preview->'summary'->>'ready_amount')::numeric,
    'source_reference',case when p_kind='opening' then btrim(p_payload->>'source_reference') else null end,
    'reason',case when p_kind='opening' then btrim(p_payload->>'reason') else null end,
    'billing_period',case when p_kind='monthly' then p_payload->>'billing_period' else null end);
  update app_private.office_fee_batches b set result=posted_result where b.id=batch_id;
  return posted_result;
end;
$$;

create function app_private.list_office_fee_batches(p_school_id uuid,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare history_result jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot view fee batches for this school.' using errcode='42501';
  end if;
  if p_limit is null or p_limit not between 1 and 50 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid batch-history page.' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(b.result order by b.posted_at desc,b.id),'[]'::jsonb) into history_result
    from (select result,posted_at,id from app_private.office_fee_batches where school_id=p_school_id
      order by posted_at desc,id limit p_limit offset p_offset) b;
  return history_result;
end;
$$;

create function app_private.get_office_fee_ledger(
  p_school_id uuid,p_year_id uuid,p_student_id uuid,p_limit integer,p_offset integer
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot view the fee ledger for this school.' using errcode='42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 or p_offset is null or p_offset<0 or p_offset>1000000 then
    raise exception 'Choose a valid fee-ledger page.' using errcode='22023';
  end if;
  if (p_year_id is not null and not exists(select 1 from public.academic_years y where y.id=p_year_id and y.school_id=p_school_id))
    or (p_student_id is not null and not exists(select 1 from public.students s where s.id=p_student_id and s.school_id=p_school_id)) then
    raise exception 'The ledger filter is outside this school.' using errcode='42501';
  end if;
  with source as materialized (
    select sf.*,student.admission_no,concat_ws(' ',student.first_name,student.middle_name,student.last_name) as student_name,
      year.id as academic_year_id,year.name as academic_year_name,structure.name as fee_name,
      case when opening.student_fee_id is not null then 'opening' when structure.frequency='monthly' then 'monthly' else 'structure' end as kind,
      opening.as_of_date,opening.source_reference,opening.reason,
      sf.amount-sf.discount+sf.late_fee as net,
      coalesce(paid.total,0) as paid_total,
      student.id is null or structure.id is null or year.id is null or sf.amount<0 or sf.amount='NaN'::numeric
        or sf.discount<0 or sf.discount='NaN'::numeric or sf.late_fee<0 or sf.late_fee='NaN'::numeric
        or sf.amount-sf.discount+sf.late_fee<0 or coalesce(paid.invalid_count,0)>0
        or coalesce(paid.total,0)>sf.amount-sf.discount+sf.late_fee
        or sf.status::text not in ('pending','partial','paid') as invalid
    from public.student_fees sf
    left join public.students student on student.id=sf.student_id and student.school_id=sf.school_id
    left join public.fee_structures structure on structure.id=sf.fee_structure_id and structure.school_id=sf.school_id
    left join public.academic_years year on year.id=structure.academic_year_id and year.school_id=sf.school_id
    left join app_private.office_fee_openings opening on opening.student_fee_id=sf.id
    left join lateral (
      select coalesce(sum(p.amount) filter(where p.status='paid' and p.amount>0 and p.amount<>'NaN'::numeric),0) as total,
        count(*) filter(where p.school_id<>sf.school_id or p.student_id<>sf.student_id
          or (p.status='paid' and (p.amount<=0 or p.amount='NaN'::numeric or p.paid_at is null))) as invalid_count
      from public.fee_payments p where p.student_fee_id=sf.id
    ) paid on true
    where sf.school_id=p_school_id and (p_student_id is null or sf.student_id=p_student_id)
      and (p_year_id is null or year.id=p_year_id or year.id is null)
  ), page as (
    select jsonb_build_object('demand_id',id,'student_id',student_id,'admission_no',admission_no,
      'student_name',student_name,'academic_year_id',academic_year_id,'academic_year_name',academic_year_name,
      'fee_name',coalesce(fee_name,'Unassigned legacy charge'),'kind',kind,'billing_period',billing_period,'due_date',due_date,
      'amount',case when not invalid then amount end,'discount',case when not invalid then discount end,
      'late_fee',case when not invalid then late_fee end,'net_amount',case when not invalid then net end,
      'paid_amount',case when not invalid then paid_total end,'balance',case when not invalid then net-paid_total end,
      'status',case when invalid then 'review_required' when net=paid_total then 'paid' when paid_total>0 then 'partial' else 'pending' end,
      'as_of_date',as_of_date,'source_reference',source_reference,'reason',reason,'invalid',invalid) as row,
      due_date,created_at,id
    from source order by due_date nulls last,created_at,id limit p_limit offset p_offset
  )
  select jsonb_build_object('academic_year_id',p_year_id,'limit',p_limit,'offset',p_offset,
    'rows',coalesce((select jsonb_agg(row order by due_date nulls last,created_at,id) from page),'[]'::jsonb),
    'summary',jsonb_build_object('demand_count',count(*),'invalid_count',count(*) filter(where invalid),
      'net_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net),0) end,
      'paid_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(paid_total),0) end,
      'balance',case when count(*) filter(where invalid)=0 then coalesce(sum(net-paid_total),0) end,
      'opening_amount',case when count(*) filter(where invalid)=0 then coalesce(sum(net) filter(where kind='opening'),0) end))
    into result from source;
  return result;
end;
$$;

create function public.preview_office_fee_batch(p_school_id uuid,p_kind text,p_payload jsonb)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.preview_office_fee_batch(p_school_id,p_kind,p_payload); $$;
create function public.post_office_fee_batch(p_school_id uuid,p_kind text,p_payload jsonb,p_preview_token text,p_request_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.post_office_fee_batch(p_school_id,p_kind,p_payload,p_preview_token,p_request_id); $$;
create function public.list_office_fee_batches(p_school_id uuid,p_limit integer default 20,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.list_office_fee_batches(p_school_id,p_limit,p_offset); $$;
create function public.get_office_fee_ledger(p_school_id uuid,p_year_id uuid default null,p_student_id uuid default null,p_limit integer default 50,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.get_office_fee_ledger(p_school_id,p_year_id,p_student_id,p_limit,p_offset); $$;

revoke all on function app_private.guard_opening_fee_structure(),app_private.guard_opening_fee_debt()
  from public,anon,authenticated,service_role;
revoke all on function app_private.preview_office_fee_batch(uuid,text,jsonb),public.preview_office_fee_batch(uuid,text,jsonb),
  app_private.post_office_fee_batch(uuid,text,jsonb,text,uuid),public.post_office_fee_batch(uuid,text,jsonb,text,uuid),
  app_private.list_office_fee_batches(uuid,integer,integer),public.list_office_fee_batches(uuid,integer,integer),
  app_private.get_office_fee_ledger(uuid,uuid,uuid,integer,integer),public.get_office_fee_ledger(uuid,uuid,uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function app_private.preview_office_fee_batch(uuid,text,jsonb),public.preview_office_fee_batch(uuid,text,jsonb),
  app_private.post_office_fee_batch(uuid,text,jsonb,text,uuid),public.post_office_fee_batch(uuid,text,jsonb,text,uuid),
  app_private.list_office_fee_batches(uuid,integer,integer),public.list_office_fee_batches(uuid,integer,integer),
  app_private.get_office_fee_ledger(uuid,uuid,uuid,integer,integer),public.get_office_fee_ledger(uuid,uuid,uuid,integer,integer)
  to authenticated;

commit;
