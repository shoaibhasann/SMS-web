-- SMS-DESIGN-QA: deterministic synthetic data for the existing founder demo school.
-- No Auth/account/role/link or financial writes. Existing rows are never updated.
-- DRY RUN DEFAULT: the last statement rolls everything back. Root reviews this
-- concrete transaction before changing that final statement to COMMIT.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog,public;

do $seed$
declare
  school uuid:='7727a1bf-6330-4dbe-962e-b2bb50646c72';
  year uuid:='a1cc0cd2-ea75-4343-b500-049b4da4cc71';
  base_class uuid:='46eab875-8fd5-41f4-873e-766e605ca962';
  base_section_a uuid:='b7d454e6-bbab-41fe-a0f5-e853b7d0b183';
  base_section_b uuid:='7f2a17dc-4a3a-4246-89a1-6245ba62c060';
  base_subject uuid:='d46fdddb-30d2-49a8-a02b-c77a5fa0cb10';
  teacher uuid:='d8a104e5-4134-414e-952d-a1dcdaf848a3';
  teacher_user uuid:='a0ec655b-0525-419f-953e-d8c2dfaaa678';
  admin_user uuid:='139b388b-23b0-48f2-94ed-f3690ec0e17e';
  guardian_user uuid:='5dc6a52d-2184-4125-ab68-0bc0b057e8a4';
  student_user uuid:='58f87936-9714-434d-8775-dbb2f6d88c51';
  linked_pupil uuid:='a8f43624-20d6-41e1-90f7-ce6a2d5e9910';
  sibling uuid:='dd5ca9d8-934c-4c2b-9e51-efaffae70508';
  parent uuid:='2529ac78-a0bb-434b-986f-7df87d4a36c8';
  tag text:='SMS-DESIGN-QA';
  today date:=(statement_timestamp() at time zone 'Asia/Kolkata')::date;
  prefix text;
  class_ids uuid[];section_ids uuid[];subject_ids uuid[];
  names text[]:=array['Aarav','Aanya','Vihaan','Diya','Arjun','Ira','Kabir','Meera','Reyansh','Saanvi','Rohan','Anaya','Advik','Myra','Ishaan','Kiara','Vivaan','Sara','Atharv','Tara'];
  surnames text[]:=array['Sharma','Khan','Verma','Singh','Ansari','Gupta','Ali','Yadav','Mishra','Jain'];
  topics text[]:=array['Equivalent fractions','Reading for the main idea','Understanding decimals','Writing a clear paragraph','Fractions in everyday life','Vocabulary and comprehension'];
  pupil uuid;enrollment uuid;chosen_class uuid;chosen_section uuid;chosen_subject uuid;
  log_id uuid;chosen_assessment uuid;material_id uuid;chosen_date date;
  i integer;j integer;k integer;c integer;s integer;subject_index integer;student_index integer;
  financial_before text;financial_after text;
  roster record;
