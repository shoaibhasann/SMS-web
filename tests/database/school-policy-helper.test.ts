// @vitest-environment node

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { asStaffActor, createTeachingGovernanceDatabase, STAFF_IDS } from "./staff-scope-fixture";

it("restores scoped schools access while keeping the public role helper closed", async () => {
  const db = await createTeachingGovernanceDatabase();
  try {
    const readSchools = "select id from public.schools order by id";
    await expect(asStaffActor(db, STAFF_IDS.adminA, readSchools)).rejects.toMatchObject({
      code: "42501", message: expect.stringContaining("permission denied for function has_role"),
    });

    const sql = await readFile(new URL("../../supabase/migrations/20261104054348_repair_school_policy_helper.sql", import.meta.url), "utf8");
    await db.exec(sql);

    expect((await asStaffActor(db, STAFF_IDS.adminA, readSchools)).rows).toEqual([{ id: STAFF_IDS.schoolA }]);
    expect((await asStaffActor(db, STAFF_IDS.superAdmin, readSchools)).rows).toEqual([
      { id: STAFF_IDS.schoolA }, { id: STAFF_IDS.schoolB },
    ]);
    expect((await asStaffActor(db, STAFF_IDS.teacherA, readSchools)).rows).toEqual([{ id: STAFF_IDS.schoolA }]);
    expect((await asStaffActor(db, STAFF_IDS.outsider, readSchools)).rows).toEqual([]);

    const renameSchool = "update public.schools set name='Renamed fixture' where id=$1 returning id";
    expect((await asStaffActor(db, STAFF_IDS.adminA, renameSchool, [STAFF_IDS.schoolA])).rows).toEqual([{ id: STAFF_IDS.schoolA }]);
    expect((await asStaffActor(db, STAFF_IDS.adminA, renameSchool, [STAFF_IDS.schoolB])).rows).toEqual([]);
    expect((await asStaffActor(db, STAFF_IDS.teacherA, renameSchool, [STAFF_IDS.schoolA])).rows).toEqual([]);
    expect((await asStaffActor(db, STAFF_IDS.superAdmin, renameSchool, [STAFF_IDS.schoolB])).rows).toEqual([{ id: STAFF_IDS.schoolB }]);

    const grants = await db.query(`select
      has_function_privilege('anon','public.has_role(public.app_role,uuid)','EXECUTE') as anon,
      has_function_privilege('authenticated','public.has_role(public.app_role,uuid)','EXECUTE') as authenticated,
      has_function_privilege('service_role','public.has_role(public.app_role,uuid)','EXECUTE') as service_role`);
    expect(grants.rows).toEqual([{ anon: false, authenticated: false, service_role: true }]);
  } finally {
    await db.close();
  }
});
