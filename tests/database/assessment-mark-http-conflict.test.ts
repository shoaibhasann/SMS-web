// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";
import { asStaffActor } from "./staff-scope-fixture";

const directory = new URL("../../supabase/migrations/", import.meta.url);
const basePatches = [
  "20261105184935_freeze_legacy_client_mutations.sql",
  "20261105184937_revoke_assessment_access_on_role_removal.sql",
  "20261105184939_require_active_role_assignment_actor.sql",
  "20261105184942_atomic_student_account_activation.sql",
  "20261105191227_notice_optimistic_versions.sql",
  "20261105192540_optimistic_assessment_mark_writes.sql",
];
const signature = "public.save_assessment_mark(uuid,timestamptz,uuid,uuid,timestamptz,numeric,text,numeric,text)";
const rpc = `select public.save_assessment_mark($1::uuid,$2::timestamptz,$3::uuid,$4::uuid,
  $5::timestamptz,$6::numeric,$7::text,$8::numeric,$9::text) as mark`;
type Parent = { id: string; updated_at: string };
type Mark = { id: string; assessment_id: string; student_id: string; updated_at: string; marks_obtained: string; remarks: string | null };
type Saved = { id: string; assessment_id: string; student_id: string; marks_obtained: number; remarks: string | null };
type Routine = { oid: string; body: string; definition: string; acl: string | null; owner: string; config: string[] | null; security_definer: boolean };
let db: PGlite;
let patch: string;
let originalRoutine: Routine;
let fixedRoutine: Routine;
let originalRows: Record<string, string[]>;
let fixedRows: Record<string, string[]>;

async function routine(connection = db) {
  return (await connection.query<Routine>(`select p.oid::text as oid,p.prosrc as body,
    pg_get_functiondef(p.oid) as definition,p.proacl::text as acl,p.proowner::text as owner,
    p.proconfig as config,p.prosecdef as security_definer from pg_proc p where p.oid=$1::regprocedure`, [signature])).rows[0];
}
async function businessRows() {
  const snapshot: Record<string, string[]> = {};
  for (const table of ["teacher_assessments", "teacher_assessment_marks", "attendance", "student_fees", "fee_payments"]) {
    snapshot[table] = (await db.query<{ row: string }>(`select to_jsonb(t)::text as row from public.${table} t order by id`)).rows.map((row) => row.row);
  }
  return snapshot;
}
async function parent() {
  return (await db.query<Parent>("select id,updated_at::text from public.teacher_assessments where id=$1", [id.assessmentA])).rows[0];
}
async function mark() {
  return (await db.query<Mark>(`select id,assessment_id,student_id,updated_at::text,marks_obtained::text,remarks
    from public.teacher_assessment_marks where id=$1`, [id.markA])).rows[0];
}
const args = (assessment: Parent, before: Mark, score: number): unknown[] => [assessment.id, assessment.updated_at,
  before.student_id, before.id, before.updated_at, before.marks_obtained, before.remarks, score, "HTTP conflict regression"];

beforeAll(async () => {
  // Exercise the exact six original security/mark patches before the HTTP-only
  // correction. Historical phase-six tests deliberately keep their 40001 checks.
  db = await createRecoveryDatabase({ applyPending: false });
  for (const filename of basePatches) await db.exec(await readFile(new URL(filename, directory), "utf8"));
  await seedRecoveryData(db);
  patch = await readFile(new URL("20261106105822_assessment_mark_conflict_http_status.sql", directory), "utf8");
  originalRoutine = await routine();
  originalRows = await businessRows();
  await db.exec(patch);
  fixedRoutine = await routine();
  fixedRows = await businessRows();
}, 60_000);
afterAll(async () => { await db?.close(); });

it("changes only the two logical CAS SQLSTATEs, preserving source logic, identity, ACL, owner and invoker settings", async () => {
  expect(originalRoutine.body.match(/errcode='40001'/g)).toHaveLength(2);
  expect(fixedRoutine).toEqual({ ...originalRoutine,
    body: originalRoutine.body.replaceAll("errcode='40001'", "errcode='PT409'"),
    definition: originalRoutine.definition.replaceAll("errcode='40001'", "errcode='PT409'"),
  });
  expect(fixedRoutine.security_definer).toBe(false);
  expect(fixedRoutine.config).toEqual(['search_path=""']);
  expect(fixedRows).toEqual(originalRows);
  expect((await db.query(`select has_function_privilege('authenticated',$1,'EXECUTE') as authenticated,
    has_function_privilege('service_role',$1,'EXECUTE') as service,
    has_function_privilege('anon',$1,'EXECUTE') as anonymous`, [signature])).rows)
    .toEqual([{ authenticated: true, service: true, anonymous: false }]);
});

