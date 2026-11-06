// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStaffActor, STAFF_IDS as ids, STAFF_ROWS as records } from "./staff-scope-fixture";
import { createStudentActivationDatabase, readStudentActivationSql } from "./student-activation-fixture";

let db: Awaited<ReturnType<typeof createStudentActivationDatabase>>;
let sequence = 700;
const nextId = () => `20000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
const dob = "2014-06-15";
const mobile = "9876543210";
const activation = "select public.activate_student($1,$2,$3) as student_id";

async function actor({ school = null, confirmed = true }: { school?: string | null; confirmed?: boolean } = {}) {
  const id = nextId();
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)", [id, `${id}@example.test`, confirmed ? "2026-11-01T00:00:00Z" : null]);
  await db.query("insert into public.profiles(id,school_id,full_name) values($1,$2,'Activation QA')", [id, school]);
  return id;
}

async function pupil({ school = ids.schoolA as string, profile = null as string | null, enrolled = true, admission = `QA-${sequence + 1}` } = {}) {
  const id = nextId();
  await db.query(`insert into public.students(id,school_id,profile_id,admission_no,first_name,dob,registered_mobile)
    values($1,$2,$3,$4,'Activation pupil',$5,$6)`, [id, school, profile, admission, dob, mobile]);
  if (enrolled) {
    const side = school === ids.schoolA ? records.A : records.B;
    await db.query("insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4)", [id, side.year, side.class, side.section]);
  }
  return { id, admission };
}

function claim(user: string | null, student: { admission: string }, proof: { admission?: string; dob?: string | null; mobile?: string | null } = {}) {
  return asStaffActor(db, user, activation, [proof.admission ?? student.admission, proof.dob === undefined ? dob : proof.dob, proof.mobile === undefined ? mobile : proof.mobile]);
}

async function state(user: string, student: string) {
  return (await db.query(`select
    (select to_jsonb(p) from public.profiles p where p.id=$1) as profile,
    (select to_jsonb(s) from public.students s where s.id=$2) as student,
    (select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.user_roles r where r.user_id=$1) as roles`, [user, student])).rows;
}

async function histories(student: string) {
  return (await db.query(`select
    (select coalesce(jsonb_agg(to_jsonb(a) order by a.attendance_date),'[]') from public.attendance a where a.student_id=$1) as attendance,
    (select coalesce(jsonb_agg(to_jsonb(f) order by f.id),'[]') from public.student_fees f where f.student_id=$1) as fees,
    (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.fee_payments p where p.student_id=$1) as receipts,
    (select coalesce(jsonb_agg(to_jsonb(link) order by link.parent_id),'[]') from public.student_parents link where link.student_id=$1) as guardians`, [student])).rows;
}

beforeAll(async () => { db = await createStudentActivationDatabase(); }, 30_000);
afterAll(async () => { await db?.close(); });

describe("atomic verified student account activation", () => {
  it("binds pupil/profile/role and reads only own attendance and receipts without rewriting history", async () => {
    const user = await actor();
    const student = await pupil();
    const fee = nextId();
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [student.id, records.A.parent]);
    await db.query("insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by) values($1,$2,$3,$4,'2026-11-05','absent',$5)", [ids.schoolA, records.A.year, records.A.section, student.id, ids.teacherA]);
    await db.query("insert into public.student_fees(id,school_id,student_id,fee_structure_id,amount) values($1,$2,$3,$4,1000)", [fee, ids.schoolA, student.id, records.A.structure]);
    await db.query("insert into public.fee_payments(school_id,student_id,student_fee_id,receipt_no,amount) values($1,$2,$3,'ACTIVATION-QA',250)", [ids.schoolA, student.id, fee]);
    const before = await histories(student.id);
    expect((await asStaffActor(db, user, "select student_id from public.attendance")).rows).toEqual([]);
    expect((await claim(user, student, { admission: ` ${student.admission.toLowerCase()} `, mobile: "(98765) 43210" })).rows).toEqual([{ student_id: student.id }]);
    expect((await db.query("select profile_id from public.students where id=$1", [student.id])).rows).toEqual([{ profile_id: user }]);
    expect((await asStaffActor(db, user, "select id from public.students where profile_id=$1", [user])).rows).toEqual([{ id: student.id }]);
    expect((await asStaffActor(db, user, "select school_id,role from public.user_roles")).rows).toEqual([{ school_id: ids.schoolA, role: "student" }]);
    expect((await asStaffActor(db, user, "select student_id,status from public.attendance")).rows).toEqual([{ student_id: student.id, status: "absent" }]);
    expect((await asStaffActor(db, user, "select student_id,receipt_no,amount from public.fee_payments")).rows).toEqual([{ student_id: student.id, receipt_no: "ACTIVATION-QA", amount: "250.00" }]);
    expect(await histories(student.id)).toEqual(before);
    const activated = await state(user, student.id);
    expect((await claim(user, student)).rows).toEqual([{ student_id: student.id }]);
    expect(await state(user, student.id)).toEqual(activated);
    // A completed activation retry preserves historical access after withdrawal;
    // it grants no new link/role and leaves every stored row unchanged.
    await db.query("update public.students set status='withdrawn' where id=$1", [student.id]);
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [student.id]);
    const withdrawn = await state(user, student.id);
    expect((await claim(user, student)).rows).toEqual([{ student_id: student.id }]);
    expect(await state(user, student.id)).toEqual(withdrawn);
    expect((await asStaffActor(db, user, "select receipt_no from public.fee_payments")).rows).toEqual([{ receipt_no: "ACTIVATION-QA" }]);
  });

  it("allows a verified-phone account and a same-school existing student role without moving school context", async () => {
    const user = await actor({ school: ids.schoolA, confirmed: false });
    await db.query("update auth.users set phone=$2,phone_confirmed_at=now() where id=$1", [user, mobile]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')", [user, ids.schoolA]);
    const student = await pupil();
    expect((await claim(user, student)).rows).toEqual([{ student_id: student.id }]);
    expect((await db.query("select count(*)::int as count from public.user_roles where user_id=$1", [user])).rows).toEqual([{ count: 1 }]);
  });

  it("does not restore a revoked student role through an already-bound activation retry", async () => {
    const user = await actor();
    const student = await pupil();
    await claim(user, student);
    await db.query("delete from public.user_roles where user_id=$1 and role='student'", [user]);
    const revoked = await state(user, student.id);
    await expect(claim(user, student)).rejects.toThrow("Contact the school office");
    expect(await state(user, student.id)).toEqual(revoked);
  });

  it("denies anonymous, missing, unconfirmed, disabled, banned and deleted accounts without partial changes", async () => {
    const student = await pupil();
    await expect(asStaffActor(db, null, activation, [student.admission, dob, mobile], "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(claim(null, student)).rejects.toThrow("Authentication required");
    for (const change of [
      "update auth.users set email_confirmed_at=null where id=$1",
      "update auth.users set is_anonymous=true where id=$1",
      "update auth.users set banned_until=now()+interval '1 day' where id=$1",
      "update auth.users set deleted_at=now() where id=$1",
      "update public.profiles set is_active=false where id=$1",
      "delete from public.profiles where id=$1",
    ]) {
      const user = await actor();
      await db.query(change, [user]);
      const before = await state(user, student.id);
      await expect(claim(user, student)).rejects.toThrow("active verified account");
      expect(await state(user, student.id)).toEqual(before);
    }
    await expect(claim(nextId(), student)).rejects.toThrow("active verified account");
  });

  it("rejects wrong or empty proof, long inputs and ambiguous cross-school proof", async () => {
    const user = await actor();
    const student = await pupil();
    const before = await state(user, student.id);
    for (const proof of [
      { admission: "does-not-exist" }, { dob: "2014-06-16" }, { dob: null }, { mobile: "9876543211" },
      { admission: "" }, { admission: "x".repeat(65) }, { admission: "QA\nID" },
      { mobile: "" }, { mobile: null }, { mobile: "123" }, { mobile: "1".repeat(16) }, { mobile: " ".repeat(65) },
    ]) await expect(claim(user, student, proof)).rejects.toThrow("Student verification failed");
    expect(await state(user, student.id)).toEqual(before);
    await db.query("update public.students set registered_mobile=null where id=$1", [student.id]);
    await expect(claim(user, student, { mobile: "" })).rejects.toThrow("Student verification failed");
    await db.query("update public.students set registered_mobile=$2 where id=$1", [student.id, mobile]);
    await pupil({ school: ids.schoolB, admission: student.admission.toLowerCase() });
    const ambiguous = await state(user, student.id);
    await expect(claim(user, student)).rejects.toThrow("Student verification failed");
    expect(await state(user, student.id)).toEqual(ambiguous);
  });

  it("rejects inactive, unenrolled and incoherent first claims, including inactive current enrollment", async () => {
    for (const change of [
      "update public.students set status='withdrawn' where id=$1",
      "delete from public.enrollments where student_id=$1",
      "update public.enrollments set status='withdrawn' where student_id=$1",
      `update public.enrollments set academic_year_id='${records.B.year}' where student_id=$1`,
      `update public.enrollments set class_id='${records.B.class}' where student_id=$1`,
      `update public.enrollments set section_id='${records.B.section}' where student_id=$1`,
    ]) {
      const user = await actor();
      const student = await pupil();
      await db.query(change, [student.id]);
      const before = await state(user, student.id);
      await expect(claim(user, student)).rejects.toThrow("Student verification failed");
      expect(await state(user, student.id)).toEqual(before);
    }
    const user = await actor();
    const student = await pupil();
    await db.query("update public.academic_years set is_current=false where id=$1", [records.A.year]);
    await expect(claim(user, student)).rejects.toThrow("Student verification failed");
    await db.query("update public.academic_years set is_current=true where id=$1", [records.A.year]);
  });

  it("rejects wrong-school, privileged/family identity, conflicting roles, bound pupils and second-pupil claims", async () => {
    const student = await pupil();
    for (const user of [await actor({ school: ids.schoolB }), ids.adminA, ids.parentA, ids.teacherA, ids.studentB]) {
      await db.query("update auth.users set email_confirmed_at=now() where id=$1", [user]);
      const before = await state(user, student.id);
      await expect(claim(user, student)).rejects.toThrow("cannot activate this student");
      expect(await state(user, student.id)).toEqual(before);
    }
    const rolelessParent = await actor();
    await db.query("insert into public.parents(profile_id,school_id) values($1,$2)", [rolelessParent, ids.schoolA]);
    await expect(claim(rolelessParent, student)).rejects.toThrow("cannot activate this student");
    const foreignRole = await actor();
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'student')", [foreignRole, ids.schoolB]);
    await expect(claim(foreignRole, student)).rejects.toThrow("cannot activate this student");
    const owner = await actor();
    expect((await claim(owner, student)).rows).toEqual([{ student_id: student.id }]);
    const competitor = await actor();
    await expect(claim(competitor, student)).rejects.toThrow("cannot activate this student");
    const second = await pupil();
    await expect(claim(owner, second)).rejects.toThrow("cannot activate this student");
    await expect(db.query("update public.students set profile_id=$1 where id=$2", [owner, second.id])).rejects.toMatchObject({ code: "23505" });
  });

  it("rolls back pupil/profile binding when the final role insert fails", async () => {
    const user = await actor();
    const student = await pupil();
    const before = await state(user, student.id);
    await db.exec(`create function public.activation_qa_reject_role() returns trigger language plpgsql as $$
      begin raise exception 'QA final-write failure'; end $$;
      create trigger activation_qa_reject_role before insert on public.user_roles
      for each row execute function public.activation_qa_reject_role()`);
    await expect(claim(user, student)).rejects.toThrow("QA final-write failure");
    expect(await state(user, student.id)).toEqual(before);
    await db.exec("drop trigger activation_qa_reject_role on public.user_roles; drop function public.activation_qa_reject_role()");
    expect((await claim(user, student)).rows).toEqual([{ student_id: student.id }]);
  });

  it("blocks staff from bypassing verification with direct roster binding while retaining ordinary roster edits", async () => {
    const user = await actor();
    const otherUser = await actor();
    const student = await pupil();
    for (const staff of [ids.adminA, ids.receptionA]) {
      await expect(asStaffActor(db, staff, "update public.students set profile_id=$1 where id=$2", [user, student.id]))
        .rejects.toMatchObject({ code: "42501" });
      await expect(asStaffActor(db, staff, "insert into public.students(school_id,profile_id,admission_no,first_name) values($1,$2,$3,'Bypass')", [ids.schoolA, user, `BYPASS-${staff}`]))
        .rejects.toMatchObject({ code: "42501" });
      expect((await asStaffActor(db, staff, "update public.students set first_name='Office edit' where id=$1 returning first_name", [student.id])).rows)
        .toEqual([{ first_name: "Office edit" }]);
      expect((await asStaffActor(db, staff, "insert into public.students(school_id,admission_no,first_name) values($1,$2,'Unbound admission') returning profile_id", [ids.schoolA, `UNBOUND-${staff}`])).rows)
        .toEqual([{ profile_id: null }]);
    }
    expect((await claim(user, student)).rows).toEqual([{ student_id: student.id }]);
    for (const staff of [ids.adminA, ids.receptionA]) {
      for (const replacement of [null, otherUser]) {
        await expect(asStaffActor(db, staff, "update public.students set profile_id=$1 where id=$2", [replacement, student.id]))
          .rejects.toMatchObject({ code: "42501" });
      }
      expect((await asStaffActor(db, staff, "update public.students set profile_id=profile_id,city='Delhi' where id=$1 returning profile_id", [student.id])).rows)
        .toEqual([{ profile_id: user }]);
    }
  });

  it("pins paths, hides definer behind the checked invoker wrapper and revokes anonymous execution", async () => {
    const routines = (await db.query(`select n.nspname as schema,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'execute') as anonymous,
      has_function_privilege('authenticated',p.oid,'execute') as authenticated
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.proname='activate_student' order by n.nspname`)).rows;
    expect(routines).toEqual([
      { schema: "app_private", prosecdef: true, proconfig: ['search_path=""'], anonymous: false, authenticated: true },
      { schema: "public", prosecdef: false, proconfig: ['search_path=""'], anonymous: false, authenticated: true },
    ]);
    await expect(asStaffActor(db, null, "select app_private.activate_student('QA','2014-06-15','9876543210')", [], "anon")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query(`select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'execute') as anonymous
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app_private' and p.proname='guard_student_account_binding'`)).rows)
      .toEqual([{ prosecdef: false, proconfig: ['search_path=""'], anonymous: false }]);
  });
});

