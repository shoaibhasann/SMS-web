// @vitest-environment node
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase } from "../../scripts/database-recovery/replay.mjs";

let db: PGlite;

beforeAll(async () => { db = await createRecoveryDatabase(); }, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function as<Row extends Record<string, unknown>>(role: "anon" | "authenticated" | "service_role", query: string, values: unknown[] = []) {
  await db.exec("savepoint throttle_actor");
  try {
    await db.exec(`set local role ${role}`);
    const result = await db.query<Row>(query, values);
    await db.exec("reset role; release savepoint throttle_actor");
    return result;
  } catch (error) {
    await db.exec("rollback to savepoint throttle_actor; release savepoint throttle_actor");
    throw error;
  }
}
// The app sends only an HMAC of the client network; any 64-hex digest stands in for one here.
const ipHash = (ip: string) => createHash("sha256").update(ip).digest("hex");
const attempt = async (action: string, ip: string | null, subject: string) => (await as<{ allowed: boolean }>("service_role",
  "select public.consume_auth_endpoint_attempt($1,$2,$3) as allowed", [action, ip && ipHash(ip), subject])).rows[0].allowed;
const advisoryLocks = async () => (await db.query<{ key: string }>(
  "select (classid::bigint<<32|objid::bigint)::text as key from pg_catalog.pg_locks where locktype='advisory' and pid=pg_catalog.pg_backend_pid()",
)).rows.map((row) => row.key);
const repeat = async (times: number, action: string, ip: string | null, subject: (i: number) => string) => {
  const results: boolean[] = [];
  for (let i = 0; i < times; i++) results.push(await attempt(action, ip, subject(i)));
  return results;
};

describe("auth endpoint throttle", () => {
  it("allows each client IP ten attempts per action in fifteen minutes, then refuses without extending the lockout", async () => {
    expect(await repeat(10, "admin_email_verify", "203.0.113.7", (i) => `admin${i}@school.example`)).toEqual(Array(10).fill(true));
    expect(await attempt("admin_email_verify", "203.0.113.7", "fresh@school.example")).toBe(false);
    expect(await attempt("admin_email_verify", "203.0.113.8", "fresh@school.example")).toBe(true);
    expect(await attempt("recovery_mfa", "203.0.113.7", "fresh@school.example")).toBe(true);
    const rows = await db.query<{ count: number }>("select count(*)::int as count from app_private.auth_endpoint_attempts");
    expect(rows.rows[0].count).toBe(24);
  });

  it("locks per action and key, so different targets and clients never queue on one shared lock", async () => {
    await attempt("recovery_request", null, "a@school.example");
    await attempt("recovery_request", null, "b@school.example");
    expect(await advisoryLocks()).toHaveLength(2);
    await attempt("recovery_request", "203.0.113.7", "a@school.example");
    expect(await advisoryLocks()).toHaveLength(3);
    await attempt("recovery_mfa", "203.0.113.7", "a@school.example");
    expect(new Set(await advisoryLocks()).size).toBe(5);
  });

  it("accepts only a hex digest for the client, never a raw address", async () => {
    for (const ip of ["203.0.113.7", "2001:db8::1", "ab".repeat(31), "AB".repeat(32)]) {
      await expect(as("service_role", "select public.consume_auth_endpoint_attempt('recovery_mfa',$1,'user-1')", [ip]))
        .rejects.toMatchObject({ code: "22023" });
    }
  });

  it("limits a target email independently of the client IP, case-insensitively", async () => {
    const ips = (i: number) => `198.51.100.${i + 1}`;
    for (let i = 0; i < 3; i++) expect(await attempt("admin_email_request", ips(i), i % 2 ? "Admin@School.example" : " admin@school.example")).toBe(true);
    expect(await attempt("admin_email_request", "198.51.100.200", "ADMIN@school.example")).toBe(false);
    expect(await attempt("admin_email_request", "198.51.100.200", "other@school.example")).toBe(true);
    expect(await attempt("recovery_request", null, "admin@school.example")).toBe(true);
    for (let i = 0; i < 10; i++) expect(await attempt("admin_email_verify", ips(i), "admin@school.example")).toBe(true);
    expect(await attempt("admin_email_verify", "198.51.100.250", "admin@school.example")).toBe(false);
  });

  it("ignores attempts older than the window and prunes day-old rows", async () => {
    await repeat(3, "recovery_request", null, () => "staff@school.example");
    expect(await attempt("recovery_request", null, "staff@school.example")).toBe(false);
    await db.exec("update app_private.auth_endpoint_attempts set attempted_at=attempted_at-interval '16 minutes'");
    expect(await attempt("recovery_request", null, "staff@school.example")).toBe(true);
    await db.exec("update app_private.auth_endpoint_attempts set attempted_at=attempted_at-interval '2 days'");
    await attempt("recovery_request", null, "other@school.example");
    const rows = await db.query<{ count: number }>("select count(*)::int as count from app_private.auth_endpoint_attempts");
    expect(rows.rows[0].count).toBe(1);
  });

  it("rejects unknown actions and is callable only by the service role", async () => {
    await expect(attempt("password_login", null, "x@school.example")).rejects.toMatchObject({ code: "22023" });
    await expect(attempt("recovery_request", null, " ")).rejects.toMatchObject({ code: "22023" });
    for (const role of ["anon", "authenticated"] as const) {
      await expect(as(role, "select public.consume_auth_endpoint_attempt('recovery_request',null,'x@school.example')"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(as(role, "select count(*) from app_private.auth_endpoint_attempts")).rejects.toMatchObject({ code: "42501" });
    }
  });
});
