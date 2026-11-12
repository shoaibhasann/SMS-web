begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog;

-- RP-07: a requester whose assignment was removed still lists (metadata only) and
-- can cancel their own pending request; the pupil snapshot stays assignment-gated.
create or replace function app_private.list_assessment_result_submissions(p_school_id uuid default null,p_status text default null,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=app_private.result_actor();result jsonb;
begin
  if p_school_id is not null and not app_private.has_school_roles(p_school_id,array['school_admin','principal']::public.app_role[]) then
    raise exception 'You cannot view submissions for this school.' using errcode='42501'; end if;
  if p_school_id is null and not exists(select 1 from public.user_roles ur where ur.user_id=actor and ur.role='teacher'
    and ur.school_id=(select p.school_id from public.profiles p where p.id=actor)) then
    raise exception 'An active Teacher role or office school is required.' using errcode='42501'; end if;
  if p_offset is null or p_offset<0 or(p_status is not null and p_status not in('pending','published','rejected','cancelled')) then
    raise exception 'Invalid page or publication status.' using errcode='22023'; end if;
  with permitted as(select s.* from app_private.assessment_result_submissions s where(p_status is null or s.status=p_status)
    and((p_school_id is not null and s.school_id=p_school_id) or(p_school_id is null and s.requested_by=actor and(s.status='pending' or app_private.result_teacher_access(s.assessment_id))))),
  page as(select * from permitted order by requested_at desc,id desc limit 50 offset p_offset)
  select jsonb_build_object('offset',p_offset,'total_count',(select count(*) from permitted),
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'assessment_id',p.assessment_id,'school_id',p.school_id,'status',p.status,
      'requested_at',p.requested_at,'requester_name',p.requester_name,'reviewed_at',p.reviewed_at,'revision',p.revision,
      'metadata',p.payload->'metadata') order by p.requested_at desc,p.id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$$;

revoke all on function public.list_assessment_result_submissions(uuid,text,integer),app_private.list_assessment_result_submissions(uuid,text,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.list_assessment_result_submissions(uuid,text,integer),app_private.list_assessment_result_submissions(uuid,text,integer)
  to authenticated;
commit;
