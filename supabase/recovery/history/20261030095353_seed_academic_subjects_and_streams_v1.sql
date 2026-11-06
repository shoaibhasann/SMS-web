insert into public.subjects (school_id, code, name, description, is_practical, is_active)
select 'aa9af773-9bd2-4183-a8ae-fa888c1f97b1'::uuid, v.code, v.name, v.description, v.is_practical, true
from (values
  ('ENG','English','English language and literature',false),
  ('HIN','Hindi','Hindi language and literature',false),
  ('MAT','Mathematics','Mathematics',false),
  ('SCI','Science','General science',false),
  ('SST','Social Science','History, geography, civics and economics',false),
  ('COM','Computer','Computer and information technology',true),
  ('EVS','Environmental Studies','Environmental studies',false),
  ('GK','General Knowledge','General knowledge and awareness',false),
  ('SAN','Sanskrit','Sanskrit language',false),
  ('PE','Physical Education','Physical education and sports',true),
  ('ART','Art','Art and creative activities',true)
) as v(code,name,description,is_practical)
where not exists (
  select 1 from public.subjects s where s.school_id='aa9af773-9bd2-4183-a8ae-fa888c1f97b1'::uuid and s.code=v.code
);

insert into public.streams (school_id,name)
select 'aa9af773-9bd2-4183-a8ae-fa888c1f97b1'::uuid, v.name
from (values ('Science'),('Commerce'),('Humanities / Arts')) as v(name)
where not exists (
  select 1 from public.streams s where s.school_id='aa9af773-9bd2-4183-a8ae-fa888c1f97b1'::uuid and s.name=v.name
);