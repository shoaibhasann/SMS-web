-- Synthetic roster for the existing Fee Credit QA school only.
-- Verify the returned counts using the default rollback before committing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

select pg_advisory_xact_lock(hashtextextended('sms-fee-credit-roster-qa:7727a1bf-6330-4dbe-962e-b2bb50646c72',0));

create temporary table sms_seed_scope on commit drop as
select s.id as school_id, y.id as year_id, y.start_date
from public.schools s
join public.academic_years y on y.school_id=s.id and y.is_current
where s.id='7727a1bf-6330-4dbe-962e-b2bb50646c72'
  and s.code='ERP-FEE-CREDIT-QA-a852f1dc' and s.name='ERP Fee Credit QA a852f1dc' and s.is_active
  and y.id='a1cc0cd2-ea75-4343-b500-049b4da4cc71' and y.name='QA Fee Credit Current'
  and y.start_date=date '2026-09-06' and y.end_date=date '2027-03-05';

do $guard$
begin
  if (select count(*) from pg_temp.sms_seed_scope) <> 1
    or current_setting('role',true) in ('anon','authenticated','service_role')
  then raise exception 'Expected Fee Credit QA school, current year and database operator'; end if;

  if (select count(*) from public.students st join pg_temp.sms_seed_scope t on t.school_id=st.school_id
      where st.admission_no not like 'SMSFCQA26-%') <> 44
    or (select count(*) from public.enrollments e join pg_temp.sms_seed_scope t on t.year_id=e.academic_year_id
      join public.students st on st.id=e.student_id and st.school_id=t.school_id
      where e.status='active' and st.status='active' and st.admission_no not like 'SMSFCQA26-%') <> 44
  then raise exception 'Expected exactly 44 original Fee Credit QA roster records'; end if;
end
$guard$;

create temporary table sms_seed_grades on commit drop as
select t.school_id,t.year_id,t.start_date,g.grade,
  'QA Roster · ' || case g.grade when -2 then 'Nursery' when -1 then 'LKG' when 0 then 'UKG' else 'Class '||g.grade end as grade_name,
  md5(t.school_id::text||':smsfcqa26:grade:'||g.grade)::uuid as class_id
from pg_temp.sms_seed_scope t cross join generate_series(-2,12) g(grade);

create temporary table sms_seed_sections on commit drop as
select g.school_id,g.class_id,s.letter as section_name,
  md5(g.class_id::text||':smsfcqa26:section:'||s.letter)::uuid as section_id,
  (g.grade+3)::text||'0'||s.ord::text as room,40 as capacity
from pg_temp.sms_seed_grades g cross join unnest(array['A','B','C','D']) with ordinality s(letter,ord);

insert into public.classes(id,school_id,name,sort_order)
select class_id,school_id,grade_name,grade from pg_temp.sms_seed_grades
on conflict (id) do nothing;

insert into public.sections(id,school_id,class_id,name,room,capacity)
select section_id,school_id,class_id,section_name,room,capacity from pg_temp.sms_seed_sections
on conflict (id) do nothing;

insert into public.streams(id,school_id,name)
select md5(t.school_id::text||':smsfcqa26:stream:'||n.name)::uuid,t.school_id,n.name
from pg_temp.sms_seed_scope t cross join (values ('Science'),('Commerce'),('Humanities')) n(name)
on conflict (school_id,name) do nothing;

