-- Deterministic stale drafts must not trigger PostgREST transaction retries.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

do $migration$
declare
  target regprocedure := pg_catalog.to_regprocedure('public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)');
  original pg_catalog.pg_proc%rowtype;
  changed pg_catalog.pg_proc%rowtype;
  old_code text := 'errcode=''40001''';
  new_code text := 'errcode=''PT409''';
  definition text;
begin
  if target is null then raise exception 'The governed mark-save RPC must exist before its HTTP conflict fix.';end if;
  select * into original from pg_catalog.pg_proc where oid=target;
  if original.prosecdef or original.prorettype<>'jsonb'::regtype
    or (length(original.prosrc)-length(replace(original.prosrc,old_code,'')))/length(old_code)<>2 then
    raise exception 'Expected exactly two deterministic conflicts in the existing invoker mark-save RPC.';
  end if;
  definition := pg_catalog.pg_get_functiondef(target);
  execute replace(definition,old_code,new_code);
  select * into changed from pg_catalog.pg_proc where oid=target;
  if changed.prosrc is distinct from replace(original.prosrc,old_code,new_code)
    or changed.proacl is distinct from original.proacl
    or changed.proowner is distinct from original.proowner
    or changed.prosecdef is distinct from original.prosecdef
    or changed.proconfig is distinct from original.proconfig then
    raise exception 'The conflict fix must preserve source logic, owner, invoker context and grants.';
  end if;
end;
$migration$;
commit;
