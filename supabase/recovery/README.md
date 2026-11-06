# Application database replay and recovery drill

This directory makes the application's database schema reproducible offline. **It is not a backup of the hosted project's school records, Auth accounts or uploaded files.** Nothing here resets, restores or deploys the current Supabase project or founder Preview.

## Reproduce the application schema

From the repository root:

```sh
npm run db:replay -- --checkpoint
npm run db:replay
npm run db:recovery:drill
```

The checkpoint command recreates the historical pre-hardening deployed schema for inspection. It intentionally stops before the eleven post-checkpoint patches; it must not be treated as a school-ready security release. The default replay and recovery drill apply the pending patches before any synthetic school data is inserted. The engine is an embedded local PGlite instance with no hosted connection or HTTP service.

`manifest.json` defines the reviewed order and SHA-256 of 70 historical/manual schema sources plus eleven post-checkpoint patches (security, academic integrity, student leave, timetable and assessment-result publication), for 81 ordered sources. Its platform-contract checksum and order digest are checked before replay. `history-provenance.json` records the recovered migration source. Reconstructed manual checkpoints are identified separately from original recorded SQL; tenant-specific historical seed statements are excluded rather than replayed into another school.

Default replay after all eleven post-checkpoint patches creates 103 application tables and five views. The current drill compares 108 application/contract tables and repeats thirteen behavior checks before and after restore. The original nine patches plus two hosted-QA follow-ups are now applied; [the operational ledger](hosted-rollout-2026-11-06.json) maps actual remote versions to source filenames and exact SQL hashes. The manifest kind `pending` means after the captured historical checkpoint; it does not override the ledger’s current deployment status.

Before the first pending patch, replay compares its application catalog against [the captured deployed checkpoint](deployed-checkpoint.json): 99 tables, three views, 304 routines, 185 policies and 61 triggers, represented by 670 object fingerprints. Unexplained differences stop replay before seeding. The source is read-only PostgreSQL 17.11 metadata captured at `2026-11-05T19:41:23Z`; the fingerprint comparison normalizes line endings and PostgreSQL 18's separate NOT NULL catalog representation. Managed Auth/Storage implementations and extensions remain the explicit platform-contract boundary, not hidden omissions from a full-service restore claim.

Historical migration files remain evidence and are not a new monolithic hosted migration. Do not run every recovered file against the existing project or mark its history applied without reconciling the actual schema first.

The legacy `supabase/migrations` folder alone is still an incremental archive, not a fresh Supabase `db reset` baseline. The supported fresh application replay in this phase is the explicit, verified manifest command above. A native Supabase provisioning/restore workflow remains separate acceptance work.

## What the drill verifies

The drill accepts **no arguments, database URL, project reference or output target**, reads no environment credentials and never imports the application's Supabase client. It creates new embedded databases only. The synthetic dataset contains two schools and seven non-login Auth-contract identities using `recovery.invalid` addresses; there are no passwords or carrier/email calls.

It replays the application schema, applies the pending hardening, seeds the synthetic records, captures application-schema/API-role/data fingerprints, exports an in-memory embedded-database snapshot, and restores it into a second fresh engine. It compares every table's full canonical row hash and count in `public`, `app_private`, and the synthetic `auth`/`storage` contracts. Application constraints, functions, policies, triggers, grants and API role flags are also checked. The result prints hashes/counts and explicit scope limits, never raw account or pupil records.

Before and after restore, it checks:

- School administrators cannot read the other school's pupil.
- Student and guardian reads contain only the owned/linked child's attendance, receipt and reconciled fee balance; unlinked-child reads and finance mutations are denied.
- The eligible guardian retains the absent-child notification.
- Student leave submission/review/retry and revoked-guardian denial remain correct.
- Timetable create/retry, teacher/family reads and removal preserve their permissions.
- Assessment results require independent reviewed publication; family reads contain only the published pupil snapshot.
- The per-pupil mark RPC works while stale versions and revoked-teacher access fail.
- A stale notice edit cannot undo withdrawal or widen its audience.
- A fresh confirmed synthetic account can activate the unlinked pupil and read its existing history.

Verification mutations run inside rolled-back transactions. The source and restored data fingerprints must remain unchanged afterward. Corrupted snapshot checksums, unsupported snapshot envelopes, version mismatches and arbitrary external database clients fail. The test suite also disables RLS on an isolated restored copy to prove that unchanged row counts alone cannot pass recovery acceptance.

