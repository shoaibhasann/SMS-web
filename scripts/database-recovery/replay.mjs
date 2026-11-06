import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { captureCatalog, catalogFingerprint, compareCatalogFingerprints } from "./catalog.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestUrl = new URL("../../supabase/recovery/manifest.json", import.meta.url);
const kinds = new Set(["historical", "local-repair", "pending"]);
const tenantSeedVersions = new Set(["20261030094244", "20261030095353"]);
export const recoveryExtensions = Object.freeze({ pgcrypto, btree_gist });

/** Validate the reviewed plan before reading SQL or opening an application DB. */
export function validateRecoveryManifest(manifest) {
  if (manifest?.format !== "sms-recovery-plan/v1" || !Array.isArray(manifest.plan) || !manifest.plan.length) {
    throw new Error("A nonempty sms-recovery-plan/v1 manifest is required.");
  }
  const paths = new Set();
  let pendingStarted = false;
  for (const entry of manifest.plan) {
    if (!entry || !kinds.has(entry.kind) || typeof entry.path !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      || path.posix.normalize(entry.path) !== entry.path
      || entry.path.includes("\\")
      || !/^supabase\/(?:recovery\/(?:history|manual)|migrations)\/[^/]+\.sql$/.test(entry.path)) {
      throw new Error("Recovery entries require an allowed repository SQL path, kind and SHA-256.");
    }
    if (paths.has(entry.path)) throw new Error(`Duplicate recovery source: ${entry.path}.`);
    if (manifest.excluded?.some((excluded) => excluded.path === entry.path)) throw new Error("Excluded recovery sources cannot enter the replay plan.");
    if (tenantSeedVersions.has(entry.version) || tenantSeedVersions.has(path.posix.basename(entry.path).split("_")[0])) {
      throw new Error("Tenant-specific historical seeds cannot be replayed.");
    }
    if (pendingStarted && entry.kind !== "pending") throw new Error("Pending changes must follow the complete deployed checkpoint.");
    pendingStarted ||= entry.kind === "pending";
    paths.add(entry.path);
  }
  const order = manifest.plan.map(({ path: sourcePath, sha256, kind, version }) => ({ path: sourcePath, sha256, kind, version }));
  if (createHash("sha256").update(JSON.stringify(order)).digest("hex") !== manifest.order_sha256) {
    throw new Error("Recovery source order or membership differs from the reviewed manifest.");
  }
  if (manifest.platform_contract?.path !== "scripts/database-recovery/platform-contract.sql"
    || !/^[a-f0-9]{64}$/.test(manifest.platform_contract.sha256 ?? "")) {
    throw new Error("The reviewed local managed-service contract and SHA-256 are required.");
  }
  return manifest;
}

export async function readRecoveryManifest() {
  return validateRecoveryManifest(JSON.parse(await readFile(manifestUrl, "utf8")));
}