begin
  prefix:=tag||':'||school::text||':';
  perform pg_advisory_xact_lock(hashtextextended(prefix,0));
  if current_setting('role',true) in('authenticated','anon','service_role') then
    raise exception 'Use the reviewed trusted SQL transaction, never a browser or API-role seed.';
  end if;
  if not exists(select 1 from public.schools where id=school and code='ERP-FEE-CREDIT-QA-a852f1dc') then
    raise exception 'Expected founder demo school is absent; stop without changing another school.';
  end if;
  if not exists(select 1 from public.academic_years where id=year and school_id=school and is_current
    and today-29>=start_date and today+7<=end_date) then
    raise exception 'Expected current session does not contain this demo window; review dates before seeding.';
  end if;
  if not exists(select 1 from public.teachers t join public.profiles p on p.id=t.profile_id and p.is_active and p.school_id=school
    join public.user_roles ur on ur.user_id=p.id and ur.school_id=school and ur.role='teacher'
    where t.id=teacher and p.id=teacher_user and t.school_id=school) then raise exception 'Expected active teacher scope is missing.'; end if;
  if not exists(select 1 from public.profiles p join public.user_roles ur on ur.user_id=p.id and ur.school_id=school and ur.role='school_admin'
    where p.id=admin_user and p.is_active and p.school_id=school) then raise exception 'Expected admin scope is missing.'; end if;
  if not exists(select 1 from public.profiles p join public.user_roles ur on ur.user_id=p.id and ur.school_id=school and ur.role='parent'
    join public.parents pr on pr.profile_id=p.id and pr.school_id=school join public.student_parents edge on edge.parent_id=pr.id and edge.student_id=linked_pupil
    where p.id=guardian_user and p.is_active and p.school_id=school and pr.id=parent) then raise exception 'Expected existing guardian link is missing; this seed must not recreate revoked access.'; end if;
  if not exists(select 1 from public.students st join public.profiles p on p.id=st.profile_id and p.is_active
    join public.user_roles ur on ur.user_id=p.id and ur.school_id=school and ur.role='student'
    join public.enrollments e on e.student_id=st.id and e.academic_year_id=year and e.class_id=base_class and e.section_id=base_section_a and e.status='active'
    where st.id=linked_pupil and st.school_id=school and st.status='active' and p.id=student_user) then raise exception 'Expected linked student active placement is different; do not move it to fit a seed.'; end if;
  if not exists(select 1 from public.classes where id=base_class and school_id=school and is_active)
    or not exists(select 1 from public.sections where id=base_section_a and school_id=school and class_id=base_class)
    or not exists(select 1 from public.sections where id=base_section_b and school_id=school and class_id=base_class)
    or not exists(select 1 from public.subjects where id=base_subject and school_id=school and is_active)
    or not exists(select 1 from public.students where id=sibling and school_id=school) then raise exception 'Demo master scope changed.'; end if;
  select md5(jsonb_build_object(
    'fees',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.student_fees r where school_id=school),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.fee_payments r where school_id=school),'[]'::jsonb),
    'refunds',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.fee_refunds r where school_id=school),'[]'::jsonb)
  )::text) into financial_before;

  class_ids:=array[base_class,md5(prefix||'class:2')::uuid,md5(prefix||'class:3')::uuid];
  section_ids:=array[base_section_a,base_section_b,md5(prefix||'section:2:A')::uuid,md5(prefix||'section:2:B')::uuid,
    md5(prefix||'section:3:A')::uuid,md5(prefix||'section:3:B')::uuid];
  subject_ids:=array[base_subject,md5(prefix||'subject:mathematics')::uuid,md5(prefix||'subject:english')::uuid];
  for i in 2..3 loop
    insert into public.classes(id,school_id,name,sort_order,is_active) values(class_ids[i],school,'Class '||(i+5)::text||' · demo',i+5,true) on conflict do nothing;
  end loop;
  insert into public.subjects(id,school_id,name,code,is_active) values
    (subject_ids[2],school,'Mathematics · demo','SMS-DESIGN-MATH',true),
    (subject_ids[3],school,'English · demo','SMS-DESIGN-ENG',true) on conflict do nothing;
  for c in 2..3 loop
    for s in 1..2 loop
      insert into public.sections(id,school_id,class_id,name) values(section_ids[(c-1)*2+s],school,class_ids[c],case when s=1 then 'A' else 'B' end) on conflict do nothing;
    end loop;
  end loop;
  if exists(select 1 from public.classes where id=any(class_ids) and school_id<>school)
    or exists(select 1 from public.sections where id=any(section_ids) and(school_id<>school or class_id<>class_ids[(array_position(section_ids,id)+1)/2]))
    or exists(select 1 from public.subjects where id=any(subject_ids) and school_id<>school) then raise exception 'Deterministic master ID collision.'; end if;
  for c in 1..3 loop
    for s in 1..2 loop
      for j in 1..3 loop
        insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher)
        values(md5(prefix||'assignment:'||c||':'||s||':'||j)::uuid,teacher,year,class_ids[c],section_ids[(c-1)*2+s],subject_ids[j],false) on conflict do nothing;
      end loop;
    end loop;
  end loop;

  for i in 1..40 loop
    c:=case when i<=20 then 1 when i<=30 then 2 else 3 end;
    s:=case when i<=20 then 1+((i-1)%2) else 1+((i-21)%2) end;
    chosen_class:=class_ids[c];chosen_section:=section_ids[(c-1)*2+s];pupil:=md5(prefix||'pupil:'||i)::uuid;
    enrollment:=md5(prefix||'enrollment:'||i)::uuid;
    insert into public.students(id,school_id,admission_no,roll_no,first_name,last_name,dob,gender,admission_date,city,state,status)
    values(pupil,school,tag||'-'||lpad(i::text,3,'0'),(10+i)::text,names[1+((i-1)%20)],surnames[1+((i-1)%10)],
      date '2013-01-01'+((i*13)%360),case when i%2=1 then 'male' else 'female' end,today-120,'Firozabad','Uttar Pradesh','active') on conflict do nothing;
    if not exists(select 1 from public.students where id=pupil and school_id=school and admission_no=tag||'-'||lpad(i::text,3,'0') and profile_id is null) then raise exception 'Deterministic pupil ID/admission collision.'; end if;
    insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id,roll_no,status)
    values(enrollment,pupil,year,chosen_class,chosen_section,(10+i)::text,'active') on conflict do nothing;
    if not exists(select 1 from public.enrollments where student_id=pupil and academic_year_id=year and enrollments.class_id=chosen_class and enrollments.section_id=chosen_section and status='active') then raise exception 'Existing demo pupil was moved; preserve it and review this seed.'; end if;
  end loop;

  -- Thirty calendar dates of explicitly synthetic marks. Sunday/holiday rules
  -- are not school policy: statuses here only exercise the demo readers.
  for roster in select st.id,e.section_id,(st.admission_no like tag||'-%') as is_demo from public.students st join public.enrollments e on e.student_id=st.id and e.academic_year_id=year and e.status='active'
    where st.school_id=school and st.status='active' and(st.admission_no like tag||'-%' or st.id in(linked_pupil,sibling)) loop
    for j in 0..29 loop
      chosen_date:=today-j;
      insert into public.attendance(id,school_id,academic_year_id,section_id,student_id,attendance_date,status,remarks,marked_by,created_at)
      values(md5(prefix||'attendance:'||roster.id||':'||chosen_date)::uuid,school,year,roster.section_id,roster.id,chosen_date,
        (case when j=0 then case when roster.is_demo then case ascii(substr(roster.id::text,1,1))%10 when 0 then 'absent' when 1 then 'late' when 2 then 'leave' else 'present' end else 'present' end when (j+ascii(substr(roster.id::text,1,1)))%17=0 then 'holiday'
          when (j+ascii(substr(roster.id::text,1,1)))%11=0 then 'leave' when (j+ascii(substr(roster.id::text,1,1)))%9=0 then 'half_day'
          when (j+ascii(substr(roster.id::text,1,1)))%7=0 then 'absent' when (j+ascii(substr(roster.id::text,1,1)))%5=0 then 'late' else 'present' end)::public.attendance_status,
        tag||': synthetic attendance',teacher_user,chosen_date::timestamp+interval '3 hours 30 minutes') on conflict do nothing;
    end loop;
  end loop;

  for i in 1..6 loop
    s:=case when i%2=1 then 1 else 2 end;subject_index:=case when i in(1,4,5) then 2 else 3 end;
    log_id:=md5(prefix||'log:'||i)::uuid;chosen_date:=today-((i-1)/2);
    insert into public.class_logs(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,log_date,topic,summary,teacher_remark,status,published_at,published_by)
    values(log_id,school,year,base_class,section_ids[s],subject_ids[subject_index],teacher,chosen_date,topics[i],
      tag||': worked examples, guided practice and a short recap. This is synthetic learning content for demo testing.',
      'Bring your notebook and ask about any step that is unclear.','published',statement_timestamp()-interval '1 hour',teacher_user) on conflict do nothing;
    if not exists(select 1 from public.class_logs where id=log_id and school_id=school and teacher_id=teacher and class_id=base_class) then raise exception 'Existing log scope conflicts with the deterministic seed.'; end if;
    insert into public.class_activities(id,class_log_id,activity_type,title,description,due_date,max_marks)
    values(md5(prefix||'activity:'||i||':classwork')::uuid,log_id,'classwork','Practice together: '||topics[i],tag||': solve the guided examples and explain your method.',null,null),
      (md5(prefix||'activity:'||i||':homework')::uuid,log_id,'homework','Independent practice: '||topics[i],tag||': complete five questions and upload your work when the task is ready to submit.',today+3,10)
    on conflict do nothing;
    if i<=2 then
      insert into public.class_activities(id,class_log_id,activity_type,title,description)
      values(md5(prefix||'activity:'||i||':material')::uuid,log_id,'study_material','Revision notes: '||topics[i],tag||': text-only revision notes; no file attachment is claimed.') on conflict do nothing;
      material_id:=md5(prefix||'material:'||i)::uuid;
      insert into public.study_materials(id,school_id,class_id,section_id,subject_id,teacher_id,title,description,published_at)
      values(material_id,school,base_class,section_ids[s],subject_ids[subject_index],teacher,'Revision notes: '||topics[i],tag||': text-only demo material. No external or uploaded file is attached.',statement_timestamp()-interval '1 hour') on conflict do nothing;
    end if;
  end loop;

  for i in 1..3 loop
    chosen_assessment:=md5(prefix||'assessment:'||i)::uuid;
    chosen_section:=section_ids[case when i=2 then 2 else 1 end];chosen_subject:=subject_ids[case when i=2 then 3 else 2 end];
    insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks,description,status)
    values(chosen_assessment,school,year,base_class,chosen_section,chosen_subject,teacher,
      case i when 1 then 'Mathematics recap · demo' when 2 then 'Reading check · demo' else 'Weekly learning check · demo' end,
      case when i=3 then today+5 else today-i end,100,tag||': synthetic classroom assessment, not an official school result.',case when i=3 then 'scheduled' else 'completed' end) on conflict do nothing;
    if not exists(select 1 from public.teacher_assessments where id=chosen_assessment and school_id=school and teacher_id=teacher and class_id=base_class and academic_year_id=year) then raise exception 'Assessment ID scope collision.'; end if;
    if i<3 then
      student_index:=0;
      for roster in select st.id from public.students st join public.enrollments e on e.student_id=st.id
        where st.school_id=school and st.status='active' and e.academic_year_id=year and e.class_id=base_class and e.section_id=chosen_section and e.status='active' order by st.id loop
        student_index:=student_index+1;
        insert into public.teacher_assessment_marks(id,assessment_id,student_id,marks_obtained,remarks)
        values(md5(prefix||'mark:'||i||':'||roster.id)::uuid,chosen_assessment,roster.id,65+((student_index*7+i*3)%34),tag||': synthetic practice score') on conflict do nothing;
      end loop;
    end if;
  end loop;
  for i in 1..4 loop
    insert into public.notices(id,school_id,title,content,audience,published_at,expires_at,created_by)
    values(md5(prefix||'notice:'||i)::uuid,school,
      (array['Learning week update','Homework reminder','Assessment week plan','School workspace guide'])[i]||' · demo',
      tag||': '||(array['Review attendance and this week''s class activities.','Check the homework tasks and submit practice work before the displayed due date.','Use the assessment and result pages to review synthetic practice data.','This school contains synthetic QA data for founder testing; records are not real student performance.'])[i],
      '{"roles":["student","parent","teacher","staff"]}'::jsonb,statement_timestamp()-interval '1 hour',statement_timestamp()+interval '14 days',admin_user) on conflict do nothing;
  end loop;

  select md5(jsonb_build_object(
    'fees',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.student_fees r where school_id=school),'[]'::jsonb),
    'payments',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.fee_payments r where school_id=school),'[]'::jsonb),
    'refunds',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.fee_refunds r where school_id=school),'[]'::jsonb)
  )::text) into financial_after;
  if financial_before<>financial_after then raise exception 'Financial preservation check failed; the entire seed is rolled back.'; end if;
  if (select count(*) from public.students where school_id=school and admission_no like tag||'-%')<>40 then raise exception 'Expected exactly40 deterministic demo pupils.'; end if;
end;
$seed$;

select jsonb_build_object('tag','SMS-DESIGN-QA','school_id','7727a1bf-6330-4dbe-962e-b2bb50646c72',
  'new_demo_pupils',(select count(*) from public.students where school_id='7727a1bf-6330-4dbe-962e-b2bb50646c72' and admission_no like 'SMS-DESIGN-QA-%'),
  'auth_accounts_changed',false,'existing_links_changed',false,'financial_rows_changed',false) as seed_summary;

rollback; -- DRY RUN DEFAULT: replace only after root review/authorization.
