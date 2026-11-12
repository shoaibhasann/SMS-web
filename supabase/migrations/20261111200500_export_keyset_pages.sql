-- School data export pages by keyset instead of OFFSET. Each page is its own RPC (no shared
-- snapshot), so OFFSET over random UUID keys duplicated or skipped rows when gate scans or
-- family writes landed mid-export, and page k re-sorted k*250 rows. The manifest lists each
-- dataset's catalogue order key; the cursor is those fields of the previous page's last row, read
-- as literals coerced to the key column types. Pages grow to 1,000 rows. Actor, authenticator and manifest/audit checks
-- are copied from 20261110081727_school_data_portability.sql (the latest definition).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

drop function public.export_school_dataset(uuid,text,integer);
drop function app_private.export_school_dataset(uuid,text,integer);

create function app_private.export_school_dataset(p_school_id uuid, p_dataset text, p_after jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  actor uuid := app_private.result_actor();
  dataset record;
  keyset text := '';
  key_columns text[];
  key_values text[];
  key_column text;
  result jsonb;
begin
  perform 1 from public.profiles profile
    join public.schools school on school.id=profile.school_id and school.is_active
    join public.user_roles membership on membership.user_id=profile.id
      and membership.school_id=school.id and membership.role='school_admin'
    where profile.id=actor and profile.is_active and school.id=p_school_id
    for share of profile, school, membership;
  if not found then
    raise exception 'Current School Admin access is required.' using errcode='42501';
  end if;
  if auth.jwt()->>'aal' is distinct from 'aal2' or not app_private.staff_mfa_allowed() then
    raise exception 'Verify your authenticator to export school records.' using errcode='42501';
  end if;
  if p_dataset = 'manifest' and p_after is not null then
    raise exception 'Invalid school export page.' using errcode='22023';
  end if;

  if p_dataset = 'manifest' then
    insert into public.audit_logs(school_id, actor_user_id, action, entity_type, entity_id)
      values(p_school_id, actor, 'school_data_export_requested', 'school', p_school_id);
    -- order_key lets the exporter send back only the cursor fields, not whole (possibly wide) rows.
    return (select jsonb_agg(jsonb_build_object('name',name,'order_key',order_key) order by name) from app_private.school_export_catalogue());
  end if;

  select * into dataset from app_private.school_export_catalogue() where name=p_dataset;
  if not found then
    raise exception 'Unknown school export dataset.' using errcode='22023';
  end if;

  if p_after is not null then
    if jsonb_typeof(p_after) is distinct from 'object' then
      raise exception 'Invalid school export page.' using errcode='22023';
    end if;
    foreach key_column in array string_to_array(dataset.order_key, ',') loop
      if p_after->>key_column is null then
        raise exception 'Invalid school export page.' using errcode='22023';
      end if;
      key_columns := key_columns || quote_ident(key_column);
      key_values := key_values || quote_literal(p_after->>key_column);
    end loop;
    keyset := format('where (%s) > (%s)', array_to_string(key_columns, ','), array_to_string(key_values, ','));
  end if;

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(page) order by %1$s), ''[]''::jsonb)
     from (select * from (%2$s) source %3$s order by %1$s limit 1000) page',
    dataset.order_key, dataset.source_sql, keyset
  ) into result using p_school_id;
  return result;
end;
$$;

create function public.export_school_dataset(p_school_id uuid, p_dataset text, p_after jsonb default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select app_private.export_school_dataset(p_school_id, p_dataset, p_after); $$;

revoke all on function app_private.export_school_dataset(uuid,text,jsonb), public.export_school_dataset(uuid,text,jsonb)
from public, anon, authenticated, service_role;
grant execute on function app_private.export_school_dataset(uuid,text,jsonb),
  public.export_school_dataset(uuid,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
