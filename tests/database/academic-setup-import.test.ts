// @vitest-environment node

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const { adminA, adminB, principalA, teacherA, accountantA, schoolA, schoolB } = STAFF_IDS;
const { A, B } = STAFF_ROWS;
const section = (name: string, classId: string = A.class, className = "Class 6") => ({ name, classId, className });

describe("atomic academic catalog CSV imports", () => {
  let db: Awaited<ReturnType<typeof createStaffScopeDatabase>>;

  beforeAll(async () => {
    db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true });
    const files = await readdir(migrations);
    const file = files.find((name) => name.endsWith("_import_academic_setup_records.sql"));
    if (!file) throw new Error("Missing academic catalog import migration");
    await db.exec(await readFile(new URL(file, migrations), "utf8"));
  }, 30000);
  afterAll(async () => { await db?.close(); });

  const batch = (actor: string, kind: string, rows: unknown, requestId: string = randomUUID(), school: string = schoolA) =>
    asStaffActor(db, actor, "select public.import_academic_setup_records($1,$2,$3,$4::jsonb) as count",
      [school, kind, requestId, JSON.stringify(rows)]);
  const history = (actor: string, kind: string, school: string = schoolA) =>
    asStaffActor(db, actor, "select * from public.list_academic_setup_imports($1,$2)", [school, kind]);

  it("writes classes, sections and subjects with scoped history and identical retries", async () => {
    const request = randomUUID();
    const classes = [{ name: " Class 7 ", sortOrder: 70 }, { name: "कक्षा 8", sortOrder: 80 }];
    expect((await batch(principalA, "classes", classes, request)).rows).toEqual([{ count: 2 }]);
    expect((await batch(principalA, "classes", classes, request)).rows).toEqual([{ count: 2 }]);
    await expect(batch(principalA, "classes", [{ ...classes[0], sortOrder: 80 }], request)).rejects.toMatchObject({ code: "22023" });
    await expect(batch(adminA, "classes", classes, request)).rejects.toMatchObject({ code: "22023" });

    const { rows: [newClass] } = await db.query<{ id: string; sort_order: number }>(
      "select id,sort_order from public.classes where school_id=$1 and name='Class 7'", [schoolA]);
    expect(newClass.sort_order).toBe(70);
    expect((await batch(adminA, "sections", [section("B"), section("B", newClass.id, "Class 7")])).rows).toEqual([{ count: 2 }]);
    const sections = await db.query("select class_id from public.sections where school_id=$1 and name='B'", [schoolA]);
    expect(sections.rows).toEqual(expect.arrayContaining([{ class_id: A.class }, { class_id: newClass.id }]));

    expect((await batch(adminA, "subjects", [{ name: "Physics", code: "PHY" }, { name: "Art", code: "" }])).rows).toEqual([{ count: 2 }]);
    expect((await db.query("select name,code from public.subjects where school_id=$1 and name in ('Art','Physics') order by name", [schoolA])).rows)
      .toEqual([{ name: "Art", code: null }, { name: "Physics", code: "PHY" }]);

    expect((await history(adminA, "classes")).rows).toEqual([
      expect.objectContaining({ request_id: request, record_count: 2, imported_by_name: "principalA" }),
    ]);
    expect((await history(adminB, "classes", schoolB)).rows).toEqual([]);
    await expect(history(adminB, "classes")).rejects.toMatchObject({ code: "42501" });
    await expect(history(teacherA, "classes")).rejects.toMatchObject({ code: "42501" });
    await expect(asStaffActor(db, adminA, "select * from app_private.academic_setup_import_receipts")).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects unauthorized access, stale class names and another school's class atomically", async () => {
    for (const actor of [adminB, teacherA, accountantA]) {
      await expect(batch(actor, "classes", [{ name: "Forbidden", sortOrder: 1 }])).rejects.toMatchObject({ code: "42501" });
    }
    const request = randomUUID();
    await expect(batch(adminA, "sections", [section("Rollback"), section("Foreign", B.class)], request))
      .rejects.toThrow("Academic row 2 needs an active class in this school");
    await expect(batch(adminA, "sections", [section("Rollback"), section("Stale", A.class, "class 6")], request))
      .rejects.toMatchObject({ code: "22023" });
    await expect(batch(adminA, "sections", [section("Rollback"), section("Invalid", "not-a-uuid")], request))
      .rejects.toMatchObject({ code: "22023" });
    await db.query("update public.classes set is_active=false where id=$1", [STAFF_ROWS.privateClassA]);
    await expect(batch(adminA, "sections", [section("Rollback"), section("Inactive", STAFF_ROWS.privateClassA, "Unassigned class")], request))
      .rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select id from public.sections where name='Rollback'")).rows).toEqual([]);
    expect((await db.query("select request_id from app_private.academic_setup_import_receipts where request_id=$1", [request])).rows).toEqual([]);
    expect((await batch(adminA, "sections", [section("Rollback")], request)).rows).toEqual([{ count: 1 }]);
  });

  it("enforces normalized names and subject codes in both bulk and single writes", async () => {
    await expect(batch(adminA, "classes", [{ name: "New class", sortOrder: 1 }, { name: " class 6 ", sortOrder: 2 }]))
      .rejects.toThrow("Academic row 2 repeats a name");
    await expect(batch(adminA, "classes", [{ name: "New class", sortOrder: 1000 }])).rejects.toMatchObject({ code: "22023" });
    await expect(batch(adminA, "subjects", [{ name: "New subject", code: "PHY2" }, { name: "A second subject", code: " phy2 " }]))
      .rejects.toThrow("Academic row 2 repeats a subject code");
    expect((await db.query("select name from public.classes where name='New class'")).rows).toEqual([]);
    expect((await db.query("select name from public.subjects where name='New subject'")).rows).toEqual([]);

    const insertClass = "insert into public.classes(school_id,name) values($1,$2)";
    const insertSection = "insert into public.sections(school_id,class_id,name) values($1,$2,$3)";
    const insertSubject = "insert into public.subjects(school_id,name,code) values($1,$2,$3)";
    await expect(asStaffActor(db, adminA, insertClass, [schoolA, " class 6 "])).rejects.toMatchObject({ code: "23505" });
    await expect(asStaffActor(db, adminA, insertSection, [schoolA, A.class, " a "])).rejects.toMatchObject({ code: "23505" });
    await asStaffActor(db, adminA, insertSubject, [schoolA, "Single-added subject", "CODE1"]);
    await expect(batch(adminA, "subjects", [{ name: "Duplicate code", code: " code1 " }])).rejects.toMatchObject({ code: "23505" });
    expect((await batch(adminB, "subjects", [{ name: "Duplicate code", code: "CODE1" }], randomUUID(), schoolB)).rows).toEqual([{ count: 1 }]);
    await expect(asStaffActor(db, adminA, insertSubject, [schoolA, "Another subject", " code1 "])).rejects.toMatchObject({ code: "23505" });
  });
});
