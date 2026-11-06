// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, STAFF_IDS as ids, STAFF_ROWS as records } from "./staff-scope-fixture";
import { createStudentActivationDatabase, readStudentActivationSql } from "./student-activation-fixture";

let db: Awaited<ReturnType<typeof createStudentActivationDatabase>>;
let sequence = 100;
const uuid = () => `30000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
const proof = { dob: "2013-08-01", mobile: "9812345678" };
const activation = "select public.activate_student($1,$2,$3) as pupil";
const grant = "select public.assign_school_role($1,$2,$3::public.app_role)";

async function account() {
  const id = uuid();
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [id, `${id}@example.test`]);
  await db.query("insert into public.profiles(id,full_name) values($1,'Integration student')", [id]);
  return id;
}

async function pupil() {
  const id = uuid();
  const admission = `INTEGRATION-${sequence}`;
  await db.query("insert into public.students(id,school_id,admission_no,first_name,dob,registered_mobile) values($1,$2,$3,'Integration pupil',$4,$5)", [id, ids.schoolA, admission, proof.dob, proof.mobile]);
  await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [id, records.A.year, records.A.class, records.A.section]);
  return { id, admission };
}

async function snapshot(user: string, student: string) {
  return (await db.query(`select
    (select to_jsonb(p) from public.profiles p where p.id=$1) as profile,
    (select to_jsonb(s) from public.students s where s.id=$2) as student,
    (select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.user_roles r where r.user_id=$1) as roles`, [user, student])).rows;
}

beforeAll(async () => {
  db = await createStudentActivationDatabase({ applyMigration: false });
  await db.exec(await readFile(new URL("../../supabase/migrations/20261105184939_require_active_role_assignment_actor.sql", import.meta.url), "utf8"));
  await db.exec(await readStudentActivationSql());
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("active authority and student activation together", () => {
  it("rejects a student claim after the admin has granted that account a staff role", async () => {
    const user = await account();
    const student = await pupil();
    await asStaffActor(db, ids.adminA, grant, [user, ids.schoolA, "teacher"]);
    const before = await snapshot(user, student.id);
    await expect(asStaffActor(db, user, activation, [student.admission, proof.dob, proof.mobile]))
      .rejects.toThrow("cannot activate this student");
    expect(await snapshot(user, student.id)).toEqual(before);
  });

  it("retains own attendance/receipts and guardian history after both patches and a fresh read request", async () => {
    const user = await account();
    const student = await pupil();
    const fee = uuid();
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [student.id, records.A.parent]);
    await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,'2026-11-05','absent',$5)", [ids.schoolA, records.A.year, records.A.section, student.id, ids.teacherA]);
    await db.query("insert into public.student_fees(id,school_id,student_id,fee_structure_id,amount) values($1,$2,$3,$4,1500)", [fee, ids.schoolA, student.id, records.A.structure]);
    await db.query("insert into public.fee_payments(school_id,student_id,student_fee_id,receipt_no,amount) values($1,$2,$3,'INTEGRATION-RECEIPT',750)", [ids.schoolA, student.id, fee]);
    const historySql = `select
      (select jsonb_agg(to_jsonb(a)) from public.attendance a where a.student_id=$1) as attendance,
      (select jsonb_agg(to_jsonb(f)) from public.student_fees f where f.student_id=$1) as fees,
      (select jsonb_agg(to_jsonb(p)) from public.fee_payments p where p.student_id=$1) as receipts,
      (select jsonb_agg(to_jsonb(link)) from public.student_parents link where link.student_id=$1) as links`;
    const before = (await db.query(historySql, [student.id])).rows;
    expect((await asStaffActor(db, user, activation, [student.admission, proof.dob, proof.mobile])).rows).toEqual([{ pupil: student.id }]);
    for (let refresh = 0; refresh < 2; refresh++) {
      expect((await asStaffActor(db, user, "select id from public.students")).rows).toEqual([{ id: student.id }]);
      expect((await asStaffActor(db, user, "select student_id,status from public.attendance")).rows).toEqual([{ student_id: student.id, status: "absent" }]);
      expect((await asStaffActor(db, user, "select student_id,receipt_no,amount from public.fee_payments")).rows).toEqual([{ student_id: student.id, receipt_no: "INTEGRATION-RECEIPT", amount: "750.00" }]);
    }
    expect((await db.query(historySql, [student.id])).rows).toEqual(before);
  });

  it("denies disabled admin's legacy-policy student reads/edits, direct binding, self-reactivation and role grants", async () => {
    const user = await account();
    const student = await pupil();
    await db.query("update public.profiles set is_active=false where id=$1", [ids.adminA]);
    try {
      const before = await snapshot(user, student.id);
      expect((await asStaffActor(db, ids.adminA, "select id from public.students")).rows).toEqual([]);
      expect((await asStaffActor(db, ids.adminA, "update public.students set first_name='Blocked' where id=$1 returning id", [student.id])).rows).toEqual([]);
      expect((await asStaffActor(db, ids.adminA, "update public.students set profile_id=$1 where id=$2 returning id", [user, student.id])).rows).toEqual([]);
      await expect(asStaffActor(db, ids.adminA, "update public.profiles set is_active=true where id=$1", [ids.adminA])).rejects.toThrow("Own-profile edits");
      await expect(asStaffActor(db, ids.adminA, grant, [user, ids.schoolA, "teacher"])).rejects.toThrow("active account");
      expect(await snapshot(user, student.id)).toEqual(before);
    } finally { await db.query("update public.profiles set is_active=true where id=$1", [ids.adminA]); }
  });

  it("does not revive malformed school-scoped super-admin authority through a surviving legacy policy", async () => {
    const user = await account();
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'super_admin')", [user, ids.schoolA]);
    expect((await asStaffActor(db, user, "select public.is_school_admin_for_school($1) as admin", [ids.schoolA])).rows).toEqual([{ admin: false }]);
    expect((await asStaffActor(db, user, "select id from public.students")).rows).toEqual([]);
    await expect(asStaffActor(db, user, grant, [ids.outsider, ids.schoolA, "teacher"])).rejects.toThrow("Not authorized");
  });
});
