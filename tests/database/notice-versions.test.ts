// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as placements } from "./staff-scope-fixture";

let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;
const schoolWide = { roles: ["student", "parent", "teacher", "staff"] };
const teacherOnly = { roles: ["teacher"] };
type Notice = { id: string; version: string; title: string; content: string; audience: unknown; published_at: string | null };
const migration = new URL("../../supabase/migrations/20261105191227_notice_optimistic_versions.sql", import.meta.url);
const acl = `select c.relacl::text as table_acl,
  has_schema_privilege('authenticated','app_private','CREATE') as client_create,
  has_schema_privilege('anon','app_private','CREATE') as anon_create
  from pg_class c where c.oid='public.notices'::regclass`;
let beforeRows: { row: unknown }[];
let beforeAcl: unknown;

beforeAll(async () => {
  db = await createStaffScopeDatabase({ applyGovernance: true });
  await db.exec(await readFile(new URL("../../supabase/migrations/20261104113103_secure_notice_audiences.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/20261105184939_require_active_role_assignment_actor.sql", import.meta.url), "utf8"));
  beforeRows = (await db.query<{ row: unknown }>("select to_jsonb(n) as row from public.notices n order by id")).rows;
  beforeAcl = (await db.query(acl)).rows;
  await db.exec(await readFile(migration, "utf8"));
}, 15_000);
afterAll(async () => { await db?.close(); });

async function seed() {
  const result = await db.query<Notice>(`insert into public.notices(school_id,title,content,audience,published_at,created_by)
    values($1,'Reminder','Original copy',$2,now()-interval '1 day',$3) returning *`, [actors.schoolA, JSON.stringify(schoolWide), actors.adminA]);
  return result.rows[0];
}

async function read(id: string) {
  return (await db.query<Notice>("select * from public.notices where id=$1", [id])).rows[0];
}

it("backfills tokens without changing any original business values or broadening grants", async () => {
  expect((await db.query("select to_jsonb(n)-'version' as row from public.notices n order by id")).rows).toEqual(beforeRows);
  expect((await db.query(acl)).rows).toEqual(beforeAcl);
  const versions = (await db.query<{ version: string }>("select version from public.notices")).rows.map((r) => r.version);
  expect(versions.length).toBeGreaterThan(0);
  expect(new Set(versions).size).toBe(versions.length);
  for (const version of versions) expect(version).toMatch(/^[0-9a-f-]{36}$/);
  expect((await db.query("select has_function_privilege('anon','app_private.issue_notice_version()','EXECUTE') as anon_exec, has_function_privilege('authenticated','app_private.issue_notice_version()','EXECUTE') as client_exec")).rows).toEqual([{ anon_exec: false, client_exec: false }]);
});

it("rejects the original stale edit that would republish an Everyone notice after a principal restricted it", async () => {
  const original = await seed();
  const fresh = await asStaffActor<Notice>(db, actors.principalA,
    "update public.notices set audience=$1,published_at=null where id=$2 and version=$3 returning *",
    [JSON.stringify(teacherOnly), original.id, original.version]);
  expect(fresh.rows).toHaveLength(1);
  const current = await read(original.id);
  expect(current.version).not.toBe(original.version);
  const stale = await asStaffActor(db, actors.adminA,
    "update public.notices set title='Stale title',content=$1,audience=$2,published_at=$3 where id=$4 and school_id=$5 and version=$6 returning id",
    [original.content, JSON.stringify(original.audience), original.published_at, original.id, actors.schoolA, original.version]);
  expect(stale.rows).toEqual([]);
  expect(await read(original.id)).toEqual(current);
  expect((await asStaffActor(db, actors.parentA, "select id from public.notices where id=$1", [original.id])).rows).toEqual([]);
  expect((await asStaffActor(db, actors.studentA, "select id from public.notices where id=$1", [original.id])).rows).toEqual([]);
});

