import type { PGlite } from "@electric-sql/pglite";

export type RecoveryFingerprint = {
  schemaSha256: string;
  apiRolesSha256: string;
  dataSha256: string;
  tables: Record<string, { count: number; sha256: string }>;
};
export type SyntheticSnapshot = {
  format: string;
  pgliteVersion: string;
  engineVersion: string;
  sha256: string;
  blob: Blob;
};
export type RecoveryReport = RecoveryFingerprint & {
  passed: true;
  kind: string;
  engineVersion: string;
  pgliteVersion: string;
  format: string;
  snapshotSha256: string;
  snapshotBytes: number;
  restoredChecks: string[];
  elapsedMs: number;
  limits: {
    syntheticAuthAndStorageContracts: true;
    hostedDatabaseAccess: false;
    realAuthLoginTested: false;
    storageObjectBytesRestored: false;
    portablePgDumpRestoreTested: false;
    concurrentConnectionsTested: false;
  };
};
export function validateDrillArguments(args: unknown): void;
export function fingerprintRecoveryDatabase(db: PGlite): Promise<RecoveryFingerprint>;
export function createSyntheticSnapshot(db: PGlite): Promise<SyntheticSnapshot>;
export function restoreSyntheticSnapshot(snapshot: unknown): Promise<PGlite>;
export function verifyRecoveredState(db: PGlite): Promise<string[]>;
export function runRecoveryDrill(args?: string[]): Promise<RecoveryReport>;