create temporary table sms_seed_roster on commit drop as
with names as (
  select array[
    'Aarav','Vihaan','Arjun','Kabir','Reyansh','Rohan','Advik','Ishaan','Vivaan','Atharv',
    'Ayaan','Dev','Dhruv','Krish','Kartik','Rudra','Veer','Vedant','Ansh','Samar',
    'Aryan','Harsh','Kunal','Lakshya','Manan','Naman','Om','Pranav','Raghav','Shaan',
    'Tanmay','Uday','Yash','Zayan','Aadil','Aditya','Armaan','Daksh','Farhan','Ibrahim',
    'Jai','Jayant','Keshav','Mahir','Nakul','Neil','Parth','Rayan','Sahil','Zaid'
  ] as boys, array[
    'Aanya','Diya','Ira','Meera','Saanvi','Anaya','Myra','Kiara','Sara','Tara',
    'Anika','Avni','Ishita','Riya','Siya','Aadhya','Aditi','Anvi','Devika','Gauri',
    'Isha','Kavya','Mahi','Navya','Nisha','Pihu','Riddhi','Saira','Tanishka','Urvi',
    'Vanya','Zoya','Anshika','Alina','Amina','Avika','Hiba','Inaya','Jiya','Khushi',
    'Maira','Naina','Nayra','Pari','Ruhani','Suhani','Trisha','Veda','Yashvi','Zara'
  ] as girls, array[
    'Sharma','Khan','Verma','Singh','Ansari','Gupta','Ali','Yadav','Mishra','Jain',
    'Agarwal','Bansal','Bhatia','Chauhan','Chaudhary','Garg','Goswami','Grover','Jha','Kapoor',
    'Kashyap','Kaushik','Kumar','Malik','Mehra','Mittal','Nair','Pandey','Pathak','Rana',
    'Rastogi','Rawat','Saini','Saxena','Seth','Shah','Srivastava','Tandon','Tomar','Tyagi',
    'Upadhyay','Siddiqui','Mirza','Ahmad','Qureshi'
  ] as surnames
), place(area,city,state,pincode,ord) as (
  values ('Indirapuram','Ghaziabad','Uttar Pradesh','201014',1),
    ('Vasundhara','Ghaziabad','Uttar Pradesh','201012',2),
    ('Crossings Republik','Ghaziabad','Uttar Pradesh','201016',3),
    ('Sector 62','Noida','Uttar Pradesh','201309',4),
    ('Sector 15','Noida','Uttar Pradesh','201301',5),
    ('Alpha I','Greater Noida','Uttar Pradesh','201310',6),
    ('Vasundhara Enclave','Delhi','Delhi','110096',7),
    ('Mayur Vihar Phase I','Delhi','Delhi','110091',8)
), batch as (
  select n,((n-1)*73+119)%4500 as name_key,
    'SMSFCQA26-'||lpad(n::text,4,'0') as admission_no,
    ((n-1)%15)-2 as grade,substr('ABCD',1+(((n-1)/15)%4),1) as section_name
  from generate_series(1,2000) seq(n)

)
select b.n,b.admission_no,g.school_id,g.year_id,g.class_id,g.grade,sec.section_id,
  (((b.n-1)/60)+1)::text as roll_no,
  md5(g.school_id::text||':smsfcqa26:student:'||b.n)::uuid as student_id,
  md5(g.school_id::text||':smsfcqa26:enrollment:'||b.n)::uuid as enrollment_id,
  case when b.name_key%2=0 then names.boys[(b.name_key%100)/2+1] else names.girls[(b.name_key%100)/2+1] end as first_name,
  case when b.n%7=0 then case when b.name_key%2=0 then 'Kumar' else 'Kumari' end end as middle_name,
  names.surnames[b.name_key/100+1] as last_name,
  case when b.name_key%2=0 then 'male' else 'female' end as gender,
  (g.start_date - make_interval(years=>6+g.grade))::date+(b.n*53%365) as dob,
  g.start_date+(b.n*17%55) as admission_date,
  (array['O+','A+','B+','O+','AB+','B+','A+','O-','B-','A-','AB-'])[(b.n*7%11)+1] as blood_group,
  'Flat '||(101+b.n%480)||', Block '||substr('ABCDEFGH',b.n%8+1,1)||', Demo Residency, '||p.area as address,
  p.city,p.state,p.pincode,
  str.id as stream_id
from batch b join pg_temp.sms_seed_grades g on g.grade=b.grade
join pg_temp.sms_seed_sections sec on sec.class_id=g.class_id and sec.section_name=b.section_name
cross join names join place p on p.ord=(b.n*11%8)+1
left join public.streams str on str.school_id=g.school_id and b.grade>=11
  and str.name=(array['Science','Commerce','Humanities','Science'])[ascii(b.section_name)-64];

