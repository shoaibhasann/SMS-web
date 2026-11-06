import type { PGlite } from "@electric-sql/pglite";

export type CatalogFingerprint = {
  format: "sms-application-catalog-fingerprint/v1";
  entries: { key: string; sha256: string }[];
  sha256: string;
};
export function captureCatalog(db: PGlite): Promise<Record<string, unknown>>;
export function catalogFingerprint(catalog: unknown): CatalogFingerprint;
export function validateCatalogFingerprint(value: unknown): CatalogFingerprint;
export function compareCatalogFingerprints(expected: unknown, actual: unknown): {
  added: string[]; removed: string[]; changed: string[];
};
