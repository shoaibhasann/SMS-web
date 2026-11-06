-- Run in Kids Corner School ERP > SQL Editor > New query.
-- One SELECT statement: reads PostgreSQL metadata, never application table rows.
-- This is a metadata snapshot for inspection, not a restorable database backup.
-- Save the complete schema_export result as JSON; do not copy a truncated cell.

with app_namespaces as materialized (
  select n.*
  from pg_catalog.pg_namespace n
  where n.nspname !~ '^pg_'
    and n.nspname not in (
      'information_schema', 'auth', 'storage', 'extensions', 'vault',
      'graphql', 'graphql_public', 'realtime', 'supabase_functions',
      'supabase_migrations', 'pgbouncer', 'net', 'cron',
      'pgsodium', 'pgsodium_masks'
    )
), app_relations as materialized (
  select c.*, n.nspname as schema_name
  from pg_catalog.pg_class c
  join app_namespaces n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S')
), custom_triggers as materialized (
  select t.*, c.relname as table_name, n.nspname as table_schema
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  where not t.tgisinternal
    and (
      n.oid in (select oid from app_namespaces)
      or (
        n.nspname in ('auth', 'storage')
        and p.pronamespace in (select oid from app_namespaces)
      )
    )
), custom_routines as materialized (
  select p.*, n.nspname as schema_name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.prokind in ('f', 'p', 'w')
    and (
      n.oid in (select oid from app_namespaces)
      or p.oid in (select tgfoid from custom_triggers)
    )
    and not exists (
      select 1 from pg_catalog.pg_depend d
      where d.classid = 'pg_catalog.pg_proc'::regclass
        and d.objid = p.oid and d.deptype = 'e'
    )
)
select jsonb_build_object(
  'format', 'kids-corner-schema-metadata/v1',
  'captured_at', current_timestamp,
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'scope', 'Non-managed application schemas; related custom auth/storage triggers; application/storage RLS policies. No application rows, auth users, passwords or API keys are queried.',
  'schemas', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', n.nspname,
      'owner', pg_catalog.pg_get_userbyid(n.nspowner),
      'acl', to_jsonb(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner)))
    ) order by n.nspname)
    from app_namespaces n
  ), '[]'::jsonb),
  'relations', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', r.schema_name,
      'name', r.relname,
      'kind', r.relkind,
      'owner', pg_catalog.pg_get_userbyid(r.relowner),
      'rls_enabled', r.relrowsecurity,
      'rls_forced', r.relforcerowsecurity,
      'options', r.reloptions,
      'acl', to_jsonb(coalesce(r.relacl, pg_catalog.acldefault(
        case when r.relkind = 'S' then 's'::"char" else 'r'::"char" end,
        r.relowner
      ))),
      'view_definition', case when r.relkind in ('v', 'm')
        then pg_catalog.pg_get_viewdef(r.oid, false) else null end,
      'partition_key', case when r.relkind = 'p'
        then pg_catalog.pg_get_partkeydef(r.oid) else null end,
      'partition_bound', case when r.relispartition
        then pg_catalog.pg_get_expr(r.relpartbound, r.oid) else null end,
      'parents', coalesce((
        select jsonb_agg(jsonb_build_object('schema', pn.nspname, 'name', pc.relname)
          order by i.inhseqno)
        from pg_catalog.pg_inherits i
        join pg_catalog.pg_class pc on pc.oid = i.inhparent
        join pg_catalog.pg_namespace pn on pn.oid = pc.relnamespace
        where i.inhrelid = r.oid
      ), '[]'::jsonb),
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object(
          'position', a.attnum,
          'name', a.attname,
          'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull,
          'identity', a.attidentity,
          'generated', a.attgenerated,
          'default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid),
          'acl', to_jsonb(a.attacl)
        ) order by a.attnum)
        from pg_catalog.pg_attribute a
        left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
        where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
      ), '[]'::jsonb),
      'constraints', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', c.conname, 'kind', c.contype,
          'definition', pg_catalog.pg_get_constraintdef(c.oid, false),
          'validated', c.convalidated, 'deferrable', c.condeferrable,
          'initially_deferred', c.condeferred
        ) order by c.conname)
        from pg_catalog.pg_constraint c where c.conrelid = r.oid
      ), '[]'::jsonb),
      'indexes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', ic.relname, 'definition', pg_catalog.pg_get_indexdef(i.indexrelid),
          'valid', i.indisvalid, 'ready', i.indisready
        ) order by ic.relname)
        from pg_catalog.pg_index i
        join pg_catalog.pg_class ic on ic.oid = i.indexrelid
        where i.indrelid = r.oid
      ), '[]'::jsonb)
    ) order by r.schema_name, r.relname)
    from app_relations r
  ), '[]'::jsonb),
  'enums', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', t.typname,
      'labels', (select jsonb_agg(e.enumlabel order by e.enumsortorder)
        from pg_catalog.pg_enum e where e.enumtypid = t.oid)
    ) order by n.nspname, t.typname)
    from pg_catalog.pg_type t join app_namespaces n on n.oid = t.typnamespace
    where t.typtype = 'e'
  ), '[]'::jsonb),
  'domains', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', t.typname,
      'base_type', pg_catalog.format_type(t.typbasetype, t.typtypmod),
      'not_null', t.typnotnull, 'default', t.typdefault,
      'constraints', coalesce((select jsonb_agg(pg_catalog.pg_get_constraintdef(c.oid, false)
        order by c.conname) from pg_catalog.pg_constraint c where c.contypid = t.oid), '[]'::jsonb)
    ) order by n.nspname, t.typname)
    from pg_catalog.pg_type t join app_namespaces n on n.oid = t.typnamespace
    where t.typtype = 'd'
  ), '[]'::jsonb),
  'ranges', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', n.nspname, 'name', t.typname,
      'owner', pg_catalog.pg_get_userbyid(t.typowner),
      'acl', to_jsonb(coalesce(t.typacl,pg_catalog.acldefault('T',t.typowner))),
      'subtype', pg_catalog.format_type(r.rngsubtype,null),
      'subtype_opclass', pg_catalog.quote_ident(opn.nspname)||'.'||pg_catalog.quote_ident(op.opcname),
      'collation', r.rngcollation::regcollation::text,
      'canonical', r.rngcanonical::regprocedure::text,
      'subtype_diff', r.rngsubdiff::regprocedure::text,
      'multirange', pg_catalog.format_type(r.rngmultitypid,null),
      'multirange_owner', pg_catalog.pg_get_userbyid(m.typowner),
      'multirange_acl', to_jsonb(coalesce(m.typacl,pg_catalog.acldefault('T',m.typowner)))
    ) order by n.nspname,t.typname)
    from pg_catalog.pg_range r join pg_catalog.pg_type t on t.oid=r.rngtypid
    join pg_catalog.pg_type m on m.oid=r.rngmultitypid
    join pg_catalog.pg_opclass op on op.oid=r.rngsubopc join pg_catalog.pg_namespace opn on opn.oid=op.opcnamespace
    join app_namespaces n on n.oid=t.typnamespace
  ), '[]'::jsonb),
  'routines', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', p.schema_name, 'name', p.proname, 'kind', p.prokind,
      'identity_arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'owner', pg_catalog.pg_get_userbyid(p.proowner),
      'security_definer', p.prosecdef, 'settings', p.proconfig,
      'acl', to_jsonb(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))),
      'definition', pg_catalog.pg_get_functiondef(p.oid)
    ) order by p.schema_name, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid))
    from custom_routines p
  ), '[]'::jsonb),
  'triggers', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', t.table_schema, 'table', t.table_name, 'name', t.tgname,
      'enabled', t.tgenabled, 'definition', pg_catalog.pg_get_triggerdef(t.oid, false)
    ) order by t.table_schema, t.table_name, t.tgname)
    from custom_triggers t
  ), '[]'::jsonb),
  'policies', coalesce((
    select jsonb_agg(to_jsonb(p) order by p.schemaname, p.tablename, p.policyname)
    from pg_catalog.pg_policies p
    where p.schemaname in (select nspname from app_namespaces)
      or p.schemaname = 'storage'
  ), '[]'::jsonb),
  'sequences', coalesce((
    select jsonb_agg(jsonb_build_object(
      'schema', s.schemaname, 'name', s.sequencename,
      'owner', s.sequenceowner, 'type', s.data_type::text,
      'start', s.start_value, 'minimum', s.min_value, 'maximum', s.max_value,
      'increment', s.increment_by, 'cycle', s.cycle, 'cache', s.cache_size
    ) order by s.schemaname, s.sequencename)
    from pg_catalog.pg_sequences s where s.schemaname in (select nspname from app_namespaces)
  ), '[]'::jsonb),
  'default_privileges', coalesce((
    select jsonb_agg(jsonb_build_object(
      'owner', pg_catalog.pg_get_userbyid(d.defaclrole),
      'schema', n.nspname, 'object_kind', d.defaclobjtype,
      'acl', to_jsonb(d.defaclacl)
    ) order by d.defaclrole, d.defaclnamespace, d.defaclobjtype)
    from pg_catalog.pg_default_acl d
    left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    where d.defaclnamespace = 0 or d.defaclnamespace in (select oid from app_namespaces)
  ), '[]'::jsonb),
  'extensions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', e.extname, 'version', e.extversion, 'schema', n.nspname
    ) order by e.extname)
    from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  ), '[]'::jsonb)
) as schema_export;
