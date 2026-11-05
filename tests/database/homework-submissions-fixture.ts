import { readFile,readdir } from "node:fs/promises";
import { createAcademicPermissionDatabase } from "./academic-permissions-fixture";

const directory=new URL("../../supabase/migrations/",import.meta.url);
export async function readHomeworkSubmissionSql() {
  const files=(await readdir(directory)).filter(name=>name.endsWith("_atomic_homework_submission_and_grading.sql"));
  if(files.length!==1) throw new Error("Expected one homework submission/grading migration.");
  return readFile(new URL(files[0],directory),"utf8");
}

/** Existing academic contracts plus the bounded provider-owned Storage catalog
 * fields used by attachment validation. Storage operation policies are applied
 * separately by their own test suite; these are not mocks of academic access. */
export async function createHomeworkSubmissionDatabase({applyMigration=true}={}) {
  const db=await createAcademicPermissionDatabase();
  try {
    await db.exec(`create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,owner_id text,metadata jsonb,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,anon;
      grant select,insert,update,delete on storage.objects to authenticated;
      create function storage.allow_any_operation(expected_operations text[]) returns boolean language sql stable as $$
        select coalesce(case when current_setting('storage.operation',true) like 'storage.%'
          then substr(current_setting('storage.operation',true),9) else current_setting('storage.operation',true) end = any(expected_operations),false) $$;
      create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$
        select storage.allow_any_operation(array[expected_operation]) $$;`);
    if(applyMigration) {
      await db.exec(await readHomeworkSubmissionSql());
      const files=await readdir(directory);
      const conflict=files.find(name=>name.endsWith("_homework_optimistic_conflict_http_status.sql"));
      if(!conflict) throw new Error("Missing homework optimistic conflict HTTP correction.");
      await db.exec(await readFile(new URL(conflict,directory),"utf8"));
    }
    return db;
  } catch(error) { await db.close(); throw error; }
}
