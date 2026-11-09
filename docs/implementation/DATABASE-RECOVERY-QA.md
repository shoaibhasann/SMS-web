# Application schema replay and recovery QA

6 November 2026 · 12-patch hosted rollout and application-row restore verified; native Supabase/Auth/Storage recovery acceptance pending.

The original phase added an executable recovery plan and an offline synthetic restore drill. Its historical checks remain below; the later 99-table / 2,401-row private application snapshot and embedded restore are verified separately here. Production code `2dfb1e26` is Ready at [the stable login](https://sms-web-shoaibhasann.vercel.app/login), deployment `dpl_Hn7b55aj4ThnjDC1tykBJAGxHP1J`. This does not certify native Auth/Storage/provider recovery. There is no separate founder-facing recovery screen. [Commands, source provenance and full recovery boundaries](../../supabase/recovery/README.md).

## What can be reproduced

- A read-only capture recovered 66 recorded migration entries.23 missing historical SQL files are preserved verbatim;21 are schema/global setup, while two fixed-school seed scripts are archived and explicitly excluded from fresh replay.
- The obsolete local academic draft references nonexistent `teachers.user_id`. A separately identified snapshot-derived checkpoint replaces it in the replay plan. Another snapshot-derived checkpoint recovers the missing department tables/helpers/policies/triggers. The original files and provenance remain available; reconstructed SQL is not labelled original recorded history.
- The ordered manifest has 70 historical/manual sources followed by twelve post-checkpoint security/integrity/student-leave/timetable/result-publication patches (82 sources total). Every source, platform contract and order digest is verified before execution. The default command uses a fresh embedded database and inserts no tenant data before hardening.
- Before the twelve post-checkpoint patches, all 670 application catalog objects match the captured historical pre-hardening checkpoint (not today's deployed schema):99 tables,3 views,304 functions,185 policies and 61 custom triggers. This compares definitions, constraints, RLS, grants, indexes and app-owned Auth/Storage hooks, not only object counts. PG 18's separate NOT NULL catalog entries are normalized against the preserved column flags; the hosted source was PG 17.11.
- The drill seeds two synthetic schools and seven non-login Auth-contract identities after hardening, snapshots the engine in memory and restores it into a second fresh engine. It compares schema, API-role flags and full canonical row hashes/counts for 108 application/contract tables. Attendance, fees/receipts, guardian links/alerts, activation, mark conflicts, revoked-teacher denial and notice privacy checks run before and after restore. Student leave request/review/retry, revoked-guardian checks, timetable create/retry/read/removal and independent assessment-result publication are also included. Default replay creates 103 application tables/five views after the pending chain. Verification mutations roll back.

## Run locally

Use the repository root with installed dependencies:

```sh
npm run db:replay -- --checkpoint
npm run db:replay
npm run db:recovery:drill
```

Checkpoint mode stops at the historical pre-hardening schema before the twelve post-checkpoint patches and is inspection-only. Default replay includes all twelve, even though they are now applied on the hosted project. The drill accepts no target, URL, output directory or other arguments; it does not load environment credentials or connect to Supabase. Reports contain hashes/counts and scope limits, not raw pupil/account rows. An actual backup must be kept privately outside the repository using the supported platform workflow.

## Next acceptance checklist

Engineering owns REC-01 through REC-05. Founder/school management owns operational decisions and final restored-product acceptance. Leave each manual case pending until its actual operator, date and evidence are recorded.

- [ ] **REC-01 · Source and provenance.** Review the source project, PostgreSQL version, UTC capture time,66-entry recorded ledger and artifact hashes. Identify the two excluded school seeds, obsolete draft and reconstructed checkpoints. Confirm no account/data export or private credentials entered Git.
- [ ] **REC-02 · Historical application checkpoint.** Run checkpoint replay. Expect the preserved pre-hardening 99 tables/3 views and zero tenant/Auth/profile rows. The 670-object fingerprint gate must pass. Notice-version and mark-save RPC changes are deliberately absent from this historical mode, even though all twelve later patches are now hosted. This command is not a snapshot of the current deployed schema or a security-ready deployment.
- [ ] **REC-03 · Complete chain and restore.** Run default replay and the drill. Expect all twelve post-checkpoint patches (82 total sources), 103 application tables/five views, a successful fresh-engine restore, identical schema/API-role/data fingerprints and all fourteen permission/history checks before and after. Compare hashes within that run; generated IDs/timestamps mean independent runs need not share a data hash.
- [ ] **REC-04 · Failure guards.** Run the automated tests for altered source/order/platform hashes, unsupported targets, occupied application or managed-data targets, corrupt snapshot checksums/version envelopes and restored RLS regression. Rejection must happen before modifying an occupied target. No command may accept a hosted URL or a destructive reset option.
- [ ] **REC-05 · Restored workflow checks.** Review same-school versus foreign-school Admin reads, Student/Guardian own/linked attendance and receipts, unlinked-child/finance denials, absence-alert eligibility, stale mark/notice saves, revoked Teacher access and first student activation with preserved history. Include student leave, timetable and independently published own-pupil results. Confirm checks leave the restored row/schema fingerprints unchanged.
- [ ] **REC-06 · Real backup ownership.** Assign the backup operator, approved private/off-site location, encryption/access and retention. Founder and school management define acceptable data-loss window and recovery time. Do not infer those targets or assume the platform plan already provides them.
- [ ] **REC-07 · Real Supabase rehearsal.** With an approved isolated target and private database export, restore actual roles/schema/data/history and managed customizations; configure service settings separately. Verify real Auth sign-in, callback/mail/provider behavior, school/guardian links, financial balances and private downloads. Transfer actual Storage objects separately and compare attachment byte hashes. Record target URL/revision/migrations, elapsed time and observed data-loss window. The embedded drill cannot mark this case Pass.
- [ ] **REC-08 · Founder acceptance.** Test the actual restored isolated product using [the current Production checklist](PRODUCTION-RELEASE-QA.md), [security cases](ACCESS-SECURITY-QA.md) and [academic integrity cases](ACADEMIC-INTEGRITY-QA.md). Use a separate restored-target URL/revision and results; do not overwrite the live Production release record or assume a current Production pass certifies recovery.

## Verification boundary

The local engine is PGlite 0.5.14/PostgreSQL 18.6 with an explicit synthetic managed-service contract. Six small Auth/Storage helper definitions were checked against the current provider; that does not implement the Auth/Storage services. In-memory physical snapshots require the exact embedded package/engine version. They are neither portable `pg_dump` files nor retained off-site backups.

Real account credentials/sessions, provider secrets, SMTP, keys, Edge Function deployment, production load/concurrent connections and actual object-byte restoration are not verified here. Database backups do not include uploaded Storage bytes; real recovery must follow the separate database/object/configuration workflow. [Supabase backup guidance](https://supabase.com/docs/guides/platform/backups), [backup and restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

| Evidence | Status |
|---|---|
| Recovered history/manual checkpoint parity | Local pass |
| Historical pre-hardening application catalog | 670 objects matched exactly before the twelve post-checkpoint patches; today's hosted source/history is recorded separately. |
| Offline replay and synthetic restore | Local pass for the current twelve-patch chain; see [the implementation log](PHASES.md) for final regression totals. Both replay modes and the fourteen-check drill pass. Earlier checkpoints were 1290 tests for timetable and 1051 tests for recovery-only work; the pre-hardening fingerprint remains the historical replay gate, while today's 11-patch hosted state is tracked separately. |
| Private actual application-row snapshot / embedded restore | Verified for 99 application tables / 2,401 rows and the pre-rollout catalog; raw row-byte comparison, private artifacts outside Git. |
| Native Supabase/Auth/Storage/provider restore | Pending; no hosted reset/restore was performed. |
| Founder restored-target acceptance | Pending |

## Later hosted rollout evidence — 6 November 2026

Eleven patches (nine requested +two hosted-QA fixes) are applied with [exact source/history hashes](../../supabase/recovery/hosted-rollout-2026-11-06.json). Before applying, all 99 actual application tables / 2,401 rows and the exact catalog/replay sources were saved privately; fresh embedded restore verifies the670-object catalog and every raw row byte, with only row ordering canonicalized. Hosted postflight preserved all original records plus later concurrent manual additions. This closes an application-row recovery rehearsal, not REC-07’s native Supabase/Auth/Storage/provider or file-byte recovery. No hosted reset/restore occurred. The historical checkpoint still represents the pre-hardening schema; the operational ledger records today’s live state.

## School audit history follow-up — 6 November 2026

The twelfth post-checkpoint migration adds only checked audit-history functions and legacy-read privilege hardening. A new private pre-change snapshot covers all 103 application tables / 2,462 actual rows. Fresh embedded restoration reproduces every raw row byte and the exact catalog, including five captured managed range-constructor owner/ACL records restored locally. Immediate hosted post-DDL comparison finds zero changed application tables. The restore drill now adds an audit permission/projection check (14 behavior checks total), with 82 reviewed sources. [Audit and account acceptance](AUDIT-ACCOUNT-QA.md). Native Auth/Storage/provider recovery remains unverified.
