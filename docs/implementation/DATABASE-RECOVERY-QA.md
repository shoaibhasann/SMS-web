# Application schema replay and recovery QA

6 November 2026 · Local engineering evidence; real Supabase recovery acceptance pending.

The original phase added an executable recovery plan and an offline synthetic restore drill. Its historical checks remain below; the later hosted rollout and real application-row snapshot are recorded separately here. There is no new founder-facing screen in this phase. [Commands, source provenance and full recovery boundaries](../../supabase/recovery/README.md).

## What can be reproduced

- A read-only capture recovered 66 recorded migration entries.23 missing historical SQL files are preserved verbatim;21 are schema/global setup, while two fixed-school seed scripts are archived and explicitly excluded from fresh replay.
- The obsolete local academic draft references nonexistent `teachers.user_id`. A separately identified snapshot-derived checkpoint replaces it in the replay plan. Another snapshot-derived checkpoint recovers the missing department tables/helpers/policies/triggers. The original files and provenance remain available; reconstructed SQL is not labelled original recorded history.
- The ordered manifest has 70 historical/manual sources followed by eleven post-checkpoint security/integrity/student-leave/timetable/result-publication patches (81 sources total). Every source, platform contract and order digest is verified before execution. The default command uses a fresh embedded database and inserts no tenant data before hardening.
- Before pending patches, all 670 application catalog objects match the captured hosted checkpoint:99 tables,3 views,304 functions,185 policies and 61 custom triggers. This compares definitions, constraints, RLS, grants, indexes and app-owned Auth/Storage hooks, not only object counts. PG 18's separate NOT NULL catalog entries are normalized against the preserved column flags; the hosted source was PG 17.11.
- The drill seeds two synthetic schools and seven non-login Auth-contract identities after hardening, snapshots the engine in memory and restores it into a second fresh engine. It compares schema, API-role flags and full canonical row hashes/counts for 108 application/contract tables. Attendance, fees/receipts, guardian links/alerts, activation, mark conflicts, revoked-teacher denial and notice privacy checks run before and after restore. Student leave request/review/retry, revoked-guardian checks, timetable create/retry/read/removal and independent assessment-result publication are also included. Default replay creates 103 application tables/five views after the pending chain. Verification mutations roll back.

## Run locally

Use the repository root with installed dependencies:

```sh
npm run db:replay -- --checkpoint
npm run db:replay
npm run db:recovery:drill
```

Checkpoint mode stops before the pending security patches and is inspection-only. Default replay includes all pending patches. The drill accepts no target, URL, output directory or other arguments; it does not load environment credentials or connect to Supabase. Reports contain hashes/counts and scope limits, not raw pupil/account rows. An actual backup must be kept privately outside the repository using the supported platform workflow.

## Next acceptance checklist

Engineering owns REC-01 through REC-05. Founder/school management owns operational decisions and final restored-product acceptance. Leave each manual case pending until its actual operator, date and evidence are recorded.

- [ ] **REC-01 · Source and provenance.** Review the source project, PostgreSQL version, UTC capture time,66-entry recorded ledger and artifact hashes. Identify the two excluded school seeds, obsolete draft and reconstructed checkpoints. Confirm no account/data export or private credentials entered Git.
- [ ] **REC-02 · Fresh application checkpoint.** Run checkpoint replay. Expect 99 tables/3 views and zero tenant/Auth/profile rows. The 670-object fingerprint gate must pass. It must not contain notice-version or mark-save RPC changes that are still pending remotely. This command does not certify a security-ready deployment.
- [ ] **REC-03 · Pending chain and restore.** Run default replay and the drill. Expect all nine pending patches, a successful fresh-engine restore, identical schema/API-role/data fingerprints and all thirteen permission/history checks before and after. Compare hashes within that run; generated IDs/timestamps mean independent runs need not share a data hash.
- [ ] **REC-04 · Failure guards.** Run the automated tests for altered source/order/platform hashes, unsupported targets, occupied application or managed-data targets, corrupt snapshot checksums/version envelopes and restored RLS regression. Rejection must happen before modifying an occupied target. No command may accept a hosted URL or a destructive reset option.
- [ ] **REC-05 · Restored workflow checks.** Review same-school versus foreign-school Admin reads, Student/Guardian own/linked attendance and receipts, unlinked-child/finance denials, absence-alert eligibility, stale mark/notice saves, revoked Teacher access and first student activation with preserved history. Include student leave, timetable and independently published own-pupil results. Confirm checks leave the restored row/schema fingerprints unchanged.
- [ ] **REC-06 · Real backup ownership.** Assign the backup operator, approved private/off-site location, encryption/access and retention. Founder and school management define acceptable data-loss window and recovery time. Do not infer those targets or assume the platform plan already provides them.
- [ ] **REC-07 · Real Supabase rehearsal.** With an approved isolated target and private database export, restore actual roles/schema/data/history and managed customizations; configure service settings separately. Verify real Auth sign-in, callback/mail/provider behavior, school/guardian links, financial balances and private downloads. Transfer actual Storage objects separately and compare attachment byte hashes. Record target URL/revision/migrations, elapsed time and observed data-loss window. The embedded drill cannot mark this case Pass.
- [ ] **REC-08 · Founder acceptance.** Test the restored isolated product using [the feature checklist](FOUNDER-RELEASE-QA.md), [pending security cases](ACCESS-SECURITY-QA.md) and [academic integrity cases](ACADEMIC-INTEGRITY-QA.md). Sign off only on the actual restored target and observed results; do not overwrite the current Preview's release record.

## Verification boundary

The local engine is PGlite 0.5.14/PostgreSQL 18.6 with an explicit synthetic managed-service contract. Six small Auth/Storage helper definitions were checked against the current provider; that does not implement the Auth/Storage services. In-memory physical snapshots require the exact embedded package/engine version. They are neither portable `pg_dump` files nor retained off-site backups.

Real account credentials/sessions, provider secrets, SMTP, keys, Edge Function deployment, production load/concurrent connections and actual object-byte restoration are not verified here. Database backups do not include uploaded Storage bytes; real recovery must follow the separate database/object/configuration workflow. [Supabase backup guidance](https://supabase.com/docs/guides/platform/backups), [backup and restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

| Evidence | Status |
|---|---|
| Recovered history/manual checkpoint parity | Local pass |
| Current deployed application catalog |670 objects matched exactly before pending patches |
| Offline replay and synthetic restore | Local pass for the current eleven-patch chain; see [the implementation log](PHASES.md) for final regression totals. Both replay modes and the thirteen-check drill pass. Earlier checkpoints were 1290 tests for timetable and 1051 tests for recovery-only work; the later result-publication slice extends the pending chain without changing the deployed fingerprint. |
| Hosted schema/data backup and real Auth/Storage restore | Pending |
| Founder restored-target acceptance | Pending |

## Later hosted rollout evidence — 6 November 2026

Eleven patches (nine requested +two hosted-QA fixes) are applied with [exact source/history hashes](../../supabase/recovery/hosted-rollout-2026-11-06.json). Before applying, all99actualapplicationtables/2,401rows and the exact catalog/replay sources were saved privately; fresh embedded restore verifies the670-object catalog and every raw row byte, with only row ordering canonicalized. Hosted postflight preserved all original records plus later concurrent manual additions. This closes an application-row recovery rehearsal, not REC-07’s native Supabase/Auth/Storage/provider or file-byte recovery. No hosted reset/restore occurred. The historical checkpoint still represents the pre-hardening schema; the operational ledger records today’s live state.
