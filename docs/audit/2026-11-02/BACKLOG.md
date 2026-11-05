# Engineering backlog after the audit

2 November 2026. This is a proposed work queue, not completed implementation. Parent findings and scope: [REPORT.md](REPORT.md). Start with a reproducible seeded database; do not apply policy changes blindly to the existing remote project.

| Order | Work item | Acceptance criteria |
|---|---|---|
| 1 | Recover baseline and establish Git | Base tables, enums, indexes, all RLS/grants/triggers/storage rules and activation/registration RPCs are versioned. A clean DB migration and synthetic seed work without SQL-console manual steps. No secrets in history. |
| 2 | Fix toolchain and document setup | Clean locked install, typecheck, working ESLint command and supported production build pass in CI. README documents local DB/env names, test accounts, deployment and rollback. Treat current Turbopack environment failure separately from source bugs. |
| 3 | Define one verified school context | Platform operator and school roles are separate. Multi-role membership resolves within selected school. Every role switch/context change clears stale data. Cross-school and cross-family direct API attempts fail. |
| 4 | Remove teacher self-granting authority | Admin approves class/subject/class-teacher scope. A teacher cannot gain new scope by editing own assignment row. DB enforces school/year/class/section/subject consistency. Revocation takes effect without trusting a hidden menu. |
| 5 | Fix attendance state and corrections | Persisted date/section register loads before editing; unmarked remains explicit. Reload/save preserves absent/leave/half-day. Date/section switch clears and reloads correct state. Stale/concurrent saves are rejected or resolved visibly. Correct guardian/principal read routes exist. |
| 6 | Replace finance posting model | Existing demand receives multiple allocations. Payment, allocation, receipt and business audit commit atomically. Positive decimal-safe amounts and unique request IDs are server-enforced. Failure/retry/concurrent cashier requests cannot duplicate receipt or debt. |
| 7 | Make academic save atomic | Log and activities change in one transaction with a version/conflict check. A failed replacement preserves previous work. Publication exposes a complete snapshot. Concurrent edits do not silently delete each other. |
| 8 | Protect results invariants | Explicit marks states and clear/delete intent work. Editing score preserves unchanged remarks. Once marks exist, changing assessment scope is rejected in DB. Maximum-mark and entry operations serialize safely. Every correction records actor/reason. |
| 9 | Replace demo people/enrollment masters | Durable student/staff/guardian records and approved relationships feed all roles. Admission converts once into real enrollment. Two browsers see the same authorized data. Invite/revoke/deactivate flows are verified. |
| 10 | Replace demo academic setup | One canonical route and service configures year/term/calendar/class/section/subject. Year rollover retains history and creates valid new enrollments/assignments. No global uniqueness constraint blocks next year. |
| 11 | Import and onboarding | CSV/Excel import has preview, mapped columns, duplicate detection, row errors, idempotent commit and signed balances. Import report is exportable; arbitrary files are not silently accepted. |
| 12 | Complete usable fee artifacts | Posted receipts print individually with school details, persistent unique number and correct totals. Corrections use reversals, not silent deletion. Partial/advance/waiver/refund cases reconcile. Outstanding and collections use one server aggregate and explicit period. |
| 13 | Add payment-provider integration if pilot needs it | School merchant account/onboarding selected. Signature/amount validation and deduplicated provider inbox handle duplicate and out-of-order events. Refund and settlement exceptions are visible. Never trust browser success/screenshots as final payment evidence. |
| 14 | Communication with real recipients | Canonical roles, verified contacts, family/class scope and inbox. Transactional outbox supports retries/idempotency. UI distinguishes queued, accepted, delivered, failed and read/acknowledged. Bulk-provider registration/costs agreed. |
| 15 | Complete guardian daily use | Child switch cannot show stale data. Guardian sees only linked child's published work, attendance and own fee/receipt history. Mobile navigation opens functioning role views. Low-bandwidth/stale-save behavior is understandable. |
| 16 | Aggregate, date and pagination consistency | All totals use authorized complete datasets/server aggregates; no silent max-row truncation. Lists show pagination/periods. One school timezone/calendar defines operational days, billing months and attendance weighting. |
| 17 | Trust and recovery | Real append-only business audit replaces editable demo audit rows. Private files have signed authorized access. Backups are restored in a drill. Error/job/provider alerts and an operator runbook exist. Retention/export/offboarding are tested. |
| 18 | School-approved academic outputs | Approved grading/term rules, moderation, publish/retract, report-card PDF/print, promotion and certificates use actual school templates. Parent access is published-and-child-scoped. Do not claim generic board readiness from labels. |
| 19 | Finish navigation/accessibility | Remove or label unavailable actions. Link password recovery. Label icon buttons, implement dialogs/focus/Escape and useful empty/error/loading states. Fix print views and tenant branding. |
| 20 | Expand from repeated paid demand | Timetable, admissions CRM, library, transport, inventory, payroll and integrations each get their own real lifecycle and invariants. Do not count local CRUD samples as completed domains. |

## Regression suite that matters

These tests protect high-impact behavior; avoid large suites that only repeat component implementation.

- Two schools, multiple roles and two families: direct REST/RPC/storage access across boundaries must fail, including after revocation. Anonymous access and disabled-account access are tested separately.
- Teacher scope cannot be expanded by editing the assignment/`is_class_teacher`; same-school unrelated class access and cross-school foreign keys are tested.
- Attendance present/absent/late/leave/half-day survives reload/date switch; a stale request does not overwrite a newer authorized edit. Calendar holiday semantics are agreed.
- One ₹1,000 demand paid ₹400 and ₹600 ends at zero due with one demand and two receipts/allocations. A failed transaction leaves no half-posted state. Identical retry returns the prior result. Two concurrent cashiers cannot overallocate without the explicit advance-payment rule.
- Duplicate/out-of-order provider webhooks create one valid posting; invalid signature/amount and failed/refunded events do not inflate collected totals. Day closing and reversals reconcile.
- Academic activity replacement failing midway preserves old content; stale concurrent edit reports conflict. Draft work is invisible to guardians.
- Score clear/absent/not-evaluated semantics work; untouched remarks remain; assessment scope cannot move after marks; concurrent maximum reduction and mark insert cannot violate the invariant.
- Old/new academic year retain historical assignments, attendance, results and balances. IST midnight/before-05:30 dates are correct. Large datasets exceed configured API row caps without incorrect totals.
- Import replay does not duplicate pupils/opening balances; export and restore recreate the approved counts/balances and private access rules.
- Auth callback accepts only allowed internal destinations, handles missing/invalid code, and never redirects to an arbitrary external origin.

## Pilot release gate

Before real school use, the owner/accountant signs off migrated balances and scope; teachers demonstrate attendance without data loss; the school selects the system of record and approved merchant/message channels; permissions, restore, receipts and daily reconciliation pass against seeded tests and the approved import. Commercial terms define support, data responsibility, external charges and exit/export.

Completing a UI, build or provider request is not equivalent to passing this release gate.