it("returns PT409 for a stale parent without changing marks, and accepts an explicitly refreshed save", async () => {
  const loadedParent = await parent(), loadedMark = await mark();
  await asStaffActor(db, id.teacherA, "update public.teacher_assessments set description='Concurrent source edit' where id=$1", [id.assessmentA]);
  const unchanged = await businessRows();
  await expect(asStaffActor(db, id.teacherA, rpc, args(loadedParent, loadedMark, 75))).rejects.toMatchObject({ code: "PT409" });
  expect(await businessRows()).toEqual(unchanged);
  expect((await asStaffActor<{ mark: Saved }>(db, id.teacherA, rpc, args(await parent(), loadedMark, 75))).rows[0].mark)
    .toMatchObject({ id: loadedMark.id, marks_obtained: 75 });
});

it("returns PT409 for a stale mark without overwriting the newer row, then permits a fresh baseline", async () => {
  const loadedParent = await parent(), loadedMark = await mark();
  await asStaffActor(db, id.teacherA, rpc, args(loadedParent, loadedMark, 76));
  const unchanged = await businessRows();
  await expect(asStaffActor(db, id.teacherA, rpc, args(loadedParent, loadedMark, 77))).rejects.toMatchObject({ code: "PT409" });
  expect(await businessRows()).toEqual(unchanged);
  expect((await asStaffActor<{ mark: Saved }>(db, id.teacherA, rpc, args(await parent(), await mark(), 77))).rows[0].mark)
    .toMatchObject({ id: loadedMark.id, marks_obtained: 77 });
});

it("still accepts a legitimate zero and rejects unauthorized or inactive callers without writes", async () => {
  const saved = await asStaffActor<{ mark: Saved }>(db, id.teacherA, rpc, args(await parent(), await mark(), 0));
  expect(saved.rows[0].mark).toMatchObject({ id: id.markA, student_id: id.pupilA, marks_obtained: 0 });
  const loadedParent = await parent(), loadedMark = await mark(), unchanged = await businessRows();
  for (const actor of [null, id.guardianA, id.studentUserA, id.adminB]) {
    await expect(asStaffActor(db, actor, rpc, args(loadedParent, loadedMark, 10))).rejects.toThrow();
  }
  await expect(asStaffActor(db, null, rpc, args(loadedParent, loadedMark, 10), "anon")).rejects.toMatchObject({ code: "42501" });
  await db.query("update public.profiles set is_active=false where id=$1", [id.teacherA]);
  try { await expect(asStaffActor(db, id.teacherA, rpc, args(loadedParent, loadedMark, 10))).rejects.toThrow(); }
  finally { await db.query("update public.profiles set is_active=true where id=$1", [id.teacherA]); }
  expect(await businessRows()).toEqual(unchanged);
});

it("fails repeated-application preflight atomically rather than silently patching an unexpected body", async () => {
  const beforeRoutine = await routine(), beforeRows = await businessRows();
  try { await expect(db.exec(patch)).rejects.toThrow(/Expected exactly two deterministic conflicts/); }
  finally { await db.exec("rollback"); }
  expect(await routine()).toEqual(beforeRoutine);
  expect(await businessRows()).toEqual(beforeRows);
});

it("fails atomically when the governed RPC is absent", async () => {
  const empty = new PGlite();
  try {
    await expect(empty.exec(patch)).rejects.toThrow(/governed mark-save RPC must exist/);
    await empty.exec("rollback");
    expect((await empty.query("select to_regprocedure($1) is null as absent", [signature])).rows).toEqual([{ absent: true }]);
    expect((await empty.query("select count(*)::int as routines from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")).rows)
      .toEqual([{ routines: 0 }]);
  } finally { await empty.close(); }
});