export async function readRecoverySources(manifest, { applyPending = true } = {}) {
  validateRecoveryManifest(manifest);
  await readPlatformContract(manifest);
  const sources = [];
  // Verify every planned source, even when inspecting only the deployed checkpoint.
  for (const entry of manifest.plan) {
    const bytes = await readRepositorySource(entry.path);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Recovery source hash mismatch: ${entry.path}.`);
    }
    if (applyPending || entry.kind !== "pending") sources.push({ ...entry, sql: bytes.toString("utf8") });
  }
  return sources;
}

async function readRepositorySource(relativePath) {
  const sourcePath = path.resolve(root, relativePath);
  if (await realpath(sourcePath) !== sourcePath) throw new Error("Recovery sources cannot resolve through filesystem symlinks.");
  return readFile(sourcePath);
}

async function readPlatformContract(manifest) {
  const bytes = await readRepositorySource(manifest.platform_contract.path);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.platform_contract.sha256) {
    throw new Error("Recovery platform-contract hash mismatch.");
  }
  return bytes.toString("utf8");
}

export async function verifyDeployedCheckpoint(db) {
  const expected = JSON.parse(await readFile(new URL("../../supabase/recovery/deployed-checkpoint.json", import.meta.url), "utf8")).fingerprint;
  const actual = catalogFingerprint(await captureCatalog(db));
  const difference = compareCatalogFingerprints(expected, actual);
  if (Object.values(difference).some((entries) => entries.length)) {
    throw new Error(`Recovery checkpoint differs from the reviewed deployed catalog: ${difference.added.length} added, ${difference.removed.length} removed, ${difference.changed.length} changed objects.`);
  }
  return actual;
}

async function replaySources(db, sources) {
  if (!(db instanceof PGlite)) throw new Error("Recovery replay accepts a local PGlite instance only.");
  const existing = await db.query(`select exists (
    select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','app_private') and c.relkind in ('r','p','v','m','S','f')
    union all
    select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace
    where n.nspname in ('public','app_private') and t.typtype in ('e','d')
    union all
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app_private') and not exists (
      select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass
        and d.objid=p.oid and d.deptype='e')
  ) as occupied`);
  if (existing.rows[0].occupied) throw new Error("Recovery replay requires an empty application schema; no existing data was changed.");
  const missingContract = await db.query(`select expected.schema,expected.name from (values
    ('auth','users'),('auth','sessions'),('auth','mfa_amr_claims'),
    ('storage','buckets'),('storage','objects')
  ) as expected(schema,name) left join pg_catalog.pg_namespace n on n.nspname=expected.schema
    left join pg_catalog.pg_class c on c.relnamespace=n.oid and c.relname=expected.name
    where c.oid is null or c.relkind not in ('r','p')`);
  if (missingContract.rows.length) throw new Error("Recovery requires the complete local managed-service table contract before replay; no source SQL was applied.");
  const managedTables = await db.query(`select pg_catalog.format('%I.%I',n.nspname,c.relname) as relation
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('auth','storage') and c.relkind in ('r','p') order by n.nspname,c.relname`);
  for (const { relation } of managedTables.rows) {
    const occupied = await db.query(`select exists(select 1 from ${relation} limit 1) as occupied`);
    if (occupied.rows[0].occupied) throw new Error("Recovery requires empty managed-service tables; no source SQL was applied.");
  }
  let checkpointVerified = false;
  for (const source of sources) {
    if (source.kind === "pending" && !checkpointVerified) {
      await verifyDeployedCheckpoint(db);
      checkpointVerified = true;
    }
    try {
      await db.exec(source.sql);
    } catch (error) {
      throw new Error(`Recovery step failed: ${source.path}: ${error.message}`);
    }
  }
  if (!checkpointVerified) await verifyDeployedCheckpoint(db);
  const rows = await db.query(`select
    (select count(*) from public.schools) as schools,
    (select count(*) from public.profiles) as profiles,
    (select count(*) from auth.users) as auth_users`);
  if (Object.values(rows.rows[0]).some((count) => Number(count) !== 0)) {
    throw new Error("Schema replay unexpectedly created tenant data; the synthetic seed must run only after all hardening.");
  }
  return sources.map(({ path: sourcePath, kind }) => ({ path: sourcePath, kind }));
}

export async function applyRecoveryPlan(db, { applyPending = true } = {}) {
  const sources = await readRecoverySources(await readRecoveryManifest(), { applyPending });
  return replaySources(db, sources);
}

export async function createRecoveryDatabase({ applyPending = true } = {}) {
  // Verify source integrity before allocating the managed-service test contract.
  const manifest = await readRecoveryManifest();
  const sources = await readRecoverySources(manifest, { applyPending });
  const platform = await readPlatformContract(manifest);
  const db = new PGlite({ extensions: recoveryExtensions });
  try {
    await db.exec(platform);
    await replaySources(db, sources);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--checkpoint") || args.length > 1) {
    console.error("Usage: node scripts/database-recovery/replay.mjs [--checkpoint]");
    process.exitCode = 1;
  } else {
    let db;
    try {
      db = await createRecoveryDatabase({ applyPending: !args.includes("--checkpoint") });
      const counts = await db.query(`select n.nspname as schema,
        count(*) filter(where c.relkind='r')::int as tables,
        count(*) filter(where c.relkind='v')::int as views
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app_private') group by n.nspname order by n.nspname`);
      console.log(JSON.stringify({ localOnly: true, checkpoint: args.includes("--checkpoint"), tenantRows: 0, schemas: counts.rows }, null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      await db?.close();
    }
  }
}
