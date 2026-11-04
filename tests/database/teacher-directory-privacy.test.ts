// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);

describe("teacher contact privacy and academic labels", () => {
  it("limits full teacher records to authorized staff and own profile while exposing only same-school labels", async () => {
    const db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
    try {
      const colleague = "ad871242-4156-41db-9d2e-c57d185d98da";
      await db.query(`
        insert into public.teachers (id, school_id, employee_id, full_name, registered_mobile)
        values ($1, $2, 'COLLEAGUE', 'Colleague A', '2222222222')
      `, [colleague, STAFF_IDS.schoolA]);
      await db.query("update public.teachers set registered_mobile = '1111111111' where id = $1", [STAFF_ROWS.A.teacher]);
      const contactSql = "select registered_mobile from public.teachers where id = $1";

      expect((await asStaffActor(db, STAFF_IDS.parentA, contactSql, [colleague])).rows)
        .toEqual([{ registered_mobile: "2222222222" }]);

      const file = (await readdir(migrationDirectory)).find((name) => name.endsWith("_scope_teacher_directory.sql"));
      if (!file) throw new Error("Teacher directory privacy migration is missing.");
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));

      for (const actor of [STAFF_IDS.parentA, STAFF_IDS.studentA, STAFF_IDS.teacherA, STAFF_IDS.adminB]) {
        expect((await asStaffActor(db, actor, contactSql, [colleague])).rows).toEqual([]);
      }
      expect((await asStaffActor(db, STAFF_IDS.teacherA, contactSql, [STAFF_ROWS.A.teacher])).rows)
        .toEqual([{ registered_mobile: "1111111111" }]);
      expect((await asStaffActor(db, STAFF_IDS.principalA, contactSql, [colleague])).rows)
        .toEqual([{ registered_mobile: "2222222222" }]);

      const labelsSql = "select * from public.academic_teacher_labels($1)";
      const ids = [colleague, STAFF_ROWS.B.teacher];
      for (const actor of [STAFF_IDS.parentA, STAFF_IDS.studentA, STAFF_IDS.teacherA]) {
        expect((await asStaffActor(db, actor, labelsSql, [ids])).rows)
          .toEqual([{ id: colleague, full_name: "Colleague A" }]);
      }
      expect((await asStaffActor(db, STAFF_IDS.outsider, labelsSql, [ids])).rows).toEqual([]);
      await expect(asStaffActor(db, STAFF_IDS.parentA, labelsSql, [Array(201).fill(colleague)]))
        .rejects.toMatchObject({ code: "22023" });
      await expect(asStaffActor(db, null, labelsSql, [ids], "anon")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.close();
    }
  });
});