it("reproduces the original missing binding and fails migration cleanly on legacy duplicate login links", async () => {
  const legacy = await createStudentActivationDatabase({ applyMigration: false });
  try {
    await legacy.query("update public.students set dob=$2,registered_mobile=$3 where id=$1", [records.privateStudentA, dob, mobile]);
    await asStaffActor(legacy, ids.outsider, activation, ["PRIVATE-A", dob, mobile]);
    expect((await legacy.query("select profile_id from public.students where id=$1", [records.privateStudentA])).rows).toEqual([{ profile_id: null }]);
    expect((await asStaffActor(legacy, ids.outsider, "select student_id from public.attendance")).rows).toEqual([]);
    await legacy.query("update public.students set profile_id=$1 where id in ($2,$3)", [ids.studentA, records.privateStudentA, records.privateStudentB]);
    const before = (await legacy.query("select id,profile_id from public.students order by id")).rows;
    await expect(legacy.exec(await readStudentActivationSql())).rejects.toThrow("Multiple student records share a login");
    await legacy.exec("rollback");
    expect((await legacy.query("select id,profile_id from public.students order by id")).rows).toEqual(before);
    expect((await legacy.query("select to_regclass('public.students_one_profile_login') as index")).rows).toEqual([{ index: null }]);
  } finally { await legacy.close(); }
}, 30_000);
