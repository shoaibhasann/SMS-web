import type { PGlite } from "@electric-sql/pglite";
import type { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { CatalogFingerprint } from "./catalog.mjs";

export type RecoveryEntry = {
  path: string;
  sha256: string;
  kind: "historical" | "local-repair" | "pending";
  version?: string | null;
  name?: string;
  provenance?: unknown;
};
export type RecoveryManifest = {
  format: "sms-recovery-plan/v1";
  plan: RecoveryEntry[];
  excluded?: { path: string }[];
  order_sha256: string;
  platform_contract: { path: "scripts/database-recovery/platform-contract.sql"; sha256: string };
};
export const recoveryExtensions: Readonly<{ pgcrypto: typeof pgcrypto; btree_gist: typeof btree_gist }>;
export function validateRecoveryManifest(manifest: unknown): RecoveryManifest;
export function readRecoveryManifest(): Promise<RecoveryManifest>;
export function readRecoverySources(manifest: RecoveryManifest, options?: { applyPending?: boolean }): Promise<(RecoveryEntry & { sql: string })[]>;
export function applyRecoveryPlan(db: PGlite, options?: { applyPending?: boolean }): Promise<{ path: string; kind: RecoveryEntry["kind"] }[]>;
export function createRecoveryDatabase(options?: { applyPending?: boolean }): Promise<PGlite>;
export function verifyDeployedCheckpoint(db: PGlite): Promise<CatalogFingerprint>;
