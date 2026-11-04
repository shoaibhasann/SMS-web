// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);

describe("withdrawal from the active roster", () => {
  it("audits an authorized withdrawal atomically and preserves student and guardian history", async () => {
    const db = await createStaffScopeDatabase({
      includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true,
    });
    try {
      const files = await readdir(migrationDirectory);
      for (const suffix of ["_repair_school_policy_helper.sql", "_guardian_invitations.sql", "_withdraw_roster_enrollment.sql"]) {
        const file = files.find((name) => name.endsWith(suffix));
        if (!file) throw new Error(`Missing migration: ${suffix}`);
        await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));
      }

      const scope = [STAFF_IDS.schoolA, STAFF_ROWS.A.year, STAFF_ROWS.A.class, STAFF_ROWS.A.section];
      const reason = "Family relocation";
      const withdrawSql = "select public.withdraw_roster_enrollment($1,$2,$3,$4,$5,$6) as id";
      const listSql = "select * from public.list_roster_withdrawals($1,$2,$3,$4)";
      const withdraw = (actor: string, requestedReason = reason, section = scope[3]) => asStaffActor(
        db, actor, withdrawSql, [...scope.slice(0, 3), section, STAFF_ROWS.A.student, requestedReason],
      );

      await expect(withdraw(STAFF_IDS.adminB)).rejects.toMatchObject({ code: "42501" });
      await expect(withdraw(STAFF_IDS.teacherA)).rejects.toMatchObject({ code: "42501" });
      await expect(withdraw(STAFF_IDS.accountantA)).rejects.toMatchObject({ code: "42501" });
      await expect(withdraw(STAFF_IDS.adminA, "  ")).rejects.toMatchObject({ code: "22023" });
      await expect(withdraw(STAFF_IDS.adminA, reason, STAFF_ROWS.B.section)).rejects.toMatchObject({ code: "22023" });
      await expect(asStaffActor(db, STAFF_IDS.adminA,
        "update public.enrollments set status = 'withdrawn' where id = $1", [STAFF_ROWS.A.enrollment]))
        .rejects.toMatchObject({ code: "42501" });

      const inviteEmail = "new-guardian@example.test";
      await db.query("update auth.users set email = $2, email_confirmed_at = now() where id = $1",
        [STAFF_IDS.outsider, inviteEmail]);
      const inviteSql = "select public.issue_guardian_invitation($1,$2,$3) as invite";
      const invitation = await asStaffActor<{ invite: { token: string } }>(
        db, STAFF_IDS.adminA, inviteSql, [scope[0], STAFF_ROWS.A.student, inviteEmail],
      );

      expect((await withdraw(STAFF_IDS.principalA)).rows).toEqual([{ id: STAFF_ROWS.A.enrollment }]);
      expect((await withdraw(STAFF_IDS.principalA, "  Family   relocation  ")).rows)
        .toEqual([{ id: STAFF_ROWS.A.enrollment }]);
      await expect(withdraw(STAFF_IDS.principalA, "A different reason")).rejects.toMatchObject({ code: "22023" });
      const enrollment = await db.query("select status from public.enrollments where id = $1", [STAFF_ROWS.A.enrollment]);
      expect(enrollment.rows).toEqual([{ status: "withdrawn" }]);

      const history = await asStaffActor(db, STAFF_IDS.adminA, listSql, scope);
      expect(history.rows).toEqual([expect.objectContaining({
        enrollment_id: STAFF_ROWS.A.enrollment,
        admission_no: "STUDENT-A",
        reason,
        withdrawn_by_name: "principalA",
      })]);
      expect((await db.query("select withdrawn_by from app_private.enrollment_withdrawals")).rows)
        .toEqual([{ withdrawn_by: STAFF_IDS.principalA }]);
      await expect(asStaffActor(db, STAFF_IDS.adminB, listSql, scope)).rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(db, STAFF_IDS.adminA, "select * from app_private.enrollment_withdrawals"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(db, STAFF_IDS.adminA,
        "update public.enrollments set status = 'active' where id = $1", [STAFF_ROWS.A.enrollment]))
        .rejects.toMatchObject({ code: "42501" });

      for (const actor of [STAFF_IDS.studentA, STAFF_IDS.parentA]) {
        expect((await asStaffActor(db, actor, "select status from public.attendance where student_id = $1", [STAFF_ROWS.A.student])).rows)
          .toEqual([{ status: "absent" }]);
        expect((await asStaffActor(db, actor, "select id from public.fee_payments where id = $1", [STAFF_ROWS.A.payment])).rows)
          .toEqual([{ id: STAFF_ROWS.A.payment }]);
      }
      await expect(asStaffActor(db, STAFF_IDS.outsider, "select public.accept_guardian_invitation($1)",
        [invitation.rows[0].invite.token])).rejects.toMatchObject({ code: "P0001" });
      await expect(asStaffActor(db, STAFF_IDS.adminA, inviteSql, [scope[0], STAFF_ROWS.A.student, inviteEmail]))
        .rejects.toMatchObject({ code: "P0001" });
    } finally {
      await db.close();
    }
  });
});
