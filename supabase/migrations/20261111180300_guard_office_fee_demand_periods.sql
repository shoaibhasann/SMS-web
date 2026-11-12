begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Single fee demands honour the structure frequency (yearly/one-time once per session,
-- quarterly/half-yearly once per period), and a pupil moved between classes is not billed the
-- same fee head twice (single demand and batch preview). The fee head is the structure name
-- (the office UI picks it from a fixed Fee Category list), compared as lower(btrim(name)):
-- a class-wise monthly head bills once per billing month, a yearly/one-time head once per session.
-- 'Other' can hold several different fees, so it is never treated as a duplicate of another
-- structure (it may double-bill in a move month, but never under-bills); the same structure is
-- still billed once.
create or replace function app_private.issue_office_fee_demand(
  p_school_id uuid,
  p_student_id uuid,
  p_fee_structure_id uuid,
  p_billing_period text,
  p_due_date date
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  structure public.fee_structures%rowtype;
  existing_ids uuid[];
  demand_id uuid;
  billing_month date;
  year_start date;
  window_months integer;
  other_name text;
  fee_head text;
begin
  if not app_private.can_manage_office_fees(p_school_id) then
    raise exception 'You cannot issue fee demands for this school.' using errcode = '42501';
  end if;
  if p_billing_period is null or p_billing_period !~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$' then
    raise exception 'Choose a valid billing month.' using errcode = '22023';
  end if;
  if p_student_id is null or p_fee_structure_id is null then
    raise exception 'Choose a student and fee structure.' using errcode = '22023';
  end if;
  billing_month := pg_catalog.make_date(
    pg_catalog.substring(p_billing_period, 1, 4)::integer,
    pg_catalog.substring(p_billing_period, 6, 2)::integer,
    1
  );

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'office-fee-demand:' || p_student_id::text || ':' || p_fee_structure_id::text || ':' || p_billing_period, 0
  ));
  select fs.* into structure
  from public.fee_structures fs
  join public.academic_years y on y.id = fs.academic_year_id and y.school_id = fs.school_id and y.is_current
    and billing_month <= y.end_date and billing_month + interval '1 month' > y.start_date
  join public.students student on student.id = p_student_id and student.school_id = fs.school_id
    and student.status = 'active'
  join public.enrollments enrollment on enrollment.student_id = student.id
    and enrollment.academic_year_id = y.id and enrollment.status = 'active'
  join public.classes cls on cls.id = enrollment.class_id and cls.school_id = fs.school_id
  where fs.id = p_fee_structure_id and fs.school_id = p_school_id
    and (fs.class_id is null or fs.class_id = enrollment.class_id)
  for share of fs, y, student, enrollment, cls;
  if not found then
    raise exception 'Choose an active student, a matching current-year structure, and a month in that school year.' using errcode = '22023';
  end if;

  select array_agg(id) into existing_ids from public.student_fees
  where student_id = p_student_id and fee_structure_id = p_fee_structure_id and billing_period = p_billing_period;
  if existing_ids is not null then
    if pg_catalog.cardinality(existing_ids) <> 1 or not exists (
      select 1 from public.student_fees
      where id = existing_ids[1] and school_id = p_school_id and due_date is not distinct from p_due_date
    ) then
      raise exception 'Review the existing demand for this fee and billing month.' using errcode = '23505';
    end if;
    return existing_ids[1];
  end if;
  fee_head := pg_catalog.lower(pg_catalog.btrim(structure.name));
  if structure.frequency in ('yearly', 'one_time', 'quarterly', 'half_yearly') then
    -- Taken after the per-period lock, so the lock order stays period -> structure.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'office-fee-demand:' || p_student_id::text || ':' || p_fee_structure_id::text, 0
    ));
    select y.start_date into year_start from public.academic_years y where y.id = structure.academic_year_id;
    window_months := case structure.frequency when 'quarterly' then 3 when 'half_yearly' then 6 end;
    -- Yearly/one-time: once per structure (a structure belongs to one session).
    -- Quarterly/half-yearly: once per 3/6-month window counted from the session's start month.
    if exists (
      select 1 from public.student_fees sf
      where sf.student_id = p_student_id and sf.fee_structure_id = p_fee_structure_id
        and sf.billing_period is distinct from p_billing_period
        and (window_months is null or (
          sf.billing_period ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])$'
          and pg_catalog.div(
            pg_catalog.substring(sf.billing_period, 1, 4)::integer * 12 + pg_catalog.substring(sf.billing_period, 6, 2)::integer
              - (pg_catalog.date_part('year', year_start)::integer * 12 + pg_catalog.date_part('month', year_start)::integer) + 1200,
            window_months)
            = pg_catalog.div(
            pg_catalog.date_part('year', billing_month)::integer * 12 + pg_catalog.date_part('month', billing_month)::integer
              - (pg_catalog.date_part('year', year_start)::integer * 12 + pg_catalog.date_part('month', year_start)::integer) + 1200,
            window_months)
        ))
    ) then
      raise exception 'This fee is not monthly and this pupil already has a demand for the same period. Review the existing demand.' using errcode = '23505';
    end if;
    if structure.frequency in ('yearly', 'one_time') and fee_head <> 'other' then
      -- Same head under another class's structure (a class move) counts as already billed this session.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'office-fee-year-head:' || p_student_id::text || ':' || structure.academic_year_id::text || ':' || fee_head, 0
      ));
      select other.name into other_name
      from public.student_fees sf
      join public.fee_structures other on other.id = sf.fee_structure_id and other.school_id = p_school_id
      where sf.student_id = p_student_id and other.id <> structure.id
        and other.academic_year_id = structure.academic_year_id and other.frequency in ('yearly', 'one_time')
        and other.class_id is distinct from structure.class_id
        and pg_catalog.lower(pg_catalog.btrim(other.name)) = fee_head
        and not exists (select 1 from app_private.office_fee_opening_structures os where os.fee_structure_id = other.id)
      order by sf.id limit 1;
      if found then
        raise exception 'This pupil is already billed under % for this session. Review that demand instead.', other_name
          using errcode = '23505';
      end if;
    end if;
  elsif structure.frequency = 'monthly' and structure.class_id is not null and fee_head <> 'other' then
    -- Taken after the per-period lock. post_office_fee_batch takes no head lock itself; it reaches this
    -- one only through its nested call here, after its own per-period locks, so the order stays the same.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'office-fee-month:' || p_student_id::text || ':' || p_billing_period || ':' || fee_head, 0
    ));
    -- The same fee head under another class's monthly structure (a mid-month class move) is already billed.
    select other.name into other_name
    from public.student_fees sf
    join public.fee_structures other on other.id = sf.fee_structure_id and other.school_id = p_school_id
    where sf.student_id = p_student_id and sf.billing_period = p_billing_period
      and other.academic_year_id = structure.academic_year_id and other.frequency = 'monthly'
      and other.class_id is not null and other.class_id <> structure.class_id
      and pg_catalog.lower(pg_catalog.btrim(other.name)) = fee_head
    order by sf.id limit 1;
    if found then
      raise exception 'This pupil is already billed under % for this billing month. Review that demand instead.', other_name
        using errcode = '23505';
    end if;
  end if;
  if structure.amount <= 0 or structure.amount = 'NaN'::numeric then
    raise exception 'The fee structure must have a positive amount.' using errcode = '22023';
  end if;

  insert into public.student_fees (school_id, student_id, fee_structure_id, billing_period, due_date, amount)
  values (p_school_id, p_student_id, p_fee_structure_id, p_billing_period, p_due_date, structure.amount)
  returning id into demand_id;
  return demand_id;
