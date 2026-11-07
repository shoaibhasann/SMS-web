// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const principal = randomUUID(), finance = randomUUID(), reception = randomUUID();
const peer = randomUUID(), peerParent = randomUUID();
const constructors = [
  ["app_private.timetable_section_range(uuid,uuid)", "range_constructor2"],
  ["app_private.timetable_section_range(uuid,uuid,text)", "range_constructor3"],
  ["app_private.timetable_section_multirange()", "multirange_constructor0"],
  ["app_private.timetable_section_multirange(app_private.timetable_section_range)", "multirange_constructor1"],
  ["app_private.timetable_section_multirange(app_private.timetable_section_range[])", "multirange_constructor2"],
];
async function actor<T extends Record<string, unknown> = Record<string, unknown>>(
  user: string, sql: string, args: unknown[] = [], { aal = "aal1", sessionId = user, http = true } = {},
) {
  await db.exec("savepoint security_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.path','/rpc/security_cleanup',true)",
      [user, JSON.stringify({ sub: user, session_id: sessionId, aal })]);
    if (http) await db.query("select public.check_staff_mfa_request()");
    const result = await db.query<T>(sql, args);
    await db.exec("reset role;release savepoint security_actor");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    return result.rows;
  } catch (error) {
    await db.exec("rollback to savepoint security_actor;release savepoint security_actor");
    throw error;
  }
}
const deny = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "42501" });
const phone = (user = id.teacherA, value: string | null = " 9876512345 ", options = {}) =>
  actor(user, "select public.update_my_teacher_phone($1)", [value], options);
const admit = (user: string, admission: string) => actor<{ pupil: string }>(user,
  "select public.admit_roster_student($1,$2,$3,$4,$5,'Security','Pupil') as pupil",
  [id.schoolA, id.yearA, id.classA, id.sectionA, admission]);

beforeAll(async () => {
  db = await createRecoveryDatabase(); await seedRecoveryData(db);
  for (const [user, role] of [[principal, "principal"], [finance, "accountant"], [reception, "reception_staff"], [peer, "parent"]]) {
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `${user}@security.invalid`]);
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolA]);
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,$3)", [user, id.schoolA, role]);
  }
  await db.query("insert into public.parents(id,school_id,profile_id,guardian_code) values($1,$2,$3,'SEC-PEER')", [peerParent, id.schoolA, peer]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.pupilA, peerParent]);
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