insert into public.students(
  id,school_id,admission_no,roll_no,first_name,middle_name,last_name,dob,gender,blood_group,admission_date,address,city,state,pincode,status
)
select student_id,school_id,admission_no,roll_no,first_name,middle_name,last_name,dob,gender,blood_group,admission_date,address,city,state,pincode,'active'
from pg_temp.sms_seed_roster on conflict (id) do nothing;

insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id,stream_id,roll_no,enrolled_at,status)
select enrollment_id,student_id,year_id,class_id,section_id,stream_id,roll_no,
  admission_date::timestamp at time zone 'Asia/Kolkata','active'
from pg_temp.sms_seed_roster on conflict (id) do nothing;

do $validate$
begin
  if (select count(*) from pg_temp.sms_seed_roster) <> 2000
    or (select count(distinct (first_name,last_name)) from pg_temp.sms_seed_roster) <> 2000
    or (select count(*) from pg_temp.sms_seed_roster where grade>=11 and stream_id is not null) <> 266
    or (select count(*) from pg_temp.sms_seed_grades g
      join public.classes c on c.id=g.class_id and c.school_id=g.school_id and c.name=g.grade_name
        and c.sort_order=g.grade and c.is_active) <> 15
    or (select count(*) from pg_temp.sms_seed_sections s
      join public.sections p on p.id=s.section_id and p.school_id=s.school_id and p.class_id=s.class_id
        and p.name=s.section_name and p.room=s.room and p.capacity=s.capacity) <> 60
    or (select count(*) from pg_temp.sms_seed_roster r
      join public.students st on st.id=r.student_id and st.school_id=r.school_id and st.admission_no=r.admission_no
        and st.profile_id is null and st.registered_mobile is null and st.photo_url is null and st.status='active'
        and row(st.roll_no,st.first_name,st.middle_name,st.last_name,st.dob,st.gender,st.blood_group,
          st.admission_date,st.address,st.city,st.state,st.pincode) is not distinct from
          row(r.roll_no,r.first_name,r.middle_name,r.last_name,r.dob,r.gender,r.blood_group,
          r.admission_date,r.address,r.city,r.state,r.pincode)
      join public.enrollments e on e.id=r.enrollment_id and e.student_id=st.id and e.academic_year_id=r.year_id
        and e.class_id=r.class_id and e.section_id=r.section_id and e.roll_no=r.roll_no and e.status='active'
        and e.stream_id is not distinct from r.stream_id
        and e.enrolled_at=(r.admission_date::timestamp at time zone 'Asia/Kolkata')) <> 2000
    or (select count(*) from public.students st join pg_temp.sms_seed_scope t on t.school_id=st.school_id) <> 2044
    or (select count(*) from public.enrollments e join pg_temp.sms_seed_scope t on t.year_id=e.academic_year_id
      join public.students st on st.id=e.student_id and st.school_id=t.school_id
      where e.status='active' and st.status='active') <> 2044
    or exists (
      select 1 from public.enrollments e join pg_temp.sms_seed_sections s on s.section_id=e.section_id
      join pg_temp.sms_seed_scope t on t.year_id=e.academic_year_id
      left join pg_temp.sms_seed_roster r on r.enrollment_id=e.id
      where r.enrollment_id is null
    )
    or exists (
      select 1 from pg_temp.sms_seed_roster group by section_id,roll_no having count(*)>1
    )
    or exists (
      select 1 from public.teacher_subject_assignments a join pg_temp.sms_seed_grades g on g.class_id=a.class_id
    )
  then raise exception 'Fee Credit QA roster did not match the exact plan or overlapped existing placements'; end if;
end
$validate$;

select 44 as original_students,count(*) as seeded_students,44+count(*) as total_students,
  count(distinct class_id) as grade_bands,count(distinct section_id) as sections
from pg_temp.sms_seed_roster;

rollback; -- DRY RUN DEFAULT: replace only after reviewing the returned counts.