end;
$$;

create or replace function app_private.preview_office_fee_batch(p_school_id uuid,p_kind text,p_payload jsonb)
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
  other_rows jsonb;
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
      -- A pupil moved mid-month may already be billed the same fee head under another class's monthly
      -- structure (same rule as issue_office_fee_demand: head = lower(btrim(name)); 'Other' never matches).
      other_rows := '[]'::jsonb;
      if structure_row.class_id is not null and lower(btrim(structure_row.name))<>'other' then
        select coalesce(jsonb_agg(to_jsonb(sf)||jsonb_build_object('structure_name',other.name) order by sf.id),'[]'::jsonb) into other_rows
          from public.student_fees sf
          join public.fee_structures other on other.id=sf.fee_structure_id and other.school_id=p_school_id
          where sf.student_id=row_info.id and sf.billing_period=p_payload->>'billing_period'
            and other.academic_year_id=year_id and other.frequency='monthly'
            and other.class_id is not null and other.class_id<>structure_row.class_id
            and lower(btrim(other.name))=lower(btrim(structure_row.name));
      end if;
      existing_fee := null;
      if jsonb_array_length(existing_rows)=1 then
        select * into existing_fee from jsonb_populate_record(null::public.student_fees,existing_rows->0);
      elsif jsonb_array_length(existing_rows)=0 and jsonb_array_length(other_rows)>0 then
        select * into existing_fee from jsonb_populate_record(null::public.student_fees,other_rows->0);
      end if;
      item_status := case when existing_fee.id is null and jsonb_array_length(existing_rows)=0 then 'ready' else 'existing' end;
      item_message := case when item_status='ready' then 'New monthly demand.'
        when jsonb_array_length(existing_rows)=0 then format('Already billed under %s for this month after a class change; no new demand.',other_rows->0->>'structure_name')
        else 'Existing demand retained without changes.' end;
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
          'class_active',row_info.class_active,'existing',(select coalesce(jsonb_agg(value-'status'),'[]'::jsonb) from jsonb_array_elements(existing_rows)),
          'other_class_existing',(select coalesce(jsonb_agg(value-'status'),'[]'::jsonb) from jsonb_array_elements(other_rows)))));
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

revoke all on function app_private.issue_office_fee_demand(uuid, uuid, uuid, text, date)
  from public, anon, authenticated, service_role;
grant execute on function app_private.issue_office_fee_demand(uuid, uuid, uuid, text, date) to authenticated;
revoke all on function app_private.preview_office_fee_batch(uuid,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function app_private.preview_office_fee_batch(uuid,text,jsonb) to authenticated;

commit;
