do $$
declare
  v_school uuid := 'aa9af773-9bd2-4183-a8ae-fa888c1f97b1';
  v_year uuid;
  v_class uuid;
  class_name text;
  class_names text[] := array['Playway','Nursery','LKG','UKG','Class 1','Class 2','Class 3','Class 4','Class 5','Class 6','Class 7','Class 8','Class 9','Class 10','Class 11','Class 12'];
  i int;
  section_name text;
begin
  insert into public.academic_years (school_id, name, start_date, end_date, is_current)
  values (v_school, '2026-27', date '2026-04-01', date '2027-03-31', true)
  on conflict (school_id, name) do update set
    start_date = excluded.start_date,
    end_date = excluded.end_date,
    is_current = excluded.is_current
  returning id into v_year;

  if v_year is null then
    select id into v_year from public.academic_years where school_id = v_school and name = '2026-27';
  end if;

  update public.academic_years
  set is_current = (id = v_year)
  where school_id = v_school;

  foreach class_name in array class_names loop
    insert into public.classes (school_id, name, sort_order, is_active)
    values (v_school, class_name, array_position(class_names, class_name), true)
    on conflict (school_id, name) do update set
      sort_order = excluded.sort_order,
      is_active = true;

    select id into v_class from public.classes where school_id = v_school and name = class_name;

    foreach section_name in array array['A','B','C'] loop
      insert into public.sections (school_id, class_id, name, room, capacity)
      values (v_school, v_class, section_name, null, 40)
      on conflict (class_id, name) do update set
        capacity = excluded.capacity;
    end loop;
  end loop;
end $$;