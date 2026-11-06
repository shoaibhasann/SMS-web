// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRecoveryDatabase } from "../scripts/database-recovery/replay.mjs";
import { seedRecoveryData } from "../scripts/database-recovery/synthetic-seed.mjs";
import {
  createSyntheticSnapshot, fingerprintRecoveryDatabase, restoreSyntheticSnapshot,
  validateDrillArguments, verifyRecoveredState, type RecoveryFingerprint, type SyntheticSnapshot,
} from "../scripts/database-recovery/drill.mjs";

const executeFile = promisify(execFile);
let source: PGlite;
let restored: PGlite;
let snapshot: SyntheticSnapshot;
let original: RecoveryFingerprint;

beforeAll(async () => {
  source = await createRecoveryDatabase();
  await seedRecoveryData(source);
  original = await fingerprintRecoveryDatabase(source);
  snapshot = await createSyntheticSnapshot(source);
  restored = await restoreSyntheticSnapshot(snapshot);
}, 60_000);
afterAll(async () => { await restored?.close(); await source?.close(); });

it.each([
  ["--db-url", "https://example.invalid"],
  ["--remote"],
  ["--output", "/"],
  ["--data-dir", "/tmp/existing"],
])("rejects target/output arguments before a database can open: %j", (...args) => {
  expect(() => validateDrillArguments(args)).toThrow("accepts no arguments");
});

it("the CLI never overwrites an existing requested output target or echoes its arguments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sms-recovery-guard-"));
  try {
    const marker = path.join(directory, "keep.txt");
    await writeFile(marker, "Existing data stays intact\n");
    let failed: unknown;
    try {
      await executeFile(process.execPath, [
        fileURLToPath(new URL("../scripts/database-recovery/drill.mjs", import.meta.url)),
        "--output", directory, "https://example.invalid/never-connect",
      ]);
    } catch (error) { failed = error; }
    expect(failed).toMatchObject({ code: 1 });
    const output = failed as { stdout: string; stderr: string };
    expect(output.stdout).toBe("");
    expect(output.stderr).not.toContain(directory);
    expect(output.stderr).not.toContain("example.invalid");
    expect(await readFile(marker, "utf8")).toBe("Existing data stays intact\n");
  } finally { await rm(directory, { recursive: true }); }
});

it("refuses arbitrary database clients without calling their query methods", async () => {
  const query = vi.fn();
  await expect(fingerprintRecoveryDatabase({ query } as unknown as PGlite)).rejects.toThrow("local PGlite");
  await expect(createSyntheticSnapshot({ query } as unknown as PGlite)).rejects.toThrow("local PGlite");
  expect(query).not.toHaveBeenCalled();
});

it("restores every application/contract table, schema privilege and API role without row loss", async () => {
  expect(Object.keys(original.tables).length).toBeGreaterThanOrEqual(108);
  expect(original.tables["public.schools"].count).toBe(2);
  expect(original.tables["auth.users"].count).toBe(7);
  expect(original.tables["public.student_parents"].count).toBe(1);
  expect(original.tables["public.fee_payments"].count).toBe(2);
  expect(await fingerprintRecoveryDatabase(restored)).toEqual(original);
});

it("retains cross-school/linked-child authorization, fees, notifications, mark CAS and activation after restore", async () => {
  const before = await verifyRecoveredState(source);
  const after = await verifyRecoveredState(restored);
  expect(after).toEqual(before);
  expect(after).toEqual(expect.arrayContaining([
    "two_school_admin_isolation", "curated_school_audit_scope_privacy_and_live_session", "student_and_linked_guardian_history",
    "family_ledger_and_receipt_integrity", "denied_unlinked_child_and_finance_writes",
    "linked_absence_alert_eligibility", "mark_rpc_and_stale_version_rejection",
    "student_leave_request_review_and_retry", "revoked_guardian_leave_denial",
    "timetable_retry_teacher_family_and_removal",
    "independent_result_publication_and_private_family_snapshot",
    "revoked_teacher_denial", "notice_cas_and_withdrawn_audience_privacy",
    "first_student_activation_preserves_existing_history",
  ]));
  expect(await fingerprintRecoveryDatabase(source)).toEqual(original);
  expect(await fingerprintRecoveryDatabase(restored)).toEqual(original);
}, 30_000);

it("rejects corrupt/truncated snapshot bytes and leaves the original database untouched", async () => {
  const bytes = new Uint8Array(await snapshot.blob.arrayBuffer());
  await expect(restoreSyntheticSnapshot({ ...snapshot, blob: new Blob([bytes.slice(0, -10)]) }))
    .rejects.toThrow("checksum mismatch");
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await expect(restoreSyntheticSnapshot({ ...snapshot, blob: new Blob([bytes]) }))
    .rejects.toThrow("checksum mismatch");
  expect(await fingerprintRecoveryDatabase(source)).toEqual(original);
});

it("rejects an unsupported snapshot envelope or a different embedded database version", async () => {
  await expect(restoreSyntheticSnapshot({ ...snapshot, format: "pg_dump" })).rejects.toThrow("Invalid synthetic");
  await expect(restoreSyntheticSnapshot({ ...snapshot, blob: new Blob() })).rejects.toThrow("Invalid synthetic");
  await expect(restoreSyntheticSnapshot({ ...snapshot, pgliteVersion: "0.0-not-the-current-package" }))
    .rejects.toThrow("exact PGlite package version");
  await expect(restoreSyntheticSnapshot({ ...snapshot, engineVersion: "0.0-not-the-current-engine" }))
    .rejects.toThrow("exact embedded PostgreSQL version");
  expect(await fingerprintRecoveryDatabase(source)).toEqual(original);
}, 15_000);

it("detects a restored permission regression instead of passing a row-count-only comparison", async () => {
  const unsafe = await restoreSyntheticSnapshot(snapshot);
  try {
    await unsafe.exec("alter table public.attendance disable row level security");
    const fingerprint = await fingerprintRecoveryDatabase(unsafe);
    expect(fingerprint.dataSha256).toBe(original.dataSha256);
    expect(fingerprint.schemaSha256).not.toBe(original.schemaSha256);
    await expect(verifyRecoveredState(unsafe)).rejects.toThrow();
    expect(await fingerprintRecoveryDatabase(source)).toEqual(original);
  } finally { await unsafe.close(); }
}, 15_000);