Snapshots stay in memory and are tied to the **exact PGlite/PostgreSQL version**. They are not portable `pg_dump` files and are not retained as an off-site backup. Root implementation/QA logs record actual commands, test counts, hashes and remaining acceptance work.

## What this does not recover

`platform-contract.sql` supplies only the Auth and Storage table/function surface needed to execute the application's SQL offline. It is explicitly a test contract, not the Supabase Auth service, its password/session lifecycle, provider configuration, Storage service or object bytes. The metadata checkpoint includes application-owned hooks/policies, not a replacement for Supabase-managed schemas and services.

Real recovery requires a separate authorized database export and isolated restore. Supabase's current guide separates roles, schema, data, migration history and managed-schema customizations; it also describes separate Storage transfers. Vault/pgsodium-encrypted data can require the original encryption root key, which is not contained in logical backup files. Do not copy or overwrite project encryption keys without verifying the target and need. [Supabase backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)

Database backups contain Storage metadata, **not uploaded object bytes**. Backups/retention must be verified for the actual plan; free-tier projects should arrange their own exports and off-site copies rather than assume managed daily backups are available. A schema JSON file is neither type of data backup. [Supabase database backups](https://supabase.com/docs/guides/platform/backups)

Auth providers, SMTP, API/JWT keys, Edge Functions, domains and other service configuration require their own recovery steps. Restoring a database does not prove that users can sign in or that confirmation emails, signed downloads and attachment bytes work. [Supabase platform restore](https://supabase.com/docs/guides/self-hosting/restore-from-platform)

## Before a real recovery rehearsal

1. Record the approved source/target project identities, PostgreSQL/service versions, capture time, migration list and operator. Keep credentials and account/data dumps out of Git, screenshots and command logs. Preserve backups privately outside the build-scanned repository.
2. Verify current CLI commands with `--help`. CLI 3 targets the local stack by default; explicit `--remote` selects a hosted target. Do not run a credential-bearing `--dry-run` into shared logs. Do not reset the connected project's database password merely to run this offline drill. [CLI 3 target rules](https://supabase.com/changelog/supabase-cli-v3)
3. Export through the supported roles/schema/data workflow; verify Auth records, custom Auth/Storage hooks, migration history and required extensions are actually covered. Export Storage object bytes separately and retain byte hashes. Review the dump privately for secrets before any schema-only artifact is committed.
4. Restore to an approved isolated target with the matching platform dependencies, error-stop behavior and the documented transaction/trigger handling. Do not point a restore at the founder's current Preview project.
5. Compare row/business totals, school and child links, fee balances/receipts, permissions and actual attachment bytes. Test real Auth sign-in, role/guardian revocation, provider callbacks, mail delivery and private downloads against that restored target.
6. Record elapsed restore time and the backup's actual data-loss window. Founder and school management must approve retention and recovery objectives; no target numbers are assumed by this drill. Accept recovery only when the restored URL/revision/migrations and observed results are recorded.

Creating paid targets, enabling PITR, changing retention, rotating credentials, restoring hosted projects and cutting over application traffic are separate actions. None are performed by these local commands.

## Hosted rollout and privately verified application backup — 6 November 2026

The hosted project now has the eleven recorded patches in `hosted-rollout-2026-11-06.json`; do not blindly reapply local timestamped files with `db push`. MCP allocated different remote timestamps, and the ledger retains both versions plus identical recorded/source SHA256 values. The captured670-object checkpoint remains historical and intentionally gates the replay immediately before these patches. Default replay includes all81 reviewed sources and creates103 tables/five views.

Before rollout, all99 live application tables (2,401 rows) plus projected managed reference fields were captured in one read snapshot, with catalog and exact replay sources retained privately outside Git/build directories. A fresh embedded database matched the live670-object catalog and restored every original raw PostgreSQL JSON row byte-for-byte as a duplicate-preserving UTF8-sorted multiset; numeric precision and values were not reformatted. The initial comparison difference was row ordering/collation only. Hosted postflight confirms every original row remains, except the intentional added notice version field; later manual demo additions were preserved.

This is verified recovery of actual application records under the managed-service contract. It is not a native full-project dump or a proof of restored Auth credentials, active sessions, provider secrets or Storage file bytes. Those production disaster-recovery gates remain open; the current project’s dashboard reports no managed backups. No restore/reset was run against the hosted project.