it("detects ABA and rotates the version even for no-op updates or a caller-supplied old token", async () => {
  const original = await seed();
  const business = (await db.query("select to_jsonb(n)-'version' as row from public.notices n where id=$1", [original.id])).rows;
  await asStaffActor(db, actors.principalA, "update public.notices set audience=$1 where id=$2", [JSON.stringify(teacherOnly), original.id]);
  await asStaffActor(db, actors.principalA, "update public.notices set audience=$1,version=$2 where id=$3", [JSON.stringify(schoolWide), original.version, original.id]);
  expect((await db.query("select to_jsonb(n)-'version' as row from public.notices n where id=$1", [original.id])).rows).toEqual(business);
  const restored = await read(original.id);
  expect(restored.version).not.toBe(original.version);
  expect((await asStaffActor(db, actors.adminA, "update public.notices set title='Lost update' where id=$1 and version=$2 returning id", [original.id, original.version])).rows).toEqual([]);
  await asStaffActor(db, actors.adminA, "update public.notices set title=title where id=$1", [original.id]);
  expect((await read(original.id)).version).not.toBe(restored.version);
});

it("applies the same version comparison to publish status and deletion while reviewed retries work", async () => {
  const original = await seed();
  await asStaffActor(db, actors.principalA, "update public.notices set content='New office copy' where id=$1", [original.id]);
  const current = await read(original.id);
  expect((await asStaffActor(db, actors.adminA, "update public.notices set published_at=null where id=$1 and version=$2 returning id", [original.id, original.version])).rows).toEqual([]);
  expect((await asStaffActor(db, actors.adminA, "delete from public.notices where id=$1 and version=$2 returning id", [original.id, original.version])).rows).toEqual([]);
  expect(await read(original.id)).toEqual(current);
  expect((await asStaffActor(db, actors.adminA, "delete from public.notices where id=$1 and version=$2 returning id", [original.id, current.version])).rows).toEqual([{ id: original.id }]);
});

it("rotates tokens for trusted service updates and teacher inserts without changing their existing authority", async () => {
  const original = await seed();
  await asStaffActor(db, null, "update public.notices set title='Trusted service edit' where id=$1", [original.id], "service_role");
  expect((await read(original.id)).version).not.toBe(original.version);
  const teacher = await asStaffActor<Notice>(db, actors.teacherA,
    `insert into public.notices(school_id,title,content,audience,created_by,version)
     values($1,'Teacher notice','Assigned scope',$2,$3,$4) returning *`,
    [actors.schoolA, JSON.stringify({ roles: ["student", "parent"], teacher_id: placements.A.teacher }), actors.teacherA, original.version]);
  expect(teacher.rows).toHaveLength(1);
  expect(teacher.rows[0].version).not.toBe(original.version);
  const before = await read(teacher.rows[0].id);
  expect((await asStaffActor(db, actors.teacherB, "update public.notices set title='Wrong teacher' where id=$1 returning id", [before.id])).rows).toEqual([]);
  expect((await asStaffActor(db, actors.parentA, "update public.notices set title='Family write' where id=$1 returning id", [before.id])).rows).toEqual([]);
  expect(await read(before.id)).toEqual(before);
});

it("does not allow a matching version to bypass wrong-school, inactive-account or anonymous authorization", async () => {
  const original = await seed();
  expect((await asStaffActor(db, actors.adminB, "update public.notices set title='Foreign write' where id=$1 and version=$2 returning id", [original.id, original.version])).rows).toEqual([]);
  await db.query("update public.profiles set is_active=false where id=$1", [actors.adminA]);
  try {
    expect((await asStaffActor(db, actors.adminA, "update public.notices set title='Inactive write' where id=$1 and version=$2 returning id", [original.id, original.version])).rows).toEqual([]);
  } finally { await db.query("update public.profiles set is_active=true where id=$1", [actors.adminA]); }
  await expect(asStaffActor(db, null, "update public.notices set title='Anon write' where id=$1 and version=$2 returning id", [original.id, original.version], "anon")).rejects.toMatchObject({ code: "42501" });
  expect(await read(original.id)).toEqual(original);
});