describe("legacy routine hardening and governed admission boundary", () => {
  it("pins ordinary legacy paths while retaining native constructor metadata and implementations", async () => {
    for (const [signature, implementation] of constructors) {
      const result = await db.query(`select l.lanname as language,p.prosrc,p.prosecdef,p.provolatile,p.proconfig
        from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure($1)`, [signature]);
      expect(result.rows).toEqual([{ language: "internal", prosrc: implementation, prosecdef: false, provolatile: "i", proconfig: null }]);
    }
    for (const signature of ["public.set_updated_at()", "public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)"]) {
      expect((await db.query("select proconfig from pg_proc where oid=to_regprocedure($1)", [signature])).rows)
        .toEqual([{ proconfig: ['search_path=""'] }]);
    }
    expect((await db.query("select bool_and(indisvalid and indisready) as valid from pg_index where indrelid='public.timetables'::regclass")).rows)
      .toEqual([{ valid: true }]);
    expect((await db.query("select conname from pg_constraint where conrelid='public.timetables'::regclass and contype='x' and convalidated order by conname")).rows)
      .toEqual([{ conname: "timetable_class_overlap" }, { conname: "timetable_duplicate_period" }, { conname: "timetable_teacher_overlap" }]);
    const range = `[${id.sectionA},${id.sectionA}]`;
    const result = await db.query(`select app_private.timetable_section_range($1,$1)::text as pair,
      app_private.timetable_section_range($1,$1,'[]')::text as inclusive,
      app_private.timetable_section_multirange()::text as empty,
      app_private.timetable_section_multirange(app_private.timetable_section_range($1,$1,'[]'))::text as single,
      app_private.timetable_section_multirange(variadic array[app_private.timetable_section_range($1,$1,'[]')])::text as variadic`, [id.sectionA]);
    expect(result.rows).toEqual([{ pair: "empty", inclusive: range, empty: "{}", single: `{${range}}`, variadic: `{${range}}` }]);
  });
  it("retains trigger timestamp behavior and does not reopen the frozen audit writer", async () => {
    await db.query("update public.students set updated_at='2000-01-01' where id=$1", [id.pupilA]);
    expect((await db.query("select updated_at>'2020-01-01' as stamped from public.students where id=$1", [id.pupilA])).rows).toEqual([{ stamped: true }]);
    expect((await db.query(`select has_function_privilege('anon','public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)','execute') anon,
      has_function_privilege('authenticated','public.write_audit_log(uuid,text,text,text,uuid,text,jsonb)','execute') authenticated`)).rows)
      .toEqual([{ anon: false, authenticated: false }]);
  });
  it("removes unintended anonymous helper execution and preserves authenticated RLS helpers", async () => {
    for (const signature of ["public.current_admin_school_id()", "public.update_my_teacher_phone(text)", "app_private.update_my_teacher_phone(text)"]) {
      expect((await db.query("select has_function_privilege('anon',$1,'execute') as allowed", [signature])).rows).toEqual([{ allowed: false }]);
    }
    expect((await db.query("select prosecdef from pg_proc where oid='public.update_my_teacher_phone(text)'::regprocedure")).rows).toEqual([{ prosecdef: false }]);
    expect(await actor(id.adminA, "select public.current_admin_school_id() as school")).toEqual([{ school: id.schoolA }]);
    expect(await actor(id.teacherA, "select public.current_admin_school_id() as school")).toEqual([{ school: null }]);
    expect(await actor(id.adminA, "select public.current_user_has_role('school_admin'::public.app_role) as own_role")).toEqual([{ own_role: true }]);
    expect(await actor(id.adminB, "select public.current_user_school_ids() as school")).toEqual([{ school: id.schoolB }]);
  });
  it.each([id.adminA, id.adminB, principal, finance, reception, id.teacherA, id.guardianA, id.studentUserA])(
    "denies raw student AND enrollment INSERT from authenticated actor %s", async (user) => {
      await deny(actor(user, "insert into public.students(school_id,admission_no,first_name) values($1,$2,'Bypass') returning id", [id.schoolA, `RAW-${user}`]));
      await deny(actor(user, "insert into public.enrollments(student_id,academic_year_id,class_id,section_id) values($1,$2,$3,$4) returning id",
        [id.unlinkedPupilA, id.yearA, id.classA, id.sectionA]));
    },
  );
  it.each([id.adminA, principal])("retains atomic governed office admission for %s", async (user) => {
    const result = await admit(user, `SEC-${user}`), pupil = result[0].pupil;
    expect((await db.query(`select s.profile_id,e.student_id,e.academic_year_id,e.class_id,e.section_id,e.status
      from public.students s join public.enrollments e on e.student_id=s.id where s.id=$1`, [pupil])).rows)
      .toEqual([{ profile_id: null, student_id: pupil, academic_year_id: id.yearA, class_id: id.classA, section_id: id.sectionA, status: "active" }]);
    await expect(admit(user, `SEC-${user}`)).rejects.toMatchObject({ code: "23505" });
    expect((await db.query("select count(*)::int as n from public.students where admission_no=$1", [`SEC-${user}`])).rows).toEqual([{ n: 1 }]);
  });
  it("rolls back the student when the governed enrollment cannot commit", async () => {
    await db.exec(`create function app_private.security_test_reject_enrollment() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Test enrollment rejection';end;$$;
      create trigger security_test_reject_enrollment before insert on public.enrollments for each row execute function app_private.security_test_reject_enrollment();`);
    await expect(admit(id.adminA, "SEC-ROLLBACK")).rejects.toThrow(/Test enrollment rejection/);
    expect((await db.query("select count(*)::int as n from public.students where admission_no='SEC-ROLLBACK'")).rows).toEqual([{ n: 0 }]);
  });
  it.each([finance, reception, id.teacherA, id.guardianA, id.adminB])("does not turn office admission into a low-role or other-school endpoint: %s", async (user) => {
    await deny(admit(user, `RPC-DENY-${user}`));
  });
  it("preserves explicitly assigned class-teacher registration through its checked RPC", async () => {
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.students")).rows[0].n;
    const result = await actor(id.teacherA, "select * from public.register_student_for_class_teacher('Scoped teacher pupil')");
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ class_id: id.classA, section_id: id.sectionA });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.students")).rows[0].n).toBe(before + 1);
    await expect(actor(id.guardianA, "select * from public.register_student_for_class_teacher('Denied pupil')")).rejects.toThrow(/Exactly one linked teacher context/);
  });
  it("allows only current verified coherent teacher contact updates and normalizes empty input", async () => {
    await phone();
    expect((await db.query("select registered_mobile from public.teachers where id=$1", [id.teacherRecordA])).rows).toEqual([{ registered_mobile: "9876512345" }]);
    await phone(id.teacherA, "  ");
    expect((await db.query("select registered_mobile from public.teachers where id=$1", [id.teacherRecordA])).rows).toEqual([{ registered_mobile: null }]);
    await expect(phone(id.teacherA, "1".repeat(41))).rejects.toMatchObject({ code: "22023" });
    for (const user of [id.guardianA, id.studentUserA, finance, reception, id.adminA]) await deny(phone(user));
  });
  it.each(["removed-role", "wrong-role-school", "profile-school", "inactive-profile", "inactive-school", "missing-session", "unverified-contact", "banned", "ambiguous-teacher"])(
    "fails the teacher contact mutation closed for %s without relying only on HTTP middleware", async (fault) => {
      if (fault === "removed-role") await db.query("delete from public.user_roles where user_id=$1", [id.teacherA]);
      if (fault === "wrong-role-school") await db.query("update public.user_roles set school_id=$2 where user_id=$1", [id.teacherA, id.schoolB]);
      if (fault === "profile-school") await db.query("update public.profiles set school_id=$2 where id=$1", [id.teacherA, id.schoolB]);
      if (fault === "inactive-profile") await db.query("update public.profiles set is_active=false where id=$1", [id.teacherA]);
      if (fault === "inactive-school") await db.query("update public.schools set is_active=false where id=$1", [id.schoolA]);
      if (fault === "missing-session") await db.query("delete from auth.sessions where user_id=$1", [id.teacherA]);
      if (fault === "unverified-contact") await db.query("update auth.users set email_confirmed_at=null where id=$1", [id.teacherA]);
      if (fault === "banned") await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [id.teacherA]);
      if (fault === "ambiguous-teacher") await db.query("insert into public.teachers(school_id,profile_id,employee_id,full_name) values($1,$2,'SEC-EXTRA','Ambiguous')", [id.schoolA, id.teacherA]);
      await deny(phone(id.teacherA, "123", { http: false }));
      expect((await db.query("select registered_mobile from public.teachers where id=$1", [id.teacherRecordA])).rows).toEqual([{ registered_mobile: null }]);
    },
  );
  it("binds a teacher change to its own native session and current TOTP state", async () => {
    await deny(phone(id.teacherA, "123", { sessionId: id.guardianA, http: false }));
    await deny(phone(id.teacherA, "123", { sessionId: "malformed", http: false }));
    const factor = randomUUID();
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status) values($1,$2,'totp','verified')", [factor, id.teacherA]);
    await db.query("update auth.sessions set aal='aal2',factor_id=$2 where id=$1", [id.teacherA, factor]);
    await deny(phone(id.teacherA, "123", { aal: "aal1", http: false }));
    await phone(id.teacherA, "123", { aal: "aal2" });
    await db.query("update auth.mfa_factors set status='unverified' where id=$1", [factor]);
    await deny(phone(id.teacherA, "456", { aal: "aal2", http: false }));
    expect((await db.query("select registered_mobile from public.teachers where id=$1", [id.teacherRecordA])).rows).toEqual([{ registered_mobile: "123" }]);
  });
  it("retains school-office Parent directory reads while hiding unrelated guardian contacts/links", async () => {
    for (const user of [id.adminA, principal]) {
      expect(await actor(user, "select id from public.parents where school_id=$1 order by id", [id.schoolA]))
        .toEqual([id.parentA, peerParent].sort().map((parent) => ({ id: parent })));
      expect(await actor(user, "select parent_id from public.student_parents where student_id=$1 order by parent_id", [id.pupilA]))
        .toEqual([id.parentA, peerParent].sort().map((parent) => ({ parent_id: parent })));
    }
    expect(await actor(id.guardianA, "select id from public.parents where school_id=$1", [id.schoolA])).toEqual([{ id: id.parentA }]);
    expect(await actor(id.guardianA, "select parent_id from public.student_parents where student_id=$1", [id.pupilA])).toEqual([{ parent_id: id.parentA }]);
    for (const user of [id.teacherA, id.studentUserA, id.adminB]) {
      expect(await actor(user, "select id from public.parents where school_id=$1", [id.schoolA])).toEqual([]);
      expect(await actor(user, "select parent_id from public.student_parents where student_id=$1", [id.pupilA])).toEqual([]);
    }
  });
});
