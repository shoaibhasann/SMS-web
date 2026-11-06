// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const phone = "+919876543210", otherPhone = "+919876543211", existingPhone = "+919876543212";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Invite = { id: string; token: string; expires_at: string };
type Reserve = { send: boolean; reason?: "duplicate" | "ineligible" | "rate_limited"; school_id?: string };
let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const user of (await db.query<{ id: string }>("select id from auth.users")).rows) {
    await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [user.id]);
  }
  await db.query("insert into auth.mfa_amr_claims(session_id,authentication_method,created_at) values($1,'password',now())", [id.guardianA]);
  await db.exec("begin");
  await actor(id.guardianA, "select public.authorize_my_guardian_phone_change($1)", [existingPhone]);
  await beginPhoneChange(id.guardianA, existingPhone);
  await finishPhoneChange(id.guardianA, existingPhone);
  await db.exec("commit");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown> = Record<string, unknown>>(
  user: string | null, query: string, values: unknown[] = [], role: "authenticated" | "anon" | "service_role" = "authenticated",
  session: string | null = user,
) {
  await db.exec("savepoint hybrid_actor");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: session })]);
    const result = await db.query<Row>(query, values);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','',true)");
    await db.exec("release savepoint hybrid_actor");
    return result;
  } catch (error) {
    await db.exec("rollback to savepoint hybrid_actor; release savepoint hybrid_actor");
    throw error;
  }
}
async function issue(number = phone, student = id.pupilA, by = id.adminA, school = id.schoolA) {
  return (await actor<{ value: Invite }>(by, "select public.issue_guardian_phone_invitation($1,$2,$3) as value", [school, student, number])).rows[0].value;
}
async function createUser(number = phone, verified = true) {
  const user = randomUUID();
  await db.query("insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,$3)", [user, number.slice(1), verified ? new Date() : null]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [user]);
  return user;
}
const accept = (user: string, invite: Invite) => actor<{ value: { student_id: string; school_id: string } }>(user,
  "select public.accept_guardian_invitation($1) as value", [invite.token]);
const permit = async (number = phone, ip = "ip-1") => (await actor<{ value: boolean }>(null,
  "select public.authorize_guardian_sms_request($1,$2) as value", [number, hash(ip)], "service_role")).rows[0].value;
const reserve = async (user: string, number = phone, event: string = randomUUID(), limits = [200, 100, 5]) =>
  (await actor<{ value: Reserve }>(null, "select public.reserve_guardian_sms($1,$2,$3,$4,$5,$6) as value", [user, number, event, ...limits], "service_role")).rows[0].value;
const denied = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "42501" });
const invalid = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "22023" });
const unavailable = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: "P0001" });
async function beginPhoneChange(user: string, number: string) {
  await db.query("update auth.users set phone_change=$2,phone_change_token=$3,phone_change_sent_at=clock_timestamp() where id=$1", [user, number.slice(1), randomUUID()]);
}
async function finishPhoneChange(user: string, number: string) {
  await db.query("update auth.users set phone=$2,phone_change='',phone_change_token='',phone_confirmed_at=clock_timestamp() where id=$1", [user, number.slice(1)]);
}
async function ageRequests() {
  await db.exec("update app_private.guardian_sms_permits set issued_at=issued_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes'; update app_private.guardian_sms_reservations set reserved_at=reserved_at-interval '2 minutes'");
}

