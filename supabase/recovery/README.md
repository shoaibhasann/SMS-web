# Application database replay and recovery drill

This directory makes the application's database schema reproducible offline. **It is not a backup of the hosted project's school records, Auth accounts or uploaded files.** Nothing here resets, restores or deploys the current Supabase project or founder Preview.

## Reproduce the application schema

From the repository root:

```sh
npm run db:replay -- --checkpoint
npm run db:replay
npm run db:recovery:drill
```

The checkpoint command recreates the historical pre-hardening deployed schema for inspection. It intentionally stops before the twelve post-checkpoint patches; it must not be treated as a school-ready security release. The default replay and recovery drill apply the pending patches before any synthetic school data is inserted. The engine is an embedded local PGlite instance with no hosted connection or HTTP service.

`manifest.json` defines the reviewed order and SHA-256 of 70 historical/manual schema sources plus twelve post-checkpoint patches (security, academic integrity, student leave, timetable and assessment-result publication), for 82 ordered sources. Its platform-contract checksum and order digest are checked before replay. `history-provenance.json` records the recovered migration source. Reconstructed manual checkpoints are identified separately from original recorded SQL; tenant-specific historical seed statements are excluded rather than replayed into another school.

Default replay after all twelve post-checkpoint patches creates 103 application tables and five views. The current drill compares 108 application/contract tables and repeats fourteen behavior checks before and after restore. The original nine patches, two hosted-QA follow-ups and the subsequent school-audit projection are now applied; the rollout records ([6 November](hosted-rollout-2026-11-06.json), [12 November](hosted-rollout-2026-11-12.json)) map actual remote versions to source filenames and exact SQL hashes for the sources applied in those rollouts. The manifest kind `pending` means after the captured historical checkpoint; it does not override the ledger’s current deployment status.

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

Both Edge Functions authenticate callers themselves and must be redeployed with the gateway JWT precheck off. `supabase/config.toml` pins `verify_jwt = false` for both; also pass the explicit flag:

