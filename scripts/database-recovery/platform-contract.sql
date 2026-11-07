-- LOCAL TEST CONTRACT ONLY. Supabase provides these roles, schemas and services
-- in a real project. This does not implement Auth or object-storage delivery.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator nologin noinherit;
create role supabase_admin nologin;
create role supabase_auth_admin nologin;
create role supabase_storage_admin nologin;

create schema auth;
create schema storage;
create schema extensions;
create extension pgcrypto with schema extensions;

alter schema public owner to pg_database_owner;
revoke all on schema public from public, anon, authenticated, service_role, postgres;
grant usage on schema public to public, anon, authenticated, service_role, postgres;
-- These are the observed managed-project defaults, including their broad
-- grants. The exact application migrations must remove unsafe actual grants.
alter default privileges for role postgres in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant usage, select, update on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant execute on functions to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant usage, select, update on sequences to postgres, anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email varchar(255),
  email_confirmed_at timestamptz,
  phone text,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb default '{}',
  raw_app_meta_data jsonb default '{}',
  is_anonymous boolean not null default false,
  banned_until timestamptz,
  deleted_at timestamptz,
  email_change varchar(255) default '',
  email_change_confirm_status smallint default 0,
  phone_change text default '',
  phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz
);
-- Minimal observed native MFA contract, deliberately excluding factor secrets,
-- challenges and provider credentials. Supabase Auth owns these in production.
create type auth.aal_level as enum ('aal1','aal2','aal3');
create type auth.factor_type as enum ('totp','webauthn','phone','recovery_code');
create type auth.factor_status as enum ('unverified','verified');
create table auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  factor_type auth.factor_type not null,
  status auth.factor_status not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  not_after timestamptz,
  aal auth.aal_level,
  factor_id uuid
);
create table auth.mfa_amr_claims (
  session_id uuid not null references auth.sessions(id),
  authentication_method text not null,
  created_at timestamptz not null
);
grant usage on schema auth to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant all on storage.buckets to service_role;

-- Exact helper bodies from the read-only managed catalog captured 6 November 2026.
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

CREATE OR REPLACE FUNCTION storage.operation()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
    RETURN current_setting('storage.operation', true);
END;
$function$;

CREATE OR REPLACE FUNCTION storage.foldername(name text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
    _parts text[];
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Return everything except the last segment
    RETURN _parts[1 : array_length(_parts,1) - 1];
END
$function$;

CREATE OR REPLACE FUNCTION storage.allow_any_operation(expected_operations text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  WITH current_operation AS (
    SELECT storage.operation() AS raw_operation
  ),
  normalized AS (
    SELECT CASE
      WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
      ELSE raw_operation
    END AS current_operation
    FROM current_operation
  )
  SELECT EXISTS (
    SELECT 1
    FROM normalized n
    CROSS JOIN LATERAL unnest(expected_operations) AS expected_operation
    WHERE expected_operation IS NOT NULL
      AND expected_operation <> ''
      AND n.current_operation = CASE
        WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
        ELSE expected_operation
      END
  );
$function$;

CREATE OR REPLACE FUNCTION storage.allow_only_operation(expected_operation text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  WITH current_operation AS (
    SELECT storage.operation() AS raw_operation
  ),
  normalized AS (
    SELECT
      CASE
        WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
        ELSE raw_operation
      END AS current_operation,
      CASE
        WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
        ELSE expected_operation
      END AS requested_operation
    FROM current_operation
  )
  SELECT CASE
    WHEN requested_operation IS NULL OR requested_operation = '' THEN FALSE
    ELSE COALESCE(current_operation = requested_operation, FALSE)
  END
  FROM normalized;
$function$;