describe("governed mobile guardian invitations", () => {
  it("creates a verified phone-only guardian on the same Auth user and reads only the invited child", async () => {
    const invite = await issue();
    const user = await createUser();
    expect((await db.query("select email,is_active from public.profiles where id=$1", [user])).rows).toEqual([{ email: null, is_active: true }]);
    expect((await db.query("select role from public.user_roles where user_id=$1", [user])).rows).toEqual([]);
    expect((await accept(user, invite)).rows[0].value).toEqual({ school_id: id.schoolA, student_id: id.pupilA });
    expect((await db.query("select profile_id,registered_mobile from public.parents where profile_id=$1", [user])).rows)
      .toEqual([{ profile_id: user, registered_mobile: phone }]);
    expect((await actor(user, "select id from public.attendance order by id")).rows).toEqual([{ id: id.attendanceA }]);
    expect((await actor(user, "select id from public.fee_payments order by id")).rows).toEqual([{ id: id.paymentA }]);
    expect((await actor(user, "select role from public.user_roles where user_id=$1", [user])).rows).toEqual([{ role: "parent" }]);
    await denied(actor(user, "select public.issue_guardian_phone_invitation($1,$2,$3)", [id.schoolA, id.pupilA, otherPhone]));
    await unavailable(accept(user, invite));
  });

  it.each([id.teacherA, id.guardianA, id.studentUserA, id.adminB])("denies issuance by lower or other-school role %s", async (user) => {
    await denied(issue(phone, id.pupilA, user));
  });
  it("denies missing/revoked/expired admin sessions and disabled identities", async () => {
    await denied(actor(id.adminA, "select public.issue_guardian_phone_invitation($1,$2,$3)", [id.schoolA, id.pupilA, phone], "authenticated", null));
    await denied(actor(id.adminA, "select public.issue_guardian_phone_invitation($1,$2,$3)", [id.schoolA, id.pupilA, phone], "authenticated", "malformed-session"));
    await db.query("delete from auth.sessions where id=$1", [id.adminA]);
    await denied(issue());
    await db.query("insert into auth.sessions(id,user_id,not_after) values($1,$1,now()-interval '1 second')", [id.adminA]);
    await denied(issue());
    await db.query("update auth.sessions set not_after=null where id=$1", [id.adminA]);
    await db.query("update public.profiles set is_active=false where id=$1", [id.adminA]);
    await denied(issue());
  });
  it.each(["9876543210", "+12025550110", "+915876543210", "+91987654321", "", " +919876543210"])("rejects noncanonical or non-Indian number %s", async (number) => {
    await invalid(issue(number));
  });
  it("requires exact verified destination, active student/current year and current issuer scope", async () => {
    const invite = await issue();
    const unverified = await createUser(phone, false), wrong = await createUser(otherPhone);
    await denied(accept(unverified, invite));
    await denied(accept(wrong, invite));
    await db.query("update auth.users set phone_confirmed_at=now() where id=$1", [unverified]);
    await db.query("delete from public.user_roles where user_id=$1 and role='school_admin'", [id.adminA]);
    await unavailable(accept(unverified, invite));
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'school_admin')", [id.adminA, id.schoolA]);
    await db.query("update public.enrollments set status='withdrawn' where student_id=$1", [id.pupilA]);
    await unavailable(accept(unverified, invite));
  });
  it("rotates pending tokens, lists channel explicitly and keeps legacy email invites working", async () => {
    const old = await issue(), fresh = await issue();
    const user = await createUser();
    await unavailable(accept(user, old));
    const list = (await actor<{ value: { id: string; email: string | null; phone: string | null }[] }>(id.adminA,
      "select public.list_guardian_invitations($1,$2) as value", [id.schoolA, id.pupilA])).rows[0].value;
    expect(list.find((i) => i.id === fresh.id)).toMatchObject({ email: null, phone });
    const emailInvite = (await actor<{ value: Invite }>(id.adminA, "select public.issue_guardian_invitation($1,$2,$3) as value", [id.schoolA, id.unlinkedPupilA, "unlinked-claimant-a@recovery.invalid"])).rows[0].value;
    expect((await accept(id.claimantA, emailInvite)).rows[0].value.student_id).toBe(id.unlinkedPupilA);
  });
  it("refuses duplicate school-record mobile identities and privileged Auth accounts", async () => {
    await db.query("update public.parents set registered_mobile=$2 where id=$1", [id.parentA, phone.slice(3)]);
    await invalid(issue());
    await db.query("update public.parents set registered_mobile=$2 where id=$1", [id.parentA, existingPhone]);
    await db.query("update auth.users set phone=$2,phone_confirmed_at=now() where id=$1", [id.teacherA, phone.slice(1)]);
    await invalid(issue());
  });
  it("rechecks school-record collisions at acceptance instead of duplicating an existing guardian", async () => {
    const invite = await issue(), user = await createUser();
    await db.query("update public.parents set registered_mobile=$2 where id=$1", [id.parentA, phone.slice(3)]);
    await denied(accept(user, invite));
    expect((await db.query("select id from public.parents where profile_id=$1", [user])).rows).toEqual([]);
    expect((await db.query("select role from public.user_roles where user_id=$1", [user])).rows).toEqual([]);
  });
  it.each(["expired", "revoked", "privileged", "issuer-banned"])("rejects a phone invitation after %s changes", async (condition) => {
    const invite = await issue(), user = await createUser();
    if (condition === "expired") await db.query("update app_private.guardian_invitations set created_at=now()-interval '73 hours',expires_at=now()-interval '1 second' where id=$1", [invite.id]);
    if (condition === "revoked") await actor(id.adminA, "select public.revoke_guardian_invitation($1)", [invite.id]);
    if (condition === "privileged") await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [user, id.schoolA]);
    if (condition === "issuer-banned") await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [id.adminA]);
    if (condition === "privileged") await denied(accept(user, invite)); else await unavailable(accept(user, invite));
    expect((await db.query("select id from public.parents where profile_id=$1", [user])).rows).toEqual([]);
  });
  it("blocks ambiguous other-school invitations and account bindings", async () => {
    await issue();
    await invalid(issue(phone, id.pupilB, id.adminB, id.schoolB));
    await db.query("update app_private.guardian_invitations set revoked_at=now()");
    const user = await createUser();
    await db.query("update public.profiles set school_id=$2 where id=$1", [user, id.schoolB]);
    await invalid(issue());
  });
  it("preserves sibling links/history during revoke and exact-account mobile re-invite", async () => {
    const first = await issue(), sibling = await issue(phone, id.unlinkedPupilA);
    const user = await createUser();
    await accept(user, first); await accept(user, sibling);
    const parent = (await db.query<{ id: string }>("select id from public.parents where profile_id=$1", [user])).rows[0].id;
    const pending = await issue();
    await actor(id.adminA, "select public.revoke_guardian_access($1,$2,$3,$4)", [id.schoolA, id.pupilA, parent, "Synthetic guardian access correction"]);
    await unavailable(accept(user, pending));
    expect((await actor(user, "select id from public.attendance order by id")).rows).toEqual([{ id: id.attendanceUnlinkedA }]);
    const access = (await actor<{ value: { reinvitable_guardians: { revocation_id: string; email: null; phone: string }[] } }>(id.adminA,
      "select public.lookup_guardian_access($1,$2) as value", [id.schoolA, "REC-A-001"])).rows[0].value;
    expect(access.reinvitable_guardians[0]).toMatchObject({ email: null, phone });
    const reinvite = (await actor<{ value: Invite & { email: null; phone: string } }>(id.adminA,
      "select public.reinvite_guardian_access($1,$2,$3) as value", [id.schoolA, id.pupilA, access.reinvitable_guardians[0].revocation_id])).rows[0].value;
    expect(reinvite).toMatchObject({ email: null, phone });
    await accept(user, reinvite);
    expect((await db.query("select count(*)::int as count from public.parents where profile_id=$1", [user])).rows).toEqual([{ count: 1 }]);
    expect((await actor(user, "select id from public.attendance order by id")).rows).toEqual([{ id: id.attendanceA }, { id: id.attendanceUnlinkedA }]);
    expect((await db.query<{ amount: string }>("select amount from public.fee_payments where id=$1", [id.paymentA])).rows[0].amount).toBe("250.00");
  });
  it("never interprets an email OTP as current-mobile proof for an email-backed guardian", async () => {
    const otpSession = randomUUID();
    await db.query("insert into auth.sessions(id,user_id) values($1,$2)", [otpSession, id.guardianA]);
    await db.query("insert into auth.mfa_amr_claims(session_id,authentication_method,created_at) values($1,'otp',now())", [otpSession]);
    await denied(actor(id.guardianA, "select public.authorize_my_guardian_phone_change($1)", [otherPhone], "authenticated", otpSession));
    await actor(id.guardianA, "select public.authorize_my_guardian_phone_change($1)", [otherPhone]);
  });
  it("creates an empty-email native-shaped Auth profile without any default school or role", async () => {
    const user = randomUUID();
    await db.query("insert into auth.users(id,email,phone,raw_user_meta_data) values($1,'',$2,$3)",
      [user, phone.slice(1), JSON.stringify({ role: "school_admin", school_id: id.schoolA })]);
    expect((await db.query("select is_active,school_id from public.profiles where id=$1", [user])).rows).toEqual([{ is_active: true, school_id: null }]);
    expect((await db.query("select role from public.user_roles where user_id=$1", [user])).rows).toEqual([]);
  });
  it("requires fresh current-phone proof for phone-only number change and retires old invitations", async () => {
    const first = await issue(), sibling = await issue(phone, id.unlinkedPupilA);
    const user = await createUser(); await accept(user, first);
    await db.exec("savepoint credential_removal");
    await denied(db.query("update auth.users set phone=null where id=$1", [user]));
    await db.exec("rollback to savepoint credential_removal; release savepoint credential_removal");
    await denied(actor(user, "select public.authorize_my_guardian_phone_change($1)", [otherPhone]));
    await db.query("insert into auth.mfa_amr_claims(session_id,authentication_method,created_at) values($1,'otp',now()-interval '6 minutes')", [user]);
    await denied(actor(user, "select public.authorize_my_guardian_phone_change($1)", [otherPhone]));
    await db.query("update auth.mfa_amr_claims set created_at=now() where session_id=$1", [user]);
    await actor(user, "select public.authorize_my_guardian_phone_change($1)", [otherPhone]);
    await beginPhoneChange(user, otherPhone); await finishPhoneChange(user, otherPhone);
    expect((await db.query("select registered_mobile from public.parents where profile_id=$1", [user])).rows).toEqual([{ registered_mobile: otherPhone }]);
    await unavailable(accept(user, sibling));
    await db.query("update app_private.guardian_invitations set revoked_at=null where id=$1", [sibling.id]);
    const recycled = await createUser(phone);
    await denied(accept(recycled, sibling));
    expect((await actor(user, "select id from public.attendance order by id")).rows).toEqual([{ id: id.attendanceA }]);
    expect((await db.query("select profile_id from public.parents where profile_id=$1", [user])).rows).toEqual([{ profile_id: user }]);
  });
});