```sh
npx supabase functions deploy gate-attendance-events --project-ref YOUR_PROJECT_REF --no-verify-jwt
npx supabase functions deploy private-academic-file --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

After deploying, a credential-free POST to `gate-attendance-events` must return the handler's own 401 body and a GET must return 405; a bare gateway 401 means JWT verification was re-enabled and every gate device call is being rejected. Do not run `supabase config push` with that minimal file, because it would overwrite hosted Auth/MFA settings with defaults.

## Before a real recovery rehearsal

1. Record the approved source/target project identities, PostgreSQL/service versions, capture time, migration list and operator. Keep credentials and account/data dumps out of Git, screenshots and command logs. Preserve backups privately outside the build-scanned repository.
2. Verify current CLI commands with `--help`. CLI 3 targets the local stack by default; explicit `--remote` selects a hosted target. Do not run a credential-bearing `--dry-run` into shared logs. Do not reset the connected project's database password merely to run this offline drill. [CLI 3 target rules](https://supabase.com/changelog/supabase-cli-v3)
3. Export through the supported roles/schema/data workflow; verify Auth records, custom Auth/Storage hooks, migration history and required extensions are actually covered. Export Storage object bytes separately and retain byte hashes. Review the dump privately for secrets before any schema-only artifact is committed.
4. Restore to an approved isolated target with the matching platform dependencies, error-stop behavior and the documented transaction/trigger handling. Do not point a restore at the founder's current Preview project.
5. Compare row/business totals, school and child links, fee balances/receipts, permissions and actual attachment bytes. Test real Auth sign-in, role/guardian revocation, provider callbacks, mail delivery and private downloads against that restored target.
6. Record elapsed restore time and the backup's actual data-loss window. Founder and school management must approve retention and recovery objectives; no target numbers are assumed by this drill. Accept recovery only when the restored URL/revision/migrations and observed results are recorded.

Creating paid targets, enabling PITR, changing retention, rotating credentials, restoring hosted projects and cutting over application traffic are separate actions. None are performed by these local commands.

## Hosted rollout and privately verified application backup — 6 November 2026

The hosted project now has the twelve recorded patches in `hosted-rollout-2026-11-06.json`; do not blindly reapply local timestamped files with `db push`. MCP allocated different remote timestamps, and the ledger retains both versions plus identical recorded/source SHA256 values. The captured670-object checkpoint remains historical and intentionally gates the replay immediately before these patches. Default replay includes all82 reviewed sources and creates103 tables/five views.

Before rollout, all99 live application tables (2,401 rows) plus projected managed reference fields were captured in one read snapshot, with catalog and exact replay sources retained privately outside Git/build directories. A fresh embedded database matched the live670-object catalog and restored every original raw PostgreSQL JSON row byte-for-byte as a duplicate-preserving UTF8-sorted multiset; numeric precision and values were not reformatted. The initial comparison difference was row ordering/collation only. Hosted postflight confirms every original row remains, except the intentional added notice version field; later manual demo additions were preserved.

This is verified recovery of actual application records under the managed-service contract. It is not a native full-project dump or a proof of restored Auth credentials, active sessions, provider secrets or Storage file bytes. Those production disaster-recovery gates remain open; the current project’s dashboard reports no managed backups. No restore/reset was run against the hosted project.

## Hosted rollout — 12 November 2026

The 42 forward sources added by the 11 November audit fix branch (`20261111180100` to `20261111231700`) are applied to the hosted project. Each file was sent whole as one statement through the Supabase CLI (`db query`, Management API) and recorded with a server-allocated ledger version. `hosted-rollout-2026-11-12.json` keeps both versions and the identical recorded/source SHA256 values; do not reapply these files with `db push`.

The hosted catalog of `public` and `app_private` (function bodies and grants, columns, policies, triggers, indexes, constraints; plus Storage policies, bucket settings and triggers on Storage tables) was captured before the first file and after the last one, and each capture was compared with the local replay at the same point. Nothing was left unexplained; the first capture missed default privileges, which matched in the later captures. The explained differences are CRLF line endings in two older function bodies, range-type constructors owned by `supabase_admin`, Storage's own triggers, the default privileges of platform schemas, and the NOT NULL constraint rows that only the local engine lists. All 41 post-checks returned what the local rehearsal returned.

Two network errors stopped the run and were resolved from evidence before continuing: one ledger insert after its file had been applied, and one migration call whose file turned out not to be committed. From the second run on, ledger reads and the guarded ledger insert were retried automatically; the migration call never was. The log shows one successful migration call per file, and the record lists both stops under `incidents`.

No backup was taken: the project is on the free plan, which has no managed backups. The 42 sources change schema only; their one row change is a one-off delete of push dispatch batch rows that had expired more than a day earlier. The two earlier sources whose hosted status was unconfirmed (`admin_email_otp_eligibility`, `school_admin_single_factor_dashboard`) were found in the hosted ledger with exact SQL.

One follow-up fix was applied the same day and is the last row of the record. After `20261111200300`, every once-a-minute push claim was cancelled by the statement timeout: the due-today fee scan ran the ledger check for every fee due that day (2,006) before filtering by device. No push was dispatched from 16:45 to 17:23 IST; no job was waiting in that window. `20261112120000_fee_due_push_scan_devices_first` runs the device filter first. That scan still made one ledger check per waiting device-linked fee; the second follow-up below bounds it.

Two more follow-ups were applied the same evening. `20261112130000_office_fee_positions_custom_plan` plans the fee-positions statement with each call's own values: Postgres 17 plans a non-inlined SQL function without its parameter values, and for the largest school (4,003 demands) that generic plan re-ran the payment aggregates once per demand. The finance summary's ledger part went from 3.6 s to about 0.1 s and a 50-row ledger page from 2.7 s to 0.26 s. `20261112130100_fee_due_push_scan_bound` checks a random sample of at most 40 fees per scan (a claim re-checks up to 20 more, so at most 60 ledger checks against the dispatcher's 2-second limit), lets a scan run 50 seconds after the previous one, and indexes guardians by sign-in and links by guardian. After both, the hosted catalog again matched the local replay with nothing unexplained.

A third follow-up, `20261112140000_staff_policy_initplans`, rewrote 23 staff row-level-security policies on students, enrollments, attendance, student_fees, fee_payments, class_logs and class_activities so the caller's roles are checked once per statement instead of once per row. Measured on hosted as a caller with no access, students went from 2.7 s to 18 ms, enrollments from 3.7 s to 11 ms and one attendance day from 4.9 s to 9 ms. `tests/database/staff-policy-initplans.test.ts` shows that, for 17 caller types and every row, the new expressions admit exactly what the previous ones admitted. The hosted catalog again matched the local replay with nothing unexplained.
