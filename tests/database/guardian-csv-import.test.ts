// @vitest-environment node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as fixtures } from "./staff-scope-fixture";

type Input = { admissionNumber: string; email: string; studentId?: string };
type PreviewRow = { row_number: number; admission_no: string | null; email: string | null; student_id: string | null; error: string | null };
type Invitation = { row_number: number; id: string; email: string; student_id: string; token: string; expires_at: string };
type Receipt = { request_id: string; invitations: Invitation[] };

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);
const previewSql = "select public.preview_guardian_invitation_import($1,$2::jsonb) as result";
const importSql = "select public.import_guardian_invitations($1,$2,$3,$4::jsonb) as result";
const verifiedEmail = "csv-guardian@example.test";
const inputA = (email: string): Input => ({ admissionNumber: "STUDENT-A", email, studentId: fixtures.A.student });
const inputSibling = (email: string): Input => ({ admissionNumber: "PRIVATE-A", email, studentId: fixtures.privateStudentA });

describe("guardian invitation CSV import", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
    const files = await readdir(migrationDirectory);
    for (const suffix of [
      "_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_revoke_guardian_access.sql", "_import_guardian_csv.sql",
    ]) {
      const file = files.find((name) => name.endsWith(suffix));
      if (!file) throw new Error(`Missing migration ${suffix}`);
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
    }
    await db.query("update auth.users set email=$2 where id=$1", [actors.outsider, verifiedEmail]);
    await db.query("update auth.users set email=$2,email_confirmed_at=now() where id=$1", [actors.parentA, "existing-guardian@example.test"]);
  }, 30_000);

  afterAll(async () => { await db?.close(); });

  async function preview(rows: unknown, actor: string = actors.adminA, schoolId: string = actors.schoolA) {
    const { rows: [row] } = await asStaffActor<{ result: PreviewRow[] }>(db, actor, previewSql, [schoolId, JSON.stringify(rows)]);
    return row.result;
  }

  function batchArgs(rows: unknown, requestId = randomUUID(), deliveryKey = randomBytes(32).toString("hex")) {
    return [actors.schoolA, requestId, deliveryKey, JSON.stringify(rows)];
  }

  async function issue(args: ReturnType<typeof batchArgs>, actor: string = actors.adminA) {
    const { rows: [row] } = await asStaffActor<{ result: Receipt }>(db, actor, importSql, args);
    return row.result;
  }

  function accept(token: string, actor: string = actors.outsider) {
    return asStaffActor(db, actor, "select public.accept_guardian_invitation($1) as result", [token]);
  }

  it("previews exact same-school active admissions, recipient mistakes and duplicates without writing", async () => {
    const addresses = [
      { admissionNumber: " STUDENT-A ", email: " First@Example.TEST " },
      { admissionNumber: "STUDENT-B", email: "other@example.test" },
      { admissionNumber: "student-a", email: "case@example.test" },
      { admissionNumber: "PRIVATE-A", email: "wrong email" },
      inputA(" repeat@example.test "),
      inputA("REPEAT@example.test"),
      inputA("EXISTING-GUARDIAN@example.test"),
      { admissionNumber: 1000, email: "numeric@example.test" },
    ];
    await expect(preview(addresses, actors.adminB)).rejects.toMatchObject({ code: "42501" });
    await expect(preview(addresses, actors.teacherA)).rejects.toMatchObject({ code: "42501" });
    await expect(preview(addresses, actors.parentA)).rejects.toMatchObject({ code: "42501" });
    await expect(preview([], actors.principalA)).rejects.toMatchObject({ code: "22023" });
    await expect(preview(Array.from({ length: 51 }, () => inputA("large@example.test")))).rejects.toMatchObject({ code: "22023" });
    await expect(asStaffActor(db, null, previewSql, [actors.schoolA, JSON.stringify(addresses)], "anon")).rejects.toMatchObject({ code: "42501" });
    const results = await preview(addresses, actors.principalA);
    expect(results).toEqual([
      expect.objectContaining({ row_number: 1, admission_no: "STUDENT-A", email: "first@example.test", student_id: fixtures.A.student, error: null }),
      expect.objectContaining({ row_number: 2, student_id: null, error: expect.stringContaining("No active student") }),
      expect.objectContaining({ row_number: 3, student_id: null, error: expect.stringContaining("No active student") }),
      expect.objectContaining({ row_number: 4, error: expect.stringContaining("valid guardian email") }),
      expect.objectContaining({ row_number: 5, error: expect.stringContaining("repeated") }),
      expect.objectContaining({ row_number: 6, error: expect.stringContaining("repeated") }),
      expect.objectContaining({ row_number: 7, error: expect.stringContaining("already linked") }),
      expect.objectContaining({ row_number: 8, error: expect.stringContaining("valid admission number") }),
    ]);
    expect((await db.query("select id from app_private.guardian_invitations")).rows).toEqual([]);
  });

  it("rejects unauthorized, wrong-scope, stale, or inactive rows without changing existing invitations", async () => {
    const rows = [inputA("canary@example.test"), inputSibling("stale@example.test")];
    for (const actor of [actors.adminB, actors.teacherA, actors.accountantA, actors.parentA]) {
      await expect(issue(batchArgs(rows), actor)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(issue(batchArgs(rows, randomUUID(), "short"))).rejects.toMatchObject({ code: "22023" });
    await expect(issue(batchArgs([rows[0], { ...rows[1], studentId: fixtures.B.student }]))).rejects.toThrow("row 2 changed since preview");
    await expect(issue(batchArgs([rows[0], { ...rows[1], admissionNumber: "STUDENT-B" }]))).rejects.toThrow("row 2");
    const stagedYear = randomUUID();
    const stagedEnrollment = randomUUID();
    await db.query("insert into public.academic_years(id,school_id,name,start_date,end_date,is_current) values($1,$2,'Staged year','2027-04-01','2028-03-31',false)",
      [stagedYear, actors.schoolA]);
    await db.query("insert into public.enrollments(id,student_id,academic_year_id,class_id,section_id,status) values($1,$2,$3,$4,$5,'staged')",
      [stagedEnrollment, fixtures.privateStudentA, stagedYear, fixtures.privateClassA, fixtures.privateSectionA]);
    await db.query("update public.enrollments set status='withdrawn' where id=$1", [fixtures.privateEnrollmentA]);
    try {
      await expect(issue(batchArgs(rows))).rejects.toThrow("row 2");
      expect((await preview([rows[1]]))[0]).toMatchObject({ student_id: null, error: expect.stringContaining("No active student") });
    } finally {
      await db.query("update public.enrollments set status='active' where id=$1", [fixtures.privateEnrollmentA]);
      await db.query("delete from public.enrollments where id=$1", [stagedEnrollment]);
      await db.query("delete from public.academic_years where id=$1", [stagedYear]);
    }
    const { rows: [single] } = await asStaffActor<{ invite: { id: string } }>(
      db, actors.adminA, "select public.issue_guardian_invitation($1,$2,$3) as invite", [actors.schoolA, fixtures.privateStudentA, rows[1].email],
    );
    expect((await preview([rows[1]]))[0].error).toContain("active invitation already exists");
    await expect(issue(batchArgs(rows))).rejects.toThrow("row 2");
    expect((await db.query("select id,revoked_at from app_private.guardian_invitations")).rows).toEqual([{ id: single.invite.id, revoked_at: null }]);
    expect((await db.query("select request_id from app_private.guardian_invitation_imports")).rows).toEqual([]);
  });

  it("rolls back earlier insertions and the batch receipt if an issuance fails mid-transaction", async () => {
    await db.exec(`
      create function app_private.test_reject_guardian_csv() returns trigger language plpgsql as $$
      begin
        if new.email = 'fail-second@example.test' then raise exception 'Test insert failure'; end if;
        return new;
      end;
      $$;
      create trigger test_reject_guardian_csv before insert on app_private.guardian_invitations
      for each row execute function app_private.test_reject_guardian_csv();
    `);
    const rows = [inputA("insert-first@example.test"), inputSibling("fail-second@example.test")];
    try {
      await expect(issue(batchArgs(rows))).rejects.toThrow("Test insert failure");
      expect((await db.query("select id from app_private.guardian_invitations where email = any($1)", [rows.map((row) => row.email)])).rows).toEqual([]);
      expect((await db.query("select request_id from app_private.guardian_invitation_imports")).rows).toEqual([]);
    } finally {
      await db.exec("drop trigger test_reject_guardian_csv on app_private.guardian_invitations; drop function app_private.test_reject_guardian_csv()");
    }
  });

  it("replays live links for the same reviewer and only binds verified guardians on acceptance", async () => {
    const rows = [
      inputSibling(" CSV-Guardian@example.TEST "),
      inputA(verifiedEmail),
      inputA("other-authorized@example.test"),
    ];
    const requestId = randomUUID();
    const deliveryKey = randomBytes(32).toString("hex");
    const args = batchArgs(rows, requestId, deliveryKey);
    const imported = await issue(args, actors.principalA);
    expect(imported.request_id).toBe(requestId);
    expect(imported.invitations.map(({ row_number, email, student_id }) => ({ row_number, email, student_id }))).toEqual([
      { row_number: 1, email: verifiedEmail, student_id: fixtures.privateStudentA },
      { row_number: 2, email: verifiedEmail, student_id: fixtures.A.student },
      { row_number: 3, email: rows[2].email, student_id: fixtures.A.student },
    ]);
    expect(new Set(imported.invitations.map(({ token }) => token)).size).toBe(3);
    expect(imported.invitations.every(({ token }) => /^[0-9a-f]{64}$/.test(token))).toBe(true);
    expect(await issue(args, actors.principalA)).toEqual(imported);
    await db.query("update public.enrollments set status='withdrawn' where id=$1", [fixtures.privateEnrollmentA]);
    try {
      await expect(issue(args, actors.principalA)).rejects.toMatchObject({ code: "55000" });
    } finally {
      await db.query("update public.enrollments set status='active' where id=$1", [fixtures.privateEnrollmentA]);
    }
    await expect(issue(args, actors.adminA)).rejects.toMatchObject({ code: "23505" });
    await expect(issue(batchArgs(rows, requestId), actors.principalA)).rejects.toMatchObject({ code: "23505" });
    await expect(issue(batchArgs([...rows].reverse(), requestId, deliveryKey), actors.principalA)).rejects.toMatchObject({ code: "23505" });
    await expect(issue(batchArgs(rows), actors.principalA)).rejects.toMatchObject({ code: "22023" });

    const stored = await db.query<{ actor_id: string; invitations: unknown }>(
      "select actor_id,invitations from app_private.guardian_invitation_imports where request_id=$1", [requestId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].actor_id).toBe(actors.principalA);
    expect(JSON.stringify(stored.rows)).not.toContain(deliveryKey);
    for (const { id, token } of imported.invitations) {
      expect(JSON.stringify(stored.rows)).not.toContain(token);
      expect((await db.query("select encode(token_hash,'hex') as hash from app_private.guardian_invitations where id=$1", [id])).rows)
        .toEqual([{ hash: createHash("sha256").update(token).digest("hex") }]);
    }
    await expect(asStaffActor(db, actors.adminA, "select * from app_private.guardian_invitation_imports")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select role from public.user_roles where user_id=$1", [actors.outsider])).rows).toEqual([]);
    expect((await db.query("select id from public.parents where profile_id=$1", [actors.outsider])).rows).toEqual([]);
    await expect(accept(imported.invitations[0].token)).rejects.toMatchObject({ code: "42501" });
    await expect(accept(imported.invitations[0].token, actors.parentA)).rejects.toMatchObject({ code: "42501" });

    await db.query("update auth.users set email_confirmed_at=now() where id=$1", [actors.outsider]);
    for (const invitation of imported.invitations.slice(0, 2)) {
      expect((await accept(invitation.token)).rows).toEqual([{ result: { school_id: actors.schoolA, student_id: invitation.student_id } }]);
    }
    expect((await db.query("select role from public.user_roles where user_id=$1", [actors.outsider])).rows).toEqual([{ role: "parent" }]);
    expect((await db.query("select student_id from app_private.guardian_access_audit where guardian_profile_id=$1 order by student_id", [actors.outsider])).rows)
      .toEqual([{ student_id: fixtures.A.student }, { student_id: fixtures.privateStudentA }]);
    await expect(issue(args, actors.principalA)).rejects.toMatchObject({ code: "55000" });
    expect((await preview([rows[0], rows[1]])).every((row) => row.error?.includes("already linked"))).toBe(true);
    await db.query("update auth.users set email='new-csv-guardian@example.test' where id=$1", [actors.outsider]);
    expect((await preview([rows[1]]))[0].error).toContain("already linked");
  });

  it("replaces an expired invitation without touching any other recipient", async () => {
    const expired = inputA("expired-csv-invite@example.test");
    const originalArgs = batchArgs([expired]);
    const original = (await issue(originalArgs)).invitations[0];
    await db.query(`update app_private.guardian_invitations set created_at=now()-interval '4 days',
      expires_at=now()-interval '1 day' where id=$1`, [original.id]);
    expect((await preview([expired]))[0].error).toBeNull();
    await expect(issue(originalArgs)).rejects.toMatchObject({ code: "55000" });
    const fresh = (await issue(batchArgs([expired]))).invitations[0];
    expect(fresh.id).not.toBe(original.id);
    expect(fresh.token).not.toBe(original.token);
    expect((await db.query("select id, revoked_at from app_private.guardian_invitations where email=$1 order by created_at", [expired.email])).rows)
      .toEqual([{ id: original.id, revoked_at: expect.any(Date) }, { id: fresh.id, revoked_at: null }]);
  });
});