describe("CAPTCHA permits and private SMS spending", () => {
  it.each(["anon", "authenticated"] as const)("denies direct permit/reservation and raw-table access for %s", async (role) => {
    await denied(actor(id.guardianA, "select public.authorize_guardian_sms_request($1,$2)", [existingPhone, hash("ip")], role));
    await denied(actor(id.guardianA, "select public.reserve_guardian_sms($1,$2,$3,200,100,5)", [id.guardianA, existingPhone, randomUUID()], role));
    for (const table of ["guardian_sms_permits", "guardian_sms_reservations"]) {
      await denied(actor(id.guardianA, `select * from app_private.${table}`, [], role));
    }
  });
  it("allows a signed first-signup hook matching a live invitation before the Auth row is visible", async () => {
    await issue(); const user = randomUUID();
    expect(await permit()).toBe(true);
    expect(await reserve(user)).toEqual({ send: true, school_id: id.schoolA });
    expect((await db.query("select count(*)::int as count from auth.users where id=$1", [user])).rows).toEqual([{ count: 0 }]);
  });
  it("requires one short-lived CAPTCHA permit and consumes it once without storing raw destinations", async () => {
    await issue(); const user = await createUser();
    expect(await reserve(user)).toEqual({ send: false, reason: "rate_limited" });
    expect(await permit()).toBe(true);
    await db.exec("update app_private.guardian_sms_permits set issued_at=now()-interval '3 minutes',expires_at=now()-interval '1 second'");
    expect(await reserve(user)).toEqual({ send: false, reason: "rate_limited" });
    await ageRequests(); expect(await permit()).toBe(true);
    expect(await reserve(user)).toEqual({ send: true, school_id: id.schoolA });
    expect(await reserve(user)).toEqual({ send: false, reason: "rate_limited" });
    const rows = (await db.query("select to_jsonb(p) as record from app_private.guardian_sms_permits p union all select to_jsonb(r) from app_private.guardian_sms_reservations r")).rows;
    expect(JSON.stringify(rows)).not.toContain(phone);
    expect(JSON.stringify(rows)).not.toContain("ip-1");
    const fields = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='app_private' and table_name in ('guardian_sms_permits','guardian_sms_reservations')")).rows;
    expect(fields.map((f) => f.column_name)).not.toContain("otp");
  });
  it("deduplicates the signed webhook before consuming any later permit", async () => {
    await issue(); const user = await createUser(), event = randomUUID();
    await permit(); expect((await reserve(user, phone, event)).send).toBe(true);
    expect(await reserve(user, phone, event)).toEqual({ send: false, reason: "duplicate" });
    expect(await reserve(randomUUID(), phone, event)).toEqual({ send: false, reason: "ineligible" });
    await ageRequests(); await permit();
    expect(await reserve(user, phone, event)).toEqual({ send: false, reason: "duplicate" });
    expect((await db.query("select count(*)::int as count from app_private.guardian_sms_permits where consumed_at is null")).rows).toEqual([{ count: 1 }]);
    expect((await db.query("select count(*)::int as count from app_private.guardian_sms_reservations")).rows).toEqual([{ count: 1 }]);
  });
  it("denies unknown, revoked and no-longer-current invitations without a paid reservation", async () => {
    const user = await createUser(); await permit();
    expect(await reserve(user)).toEqual({ send: false, reason: "ineligible" });
    const invite = await issue();
    await actor(id.adminA, "select public.revoke_guardian_invitation($1)", [invite.id]);
    expect(await reserve(user)).toEqual({ send: false, reason: "ineligible" });
    await issue(); await db.query("update public.academic_years set is_current=false where id=$1", [id.yearA]);
    expect(await reserve(user)).toEqual({ send: false, reason: "ineligible" });
    expect((await db.query("select count(*)::int as count from app_private.guardian_sms_reservations")).rows).toEqual([{ count: 0 }]);
  });
  it("blocks staff who also hold a parent role, inactive and banned guardian identities", async () => {
    await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'teacher')", [id.guardianA, id.schoolA]);
    await permit(existingPhone); expect(await reserve(id.guardianA, existingPhone)).toEqual({ send: false, reason: "ineligible" });
    await db.query("delete from public.user_roles where user_id=$1 and role='teacher'", [id.guardianA]);
    await db.query("update public.profiles set is_active=false where id=$1", [id.guardianA]);
    expect(await reserve(id.guardianA, existingPhone)).toEqual({ send: false, reason: "ineligible" });
    await db.query("update public.profiles set is_active=true where id=$1", [id.guardianA]);
    await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [id.guardianA]);
    expect(await reserve(id.guardianA, existingPhone)).toEqual({ send: false, reason: "ineligible" });
  });
  it("allows existing same-owner phone enrollment only for the authorized target and live proof", async () => {
    await actor(id.guardianA, "select public.authorize_my_guardian_phone_change($1)", [otherPhone]);
    await permit(otherPhone);
    expect(await reserve(id.guardianA, otherPhone)).toEqual({ send: true, school_id: id.schoolA });
    await permit(phone); expect(await reserve(id.guardianA, phone)).toEqual({ send: false, reason: "ineligible" });
    await ageRequests(); await permit(otherPhone);
    await db.query("delete from auth.mfa_amr_claims where session_id=$1", [id.guardianA]);
    await db.query("delete from auth.sessions where id=$1", [id.guardianA]);
    expect(await reserve(id.guardianA, otherPhone)).toEqual({ send: false, reason: "ineligible" });
  });
  it("enforces cooldown plus phone, school and global daily budgets", async () => {
    await issue(); const user = await createUser(); await permit();
    expect((await reserve(user, phone, randomUUID(), [2, 2, 1])).send).toBe(true);
    expect(await permit()).toBe(false);
    await ageRequests(); await permit();
    expect(await reserve(user, phone, randomUUID(), [2, 2, 1])).toEqual({ send: false, reason: "rate_limited" });
    await permit(existingPhone);
    expect((await reserve(id.guardianA, existingPhone, randomUUID(), [2, 2, 5])).send).toBe(true);
    await issue(otherPhone); const other = await createUser(otherPhone); await permit(otherPhone);
    expect(await reserve(other, otherPhone, randomUUID(), [2, 2, 5])).toEqual({ send: false, reason: "rate_limited" });
    expect((await db.query("select count(*)::int as count from app_private.guardian_sms_reservations")).rows).toEqual([{ count: 2 }]);
  });
  it("enforces school and global budgets independently across two schools", async () => {
    await issue(); const first = await createUser(); await permit();
    expect((await reserve(first, phone, randomUUID(), [10, 1, 5])).send).toBe(true);
    await issue(otherPhone); const second = await createUser(otherPhone); await permit(otherPhone);
    expect(await reserve(second, otherPhone, randomUUID(), [10, 1, 5])).toEqual({ send: false, reason: "rate_limited" });
    const schoolBPhone = "+919876543213";
    await issue(schoolBPhone, id.pupilB, id.adminB, id.schoolB); const schoolBUser = await createUser(schoolBPhone); await permit(schoolBPhone);
    expect((await reserve(schoolBUser, schoolBPhone, randomUUID(), [10, 1, 5])).send).toBe(true);
    await ageRequests(); await permit(schoolBPhone);
    expect(await reserve(schoolBUser, schoolBPhone, randomUUID(), [2, 100, 5])).toEqual({ send: false, reason: "rate_limited" });
  });
  it("opportunistically deletes expired pseudonymous history while preserving today's spending", async () => {
    await db.query(`insert into app_private.guardian_sms_permits(phone_hash,ip_hash,issued_at,expires_at)
      values(sha256(convert_to('old-phone','UTF8')),sha256(convert_to('old-ip','UTF8')),now()-interval '9 days',now()-interval '8 days')`);
    await db.query(`insert into app_private.guardian_sms_reservations(webhook_hash,user_id,school_id,phone_hash,reserved_at,budget_day)
      values(sha256(convert_to('old-event','UTF8')),$1,$2,sha256(convert_to('old-phone','UTF8')),now()-interval '31 days',current_date-31)`, [id.guardianA, id.schoolA]);
    await permit(existingPhone);
    expect((await reserve(id.guardianA, existingPhone)).send).toBe(true);
    expect((await db.query("select count(*)::int as count from app_private.guardian_sms_permits")).rows).toEqual([{ count: 1 }]);
    expect((await db.query("select count(*)::int as count from app_private.guardian_sms_reservations")).rows).toEqual([{ count: 1 }]);
  });
  it("caps the CAPTCHA endpoint per IP and global day using an append-only history", async () => {
    for (let index = 0; index < 20; index++) expect(await permit(`+91987654${String(3200 + index)}`, "same-ip")).toBe(true);
    expect(await permit("+919876543299", "same-ip")).toBe(false);
    expect(await permit("+919876543299", "another-ip")).toBe(true);
    await db.exec(`insert into app_private.guardian_sms_permits(phone_hash,ip_hash,issued_at,expires_at)
      select sha256(convert_to('synthetic-'||n::text,'UTF8')),sha256(convert_to('synthetic-ip-'||n::text,'UTF8')),clock_timestamp(),clock_timestamp()+interval '90 seconds'
      from generate_series(1,979) n`);
    expect(await permit("+919876543298", "fresh-ip")).toBe(false);
  });
  it("validates server limits and provider identifiers before any reserve", async () => {
    await invalid(actor(null, "select public.authorize_guardian_sms_request($1,$2)", [phone, "raw-ip"], "service_role"));
    await invalid(reserve(id.guardianA, existingPhone, randomUUID(), [0, 100, 5]));
    await invalid(reserve(id.guardianA, existingPhone, "", [200, 100, 5]));
    await invalid(reserve(id.guardianA, existingPhone, randomUUID(), [200, 100, 11]));
  });
});
