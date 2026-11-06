create table if not exists public.payment_orders (
 id uuid primary key default gen_random_uuid(),
 school_id uuid not null references public.schools(id) on delete cascade,
 student_id uuid not null references public.students(id) on delete cascade,
 student_fee_id uuid references public.student_fees(id) on delete set null,
 provider text not null default 'razorpay',
 provider_order_id text,
 amount numeric(12,2) not null check (amount >= 0),
 currency text not null default 'INR',
 status text not null default 'created',
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists payment_orders_provider_order_uidx on public.payment_orders(provider,provider_order_id) where provider_order_id is not null;
create index if not exists payment_orders_student_idx on public.payment_orders(student_id,created_at desc);
alter table public.payment_orders enable row level security;
create policy payment_orders_school_access on public.payment_orders for all to authenticated using (school_id in (select school_id from public.profiles where id=auth.uid())) with check (school_id in (select school_id from public.profiles where id=auth.uid()));
create or replace view public.student_fee_summary as
select sf.student_id,sf.school_id,coalesce(sum(sf.amount),0) as billed_amount,coalesce(sum(sf.discount),0) as discount_amount,coalesce(sum(sf.late_fee),0) as late_fee_amount,coalesce(sum(case when sf.status='paid' then sf.amount else 0 end),0) as paid_assessed_amount,count(*) filter (where sf.status in ('pending','partial')) as outstanding_items
from public.student_fees sf group by sf.student_id,sf.school_id;
create or replace view public.report_card_subject_summary as
select rc.id as report_card_id,rc.student_id,rc.exam_id,es.subject_id,es.max_marks,es.pass_marks,m.marks_obtained,m.grade,m.remarks as subject_remarks
from public.report_cards rc join public.exam_subjects es on es.exam_id=rc.exam_id left join public.marks m on m.exam_subject_id=es.id and m.student_id=rc.student_id;