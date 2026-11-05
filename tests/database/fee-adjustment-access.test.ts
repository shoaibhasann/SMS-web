// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, createStaffScopeDatabase, STAFF_IDS, STAFF_ROWS } from "./staff-scope-fixture";

type Database = Awaited<ReturnType<typeof createStaffScopeDatabase>>;
type Column = { name: string; type: string; not_null: boolean; default: string | null };
type Relation = { name: string; columns: Column[]; constraints: { name: string; definition: string }[] };
const directory = new URL("../../supabase/migrations/", import.meta.url);
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;
const id = (value: number) => `20000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
const rows = {
  discountA: id(1), discountB: id(2), privateA: id(3), privateB: id(4), unlinked: id(5),
  forgedFee: id(6), forgedStudent: id(7), refundA: id(10), refundB: id(11), privateRefund: id(12),
  forgedRefund: id(13), forgedPaymentRefund: id(14), privateFeeA: id(20), forgedPayment: id(21),
};

describe("read-only historical fee adjustment and refund access", () => {
  let db: Database;
  let migration = "";
  let before: unknown;
  let reproducedLegacyWrite = false;
  const { schoolA, schoolB, adminA, principalA, accountantA, parentA, studentA, teacherA, mixedParent, mixedTeacher } = STAFF_IDS;
  const { A, B } = STAFF_ROWS;

  async function snapshot() {
    const result = await db.query("select 'discounts' as kind,jsonb_agg(to_jsonb(t) order by id) as records from public.fee_discounts t union all select 'refunds',jsonb_agg(to_jsonb(t) order by id) from public.fee_refunds t order by kind");
    return result.rows;
  }
  async function visible(actor: string, table: "fee_discounts" | "fee_refunds", school?: string) {
    return (await asStaffActor<{ id: string }>(db, actor,
      `select id from public.${table}${school ? " where school_id=$1" : ""} order by id`, school ? [school] : [],
    )).rows.map((row) => row.id);
  }

  beforeAll(async () => {
    db = await createStaffScopeDatabase();
    const files = await readdir(directory);
    const payment = files.find((file) => file.endsWith("_record_office_fee_payment.sql"));
    const access = files.filter((file) => file.endsWith("_harden_fee_adjustment_record_access.sql"));
    expect(payment).toBeTruthy(); expect(access).toHaveLength(1);
    await db.exec(await readFile(new URL(payment!, directory), "utf8"));
    migration = await readFile(new URL(access[0], directory), "utf8");
    const snapshotData: { relations: Relation[]; policies: { tablename: string; policyname: string; qual: string; with_check: string }[] } = JSON.parse(
      await readFile(new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8"),
    );
    const relations = snapshotData.relations.filter((relation) => ["fee_discounts", "fee_refunds"].includes(relation.name));
    expect(relations).toHaveLength(2);
    for (const relation of relations) {
      const columns = relation.columns.map((column) => `${ident(column.name)} ${column.type}${column.not_null ? " not null" : ""}${column.default ? ` default ${column.default}` : ""}`);
      await db.exec(`create table public.${ident(relation.name)} (${columns.join(",")})`);
      for (const constraint of relation.constraints) await db.exec(`alter table public.${ident(relation.name)} add constraint ${ident(constraint.name)} ${constraint.definition}`);
      await db.exec(`grant all on public.${ident(relation.name)} to anon, authenticated, service_role; alter table public.${ident(relation.name)} enable row level security;`);
    }
    for (const policy of snapshotData.policies.filter((item) => ["fee_discounts", "fee_refunds"].includes(item.tablename))) {
      await db.exec(`create policy ${ident(policy.policyname)} on public.${ident(policy.tablename)} for all to public using (${policy.qual}) with check (${policy.with_check})`);
    }
    await db.query("insert into public.student_fees(id,school_id,student_id,fee_structure_id,amount) values($1,$2,$3,$4,700)", [rows.privateFeeA, schoolA, STAFF_ROWS.privateStudentA, A.structure]);
    const discounts = [
      [rows.discountA, schoolA, A.student, A.fee], [rows.discountB, schoolB, B.student, B.fee],
      [rows.privateA, schoolA, STAFF_ROWS.privateStudentA, rows.privateFeeA],
      [rows.privateB, schoolB, STAFF_ROWS.privateStudentB, STAFF_ROWS.privateFeeB],
      [rows.unlinked, schoolA, A.student, null], [rows.forgedFee, schoolA, A.student, B.fee],
      [rows.forgedStudent, schoolA, B.student, A.fee],
    ];
    for (const values of discounts) await db.query("insert into public.fee_discounts(id,school_id,student_id,student_fee_id,amount,reason) values($1,$2,$3,$4,10,'Historical fee adjustment')", values);
    await db.query("insert into public.fee_payments(id,school_id,student_id,student_fee_id,receipt_no,amount) values($1,$2,$3,$4,'FORGED-SCOPE-QA',1)", [rows.forgedPayment, schoolA, A.student, B.fee]);
    const refunds = [
      [rows.refundA, schoolA, A.payment], [rows.refundB, schoolB, B.payment],
      [rows.privateRefund, schoolB, STAFF_ROWS.privatePaymentB],
      [rows.forgedRefund, schoolA, B.payment], [rows.forgedPaymentRefund, schoolA, rows.forgedPayment],
    ];
    for (const values of refunds) await db.query("insert into public.fee_refunds(id,school_id,payment_id,amount,reason) values($1,$2,$3,5,'Historical fee refund')", values);
    const forged = id(99);
    await asStaffActor(db, studentA, "insert into public.fee_discounts(id,school_id,student_id,student_fee_id,amount,approved_by) values($1,$2,$3,$4,999,$5)", [forged, schoolA, A.student, A.fee, studentA]);
    reproducedLegacyWrite = (await db.query("select id from public.fee_discounts where id=$1", [forged])).rows.length === 1;
    await db.query("delete from public.fee_discounts where id=$1", [forged]);
    // Table-level revokes alone do not remove these explicit column grants.
    await db.exec("grant insert(reason), update(amount), references(student_id) on public.fee_discounts to public, anon, authenticated");
    before = await snapshot();
    await db.exec(migration);
  }, 30000);

  afterAll(async () => { await db?.close(); });

  it("reproduces the legacy school-member write and preserves every existing history row while closing it", async () => {
    expect(reproducedLegacyWrite).toBe(true);
    expect(await snapshot()).toEqual(before);
    expect((await db.query("select tablename,policyname,cmd,roles::text from pg_policies where schemaname='public' and tablename in ('fee_discounts','fee_refunds') order by tablename")).rows)
      .toEqual([
        { tablename: "fee_discounts", policyname: "fee_discounts_scoped_read", cmd: "SELECT", roles: "{authenticated}" },
        { tablename: "fee_refunds", policyname: "fee_refunds_scoped_read", cmd: "SELECT", roles: "{authenticated}" },
      ]);
  });

  it.each([parentA, studentA])("limits the family actor %s to the coherent own fee and payment", async (actor) => {
    expect(await visible(actor, "fee_discounts")).toEqual([rows.discountA]);
    expect(await visible(actor, "fee_refunds")).toEqual([rows.refundA]);
    expect((await asStaffActor<{ permitted: boolean }>(db, actor, "select app_private.can_read_fee_adjustment($1,$2,$3,null) as permitted", [schoolB, B.student, B.fee])).rows)
      .toEqual([{ permitted: false }]);
  });

  it("keeps office reads school-scoped and does not expand mixed roles into another school", async () => {
    const ownDiscounts = [rows.discountA, rows.privateA, rows.unlinked, rows.forgedFee, rows.forgedStudent].sort();
    const ownRefunds = [rows.refundA, rows.forgedRefund, rows.forgedPaymentRefund].sort();
    for (const actor of [adminA, principalA, accountantA, mixedTeacher, mixedParent]) {
      expect(await visible(actor, "fee_discounts", schoolA)).toEqual(ownDiscounts);
      expect(await visible(actor, "fee_refunds", schoolA)).toEqual(ownRefunds);
    }
    expect(await visible(mixedTeacher, "fee_discounts", schoolB)).toEqual([]);
    expect(await visible(mixedTeacher, "fee_refunds", schoolB)).toEqual([]);
    expect(await visible(mixedParent, "fee_discounts", schoolB)).toEqual([rows.discountB]);
    expect(await visible(mixedParent, "fee_refunds", schoolB)).toEqual([rows.refundB]);
    expect(await visible(STAFF_IDS.adminB, "fee_discounts", schoolA)).toEqual([]);
    expect(await visible(teacherA, "fee_discounts")).toEqual([]);
    expect(await visible(teacherA, "fee_refunds")).toEqual([]);
  });

  it("revokes family history immediately when the only child link is removed", async () => {
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [A.parent, A.student]);
    try {
      expect(await visible(parentA, "fee_discounts")).toEqual([]);
      expect(await visible(parentA, "fee_refunds")).toEqual([]);
      expect(await visible(studentA, "fee_discounts")).toEqual([rows.discountA]);
    } finally {
      await db.query("insert into public.student_parents(parent_id,student_id,relationship) values($1,$2,'guardian')", [A.parent, A.student]);
    }
  });

  it("requires an active profile and the family role for the same school", async () => {
    await db.query("update public.profiles set is_active=false where id=$1", [parentA]);
    try {
      expect(await visible(parentA, "fee_discounts")).toEqual([]);
      expect(await visible(parentA, "fee_refunds")).toEqual([]);
    } finally { await db.query("update public.profiles set is_active=true where id=$1", [parentA]); }
    await db.query("delete from public.user_roles where user_id=$1 and school_id=$2 and role='parent'", [parentA, schoolA]);
    try { expect(await visible(parentA, "fee_discounts")).toEqual([]); }
    finally { await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [parentA, schoolA]); }
  });

  it.each([adminA, accountantA, teacherA, parentA, studentA])("denies raw mutation even for authorized reader %s", async (actor) => {
    for (const sql of [
      "update public.fee_discounts set amount=0 where id=$1", "delete from public.fee_discounts where id=$1",
      "insert into public.fee_discounts(id,school_id,student_id,amount) select id,school_id,student_id,amount from public.fee_discounts where id=$1",
      "update public.fee_refunds set amount=0 where id=$1", "delete from public.fee_refunds where id=$1",
      "insert into public.fee_refunds(id,school_id,payment_id,amount) select id,school_id,payment_id,amount from public.fee_refunds where id=$1",
    ]) await expect(asStaffActor(db, actor, sql, [sql.includes("fee_discounts") ? rows.discountA : rows.refundA])).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot()).toEqual(before);
  });

  it("denies anonymous, column and non-DML privileges and pins the private helper", async () => {
    for (const table of ["fee_discounts", "fee_refunds"]) {
      await expect(asStaffActor(db, null, `select id from public.${table}`, [], "anon")).rejects.toMatchObject({ code: "42501" });
      expect((await db.query("select has_table_privilege('authenticated',$1,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as writable,has_any_column_privilege('authenticated',$1,'INSERT,UPDATE,REFERENCES') as column_writable", ["public." + table])).rows)
        .toEqual([{ writable: false, column_writable: false }]);
    }
    await expect(asStaffActor(db, null, "select app_private.can_read_fee_adjustment($1,$2,$3,null)", [schoolA, A.student, A.fee], "anon")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select prosecdef,proconfig::text,has_function_privilege('anon',oid,'EXECUTE') as anon_exec from pg_proc where oid='app_private.can_read_fee_adjustment(uuid,uuid,uuid,uuid)'::regprocedure")).rows)
      .toEqual([{ prosecdef: true, proconfig: '{"search_path=\\\"\\\""}', anon_exec: false }]);
  });

  it("retains trusted service writes without granting a new school write API", async () => {
    const serviceRow = id(98);
    await asStaffActor(db, null, "insert into public.fee_discounts(id,school_id,student_id,student_fee_id,amount) values($1,$2,$3,$4,1)", [serviceRow, schoolA, A.student, A.fee], "service_role");
    await db.query("delete from public.fee_discounts where id=$1", [serviceRow]);
    expect(await snapshot()).toEqual(before);
  });

  it("replays the migration without changing historical rows", async () => {
    await db.exec(migration);
    expect(await snapshot()).toEqual(before);
    expect(await visible(parentA, "fee_refunds")).toEqual([rows.refundA]);
  });

  it("rolls back rather than hiding an unexpected permissive policy", async () => {
    await db.exec("create policy unreviewed_fee_access on public.fee_discounts for all to authenticated using(true) with check(true)");
    try {
      await expect(db.exec(migration)).rejects.toThrow("Review the complete fee history policy set");
      await db.exec("rollback");
      expect(await snapshot()).toEqual(before);
    } finally { await db.exec("drop policy unreviewed_fee_access on public.fee_discounts"); }
  });

  it("fails closed when an inherited role still grants raw writes", async () => {
    await db.exec("create role fee_adjustment_inherited_writer nologin; grant update on public.fee_discounts to fee_adjustment_inherited_writer; grant fee_adjustment_inherited_writer to authenticated");
    try {
      await expect(db.exec(migration)).rejects.toThrow("Untrusted fee history privileges remain");
      await db.exec("rollback");
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.exec("revoke fee_adjustment_inherited_writer from authenticated; drop owned by fee_adjustment_inherited_writer; drop role fee_adjustment_inherited_writer");
    }
    expect((await db.query("select has_table_privilege('authenticated','public.fee_discounts','UPDATE') as writable")).rows).toEqual([{ writable: false }]);
  });
});
