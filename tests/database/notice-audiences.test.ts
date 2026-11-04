// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS as actors, STAFF_ROWS as rows } from "./staff-scope-fixture";

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);
let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;

beforeAll(async () => {
  db = await createStaffScopeDatabase();
  await seedNotice("Legacy parents", { roles: ["parents"] });
  const migration = (await readdir(migrationDirectory)).find((name) => name.endsWith("_secure_notice_audiences.sql"));
  if (!migration) throw new Error("Notice audience migration is missing.");
  await db.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
}, 15_000);

afterAll(async () => { await db?.close(); });

async function seedNotice(title: string, audience: unknown, dates = "now() - interval '1 day', null", school: string = actors.schoolA) {
  await db.query(`insert into public.notices (school_id, title, content, audience, published_at, expires_at)
    values ($1, $2, 'QA content', $3::jsonb, ${dates})`, [school, title, JSON.stringify(audience)]);
}

async function visible(actor: string, prefix: string) {
  const result = await asStaffActor<{ title: string }>(
    db, actor, "select title from public.notices where title like $1 order by title", [`${prefix}%`],
  );
  return result.rows.map((row) => row.title);
}

const insertNotice = `insert into public.notices (school_id, title, content, audience, published_at, created_by)
  values ($1, $2, 'QA content', $3::jsonb, now() - interval '1 day', $4) returning title`;

describe("notice audiences", () => {
  it("preserves access for the intended audience of legacy notices saved with plural role labels", async () => {
    expect(await visible(actors.parentA, "Legacy")).toEqual(["Legacy parents"]);
    expect(await visible(actors.studentA, "Legacy")).toEqual([]);
    expect(await visible(actors.parentB, "Legacy")).toEqual([]);
  });

  it("shows only published, current notices for the viewer's role in the same school", async () => {
    await seedNotice("Window everyone", []);
    await seedNotice("Window draft", [], "null, null");
    await seedNotice("Window future", [], "now() + interval '1 day', null");
    await seedNotice("Window expired", [], "now() - interval '2 days', now() - interval '1 day'");
    await seedNotice("Window parents", { roles: ["parent"] });
    await seedNotice("Window staff", { roles: ["staff"] });
    await seedNotice("Window teachers", { roles: ["teacher"] });
    await seedNotice("Window other school", [], undefined, actors.schoolB);

    expect(await visible(actors.parentA, "Window")).toEqual(["Window everyone", "Window parents"]);
    expect(await visible(actors.studentA, "Window")).toEqual(["Window everyone"]);
    expect(await visible(actors.teacherA, "Window")).toEqual(["Window everyone", "Window teachers"]);
    expect(await visible(actors.receptionA, "Window")).toEqual(["Window everyone", "Window staff"]);
    expect(await visible(actors.accountantA, "Window")).toEqual(["Window everyone", "Window staff"]);
    expect(await visible(actors.parentB, "Window")).toEqual(["Window other school"]);
    expect(await visible(actors.outsider, "Window")).toEqual([]);
    expect(await visible(actors.principalA, "Window")).toEqual([
      "Window draft", "Window everyone", "Window expired", "Window future",
      "Window parents", "Window staff", "Window teachers",
    ]);
  });

  it("uses active enrollment and linked children to match classes, sections and teacher assignments", async () => {
    await seedNotice("Target A class", { roles: ["student", "parent"], class_id: rows.A.class });
    await seedNotice("Target A section", { roles: ["student", "parent"], section_id: rows.A.section });
    await seedNotice("Target B section from A", { roles: ["student", "parent"], section_id: rows.B.section });
    await seedNotice("Target private class", { roles: ["student", "parent"], class_id: rows.privateClassA });
    await seedNotice("Target teacher A", { roles: ["student", "parent"], teacher_id: rows.A.teacher });
    await seedNotice("Target malformed", { roles: ["parent"], section_id: "bad id" });
    const expected = ["Target A class", "Target A section", "Target teacher A"];

    expect(await visible(actors.studentA, "Target")).toEqual(expected);
    expect(await visible(actors.parentA, "Target")).toEqual(expected);
    expect(await visible(actors.mixedParent, "Target")).toEqual([]);
    expect(await visible(actors.parentB, "Target")).toEqual([]);
    expect(await visible(actors.receptionA, "Target")).toEqual([]);
    await db.query("update public.enrollments set status = 'inactive' where id = $1", [rows.A.enrollment]);
    try {
      expect(await visible(actors.studentA, "Target")).toEqual([]);
      expect(await visible(actors.parentA, "Target")).toEqual([]);
    } finally {
      await db.query("update public.enrollments set status = 'active' where id = $1", [rows.A.enrollment]);
    }
  });

  it("limits teacher writes to their own assignment audience and management to scoped leaders", async () => {
    const mine = { roles: ["student", "parent"], teacher_id: rows.A.teacher };
    await expect(asStaffActor(db, actors.teacherA, insertNotice, [
      actors.schoolA, "Authored teacher", JSON.stringify(mine), actors.teacherA,
    ])).resolves.toMatchObject({ rows: [{ title: "Authored teacher" }] });
    expect(await visible(actors.parentA, "Authored")).toEqual(["Authored teacher"]);
    expect(await visible(actors.teacherA, "Authored")).toEqual(["Authored teacher"]);
    expect(await visible(actors.receptionA, "Authored")).toEqual([]);

    await expect(asStaffActor(db, actors.teacherA,
      "update public.notices set audience = '[]'::jsonb where title = 'Authored teacher'",
    )).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.teacherA, insertNotice, [
      actors.schoolB, "Forbidden", JSON.stringify(mine), actors.teacherA,
    ])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.teacherA, insertNotice, [
      actors.schoolA, "Forbidden", JSON.stringify(mine), actors.teacherB,
    ])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.receptionA, insertNotice, [
      actors.schoolA, "Forbidden", "[]", actors.receptionA,
    ])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.adminA, insertNotice, [
      actors.schoolA, "Forbidden", JSON.stringify({ roles: ["parent"], class_id: rows.A.class, section_id: rows.privateSectionA }), actors.adminA,
    ])).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, actors.principalA, insertNotice, [
      actors.schoolA, "Authored principal", JSON.stringify({ roles: ["staff"] }), actors.principalA,
    ])).resolves.toMatchObject({ rows: [{ title: "Authored principal" }] });
    await expect(asStaffActor(db, null, "select title from public.notices", [], "anon")).rejects.toMatchObject({ code: "42501" });
  });
});
