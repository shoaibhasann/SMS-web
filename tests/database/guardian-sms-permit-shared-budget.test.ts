// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

const phone = "+919876543210";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let db: PGlite;

beforeAll(async () => {
  db = await createRecoveryDatabase();
  await seedRecoveryData(db);
  await db.query("insert into auth.sessions(id,user_id) values($1,$1)", [id.adminA]);
}, 60_000);
afterAll(async () => { await db?.close(); });

async function as<Row extends Record<string, unknown>>(user: string | null, role: string, query: string, values: unknown[]) {
  await db.exec(`begin; set local role ${role}`);
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [user ?? "", JSON.stringify({ sub: user, session_id: user })]);
  try { return (await db.query<Row>(query, values)).rows[0]; } finally { await db.exec("commit"); }
}
const permit = async (number: string, ip: string) => (await as<{ value: boolean }>(null, "service_role",
  "select public.authorize_guardian_sms_request($1,$2) as value", [number, hash(ip)])).value;

describe("anonymous CAPTCHA permits do not share one platform-wide pool", () => {
  it("still admits an eligible guardian after 1,000+ anonymous permits for unregistered numbers today", async () => {
    await as(id.adminA, "authenticated", "select public.issue_guardian_phone_invitation($1,$2,$3)", [id.schoolA, id.pupilA, phone]);
    // Attacker traffic: 1,050 unregistered numbers spread over many (per-/64) IP buckets, all issued today.
    await db.exec(`insert into app_private.guardian_sms_permits(phone_hash,ip_hash,issued_at,expires_at)
      select sha256(convert_to('attacker-'||n::text,'UTF8')),sha256(convert_to('attacker-ip-'||(n/20)::text,'UTF8')),
        clock_timestamp(),clock_timestamp()+interval '90 seconds' from generate_series(1,1050) n`);
    expect(await permit(phone, "legit-guardian-ip")).toBe(true);

    const user = randomUUID();
    await db.query("insert into auth.users(id,phone,phone_confirmed_at) values($1,$2,now())", [user, phone.slice(1)]);
    const reservation = await as<{ value: { send: boolean } }>(null, "service_role",
      "select public.reserve_guardian_sms($1,$2,$3,200,100,5) as value", [user, phone, randomUUID()]);
    expect(reservation.value.send).toBe(true);
  });

  it("keeps the 20/hour limit per IP bucket", async () => {
    for (let index = 0; index < 20; index++) expect(await permit(`+91987650${String(1000 + index)}`, "busy-ip")).toBe(true);
    expect(await permit("+919876509999", "busy-ip")).toBe(false);
  });
});
