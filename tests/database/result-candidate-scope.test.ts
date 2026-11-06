// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const patchPath = "supabase/migrations/20261106110537_bound_assessment_publication_candidates.sql";
const uuid = (suffix: number) => `76000000-0000-0000-0000-${String(suffix).padStart(12, "0")}`;
const otherTeacher = uuid(1), foreignTeacher = uuid(2), otherAssessment = uuid(11), foreignAssessment = uuid(12);
let db: PGlite;
type Metadata = { assessment_id: string; teacher_id: string; school_id: string; name: string };
type State = { source: string; owner: number; acl: string[]; settings: string[]; definer: boolean };
const baseline = new Map<string, Metadata[]>();
let originalState: State, patchedState: State, wrapperBefore: unknown, wrapperAfter: unknown;

async function state(name: string) {
  return (await db.query<State>(`select prosrc as source,proowner::integer as owner,proacl as acl,
    proconfig as settings,prosecdef as definer from pg_proc where oid=$1::regprocedure`, [name])).rows[0];
}
async function candidates(user: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
  await db.exec("set local role authenticated");
  try {
    return (await db.query<{ value: Metadata[] }>("select public.list_assessment_publication_candidates() as value")).rows[0].value;
  } finally { await db.exec("reset role").catch(() => {}); }
}

beforeAll(async () => {
  db = await createRecoveryDatabase({ applyPending: false });
  const steps = await readRecoverySources(await readRecoveryManifest());
  for (const step of steps.filter((s) => s.kind === "pending" && s.path !== patchPath)) await db.exec(step.sql);
  await seedRecoveryData(db);
  for (const [user, school, year, klass, section, subject, assessment, record, assignment] of [
    [otherTeacher, id.schoolA, id.yearA, id.classA, id.sectionA, id.subjectA, otherAssessment, uuid(21), uuid(31)],
    [foreignTeacher, id.schoolB, id.yearB, id.classB, id.sectionB, id.subjectB, foreignAssessment, uuid(22), uuid(32)],
  ]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@candidate.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, school]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [user, school]);
    await db.query("insert into public.teachers(id,school_id,profile_id,employee_id) values($1,$2,$3,$4)", [record, school, user, `CANDIDATE-${user}`]);
    await db.query("insert into public.teacher_subject_assignments(id,teacher_id,academic_year_id,class_id,section_id,subject_id) values($1,$2,$3,$4,$5,$6)", [assignment, record, year, klass, section, subject]);
    await db.query(`insert into public.teacher_assessments(id,school_id,academic_year_id,class_id,section_id,subject_id,teacher_id,name,assessment_date,maximum_marks)
      values($1,$2,$3,$4,$5,$6,$7,'Synthetic candidate assessment','2026-11-05',100)`, [assessment, school, year, klass, section, subject, record]);
  }
  originalState = await state("app_private.list_assessment_publication_candidates()");
  wrapperBefore = await state("public.list_assessment_publication_candidates()");
  await db.exec("begin");
  for (const user of [id.teacherA, otherTeacher, foreignTeacher]) baseline.set(user, await candidates(user));
  await db.exec("rollback");
  await db.exec(await readFile(new URL(`../../${patchPath}`, import.meta.url), "utf8"));
  patchedState = await state("app_private.list_assessment_publication_candidates()");
  wrapperAfter = await state("public.list_assessment_publication_candidates()");
});
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("bounded publication candidate metadata", () => {
  it.each([id.teacherA, otherTeacher, foreignTeacher])("preserves the complete prior payload for its teacher %s", async (teacher) => {
    const rows = await candidates(teacher);
    expect(rows).toEqual(baseline.get(teacher));
    expect(rows).toHaveLength(1);
  });

  it("does not include other-teacher or other-school metadata", async () => {
    expect((await candidates(id.teacherA)).map((row) => row.assessment_id)).toEqual([id.assessmentA]);
    expect((await candidates(otherTeacher)).map((row) => row.assessment_id)).toEqual([otherAssessment]);
    expect((await candidates(foreignTeacher)).map((row) => row.assessment_id)).toEqual([foreignAssessment]);
  });

  it.each([id.studentUserA, id.guardianA])("still exposes no candidate metadata to family identity %s", async (user) => {
    expect(await candidates(user)).toEqual([]);
  });

  it("retains assignment revocation instead of trusting only a teacher profile match", async () => {
    await db.query("delete from public.teacher_subject_assignments where id=$1", [id.assignmentA]);
    expect(await candidates(id.teacherA)).toEqual([]);
  });

  it("retains the verified active-account guard", async () => {
    await db.query("update public.profiles set is_active=false where id=$1", [id.teacherA]);
    await expect(candidates(id.teacherA)).rejects.toMatchObject({ code: "42501" });
  });

  it("changes only the bounding predicate and preserves owner, ACL, search path and public wrapper", () => {
    expect(patchedState.source).toBe(originalState.source.replace(
      "from app_private.assessment_result_metadata m where app_private.result_teacher_access(m.assessment_id)",
      "from app_private.assessment_result_metadata m where m.teacher_profile=(select auth.uid())\n      and app_private.result_teacher_access(m.assessment_id)",
    ));
    const { source: beforeSource, ...before } = originalState;
    const { source: afterSource, ...after } = patchedState;
    expect(beforeSource).not.toBe(afterSource);
    expect(after).toEqual(before);
    expect(wrapperAfter).toEqual(wrapperBefore);
  });
});
