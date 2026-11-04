// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);

describe("student study material school scope", () => {
  it("blocks another school's material and keeps the linked student's class and school-wide material visible", async () => {
    const db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
    try {
      await db.query(`
        insert into public.study_materials (school_id, class_id, section_id, title, published_at) values
        ($1, null, null, 'School-wide A', now()), ($2, null, null, 'School-wide B', now()),
        ($1, $3, $4, 'Other class A', now())
      `, [STAFF_IDS.schoolA, STAFF_IDS.schoolB, STAFF_ROWS.privateClassA, STAFF_ROWS.privateSectionA]);

      async function studentTitles() {
        const { rows } = await asStaffActor<{ title: string }>(
          db, STAFF_IDS.studentA, "select title from public.study_materials order by title",
        );
        return rows.map((row) => row.title);
      }

      expect(await studentTitles()).toContain("School-wide B");

      const file = (await readdir(migrationDirectory)).find((name) => name.endsWith("_scope_student_study_materials.sql"));
      if (!file) throw new Error("Student study material scope migration is missing.");
      await db.exec(await readFile(new URL(file, migrationDirectory), "utf8"));

      expect(await studentTitles()).toEqual(["Material A", "School-wide A"]);

      // A mismatched enrollment and a second school role must not replace the
      // school identity on the linked student record.
      await db.query(`
        insert into public.user_roles (user_id, school_id, role) values ($1, $2, 'student')
      `, [STAFF_IDS.studentA, STAFF_IDS.schoolB]);
      await db.query(`
        insert into public.enrollments (student_id, academic_year_id, class_id, section_id)
        values ($1, $2, $3, $4)
      `, [STAFF_ROWS.A.student, STAFF_ROWS.B.year, STAFF_ROWS.B.class, STAFF_ROWS.B.section]);
      expect(await studentTitles()).toEqual(["Material A", "School-wide A"]);
    } finally {
      await db.close();
    }
  });
});
