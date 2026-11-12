// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

// web-guardian#3: issuing a phone invitation must not tell one school whether a
// mobile belongs to an account, school record or pending invitation in another school.
const phone = "+919876543210", control = "+919876543219", guardianPhone = "+919876543212";
type Invite = { id: string; token: string; expires_at: string };
let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  for (const user of (await db.query<{ id: string }>("select id from auth.users")).rows) {
    await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [user.id]);
  }
  // Same governed phone-enrollment path as guardian-hybrid-phone-auth.test.ts.
  await db.query("insert into auth.mfa_amr_claims(session_id,authentication_method,created_at) values($1,'password',now())", [id.guardianA]);
  await db.exec("begin");
  await actor(id.guardianA, "select public.authorize_my_guardian_phone_change($1)", [guardianPhone]);
  await db.query("update auth.users set phone_change=$2,phone_change_token=$3,phone_change_sent_at=clock_timestamp() where id=$1",
    [id.guardianA, guardianPhone.slice(1), randomUUID()]);
  await db.query("update auth.users set phone=$2,phone_change='',phone_change_token='',phone_confirmed_at=clock_timestamp() where id=$1",
    [id.guardianA, guardianPhone.slice(1)]);
  await db.exec("commit");
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function actor<Row extends Record<string, unknown>>(user: string | null, query: string, values: unknown[] = [],
  role: "authenticated" | "service_role" = "authenticated") {
  await db.exec("savepoint cross_school_actor");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user ?? "", JSON.stringify({ sub: user, session_id: user })]);
    const result = await db.query<Row>(query, values);
    await db.exec("reset role; release savepoint cross_school_actor");
    return result;
  } catch (error) {
    await db.exec("rollback to savepoint cross_school_actor; release savepoint cross_school_actor");
    throw error;
  }
}
const issue = async (number: string, school: "A" | "B", student = school === "A" ? id.pupilA : id.pupilB) =>
  (await actor<{ value: Invite }>(school === "A" ? id.adminA : id.adminB, "select public.issue_guardian_phone_invitation($1,$2,$3) as value",
    [school === "A" ? id.schoolA : id.schoolB, student, number])).rows[0].value;
const listB = async () => (await actor<{ value: Record<string, unknown>[] }>(id.adminB,
  "select public.list_guardian_invitations($1,$2) as value", [id.schoolB, id.pupilB])).rows[0].value;
const accept = (user: string, invite: Invite) => actor<{ value: { school_id: string } }>(user,
  "select public.accept_guardian_invitation($1) as value", [invite.token]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function reserve(user: string, number: string) {
  await actor(null, "select public.authorize_guardian_sms_request($1,$2)", [number, hash(`ip-${randomUUID()}`)], "service_role");
  return (await actor<{ value: { send: boolean; school_id?: string } }>(null,
    "select public.reserve_guardian_sms($1,$2,$3,200,100,5) as value", [user, number, randomUUID()], "service_role")).rows[0].value;
}
async function createUser(number: string) {
  const user = randomUUID();
  await db.query("insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())", [user, number.slice(1)]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [user]);
  return user;
}
async function expectNeutralIssue(number: string) {
  const fresh = await issue(control, "B");
  const probe = await issue(number, "B");
  expect(Object.keys(probe).sort()).toEqual(Object.keys(fresh).sort());
  const rows = await listB();
  const [probeRow, freshRow] = [probe.id, fresh.id].map((invite) => rows.find((row) => row.id === invite)!);
  expect(Object.keys(probeRow).sort()).toEqual(Object.keys(freshRow).sort());
  expect(probeRow).toMatchObject({ phone: number, accepted_at: null, revoked_at: null });
  return probe;
}

describe("phone invitation issuance across schools", () => {
  it("issues normally for a number pending at another school without disturbing that school's invitation", async () => {
    const inviteA = await issue(phone, "A");
    const inviteB = await expectNeutralIssue(phone);
    expect(await issue(phone, "A", id.unlinkedPupilA)).toMatchObject({ token: expect.any(String) });
    const user = await createUser(phone);
    expect(await reserve(user, phone)).toEqual({ send: true, school_id: id.schoolA });
    expect((await accept(user, inviteA)).rows[0].value.school_id).toBe(id.schoolA);
    await expect(accept(user, inviteB)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select school_id from public.parents where profile_id=$1", [user])).rows).toEqual([{ school_id: id.schoolA }]);
  });

  it("does not reveal another school's guardian, staff or school record but still refuses same-school conflicts", async () => {
    const guardianInvite = await expectNeutralIssue(guardianPhone);
    expect(await reserve(id.guardianA, guardianPhone)).toEqual({ send: true, school_id: id.schoolA });
    await expect(accept(id.guardianA, guardianInvite)).rejects.toMatchObject({ code: "42501" });

    await db.query("update auth.users set phone=$2,phone_confirmed_at=now() where id=$1", [id.teacherA, phone.slice(1)]);
    await expectNeutralIssue(phone);
    await expect(issue(phone, "A")).rejects.toMatchObject({ code: "22023" });
    await db.query("update auth.users set phone=null where id=$1", [id.teacherA]);

    const recordPhone = "+919876543214";
    await db.query("update public.parents set registered_mobile=$2 where id=$1", [id.parentA, recordPhone.slice(3)]);
    await expectNeutralIssue(recordPhone);
    await expect(issue(recordPhone, "A")).rejects.toMatchObject({ code: "22023" });
  });
});
