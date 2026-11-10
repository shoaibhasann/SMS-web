# Founder demo data seed

## 10 November update — attendance, schoolwork and fees

The [activity seed](sms-academic-activity-qa.sql) defaults to rollback. It fills the two existing synthetic 2,000-student rosters and one isolated Android QA pupil. It adds missing rows only and preserves existing marks, payments, accounts, roles and guardian links. Both roster cohorts have seven working days of attendance, two published lessons per section and a mix of open, submitted and graded homework. Fee Credit QA has sample overdue, partial and paid invoices. The MFA roster keeps its existing invoices.

On Android, sign in as the demo Student or Parent and open **Attendance** for the 10 November Present mark. In **Learning**, open the Mathematics homework for sample feedback and the English homework to test a new submission as Student. The Parent view is read-only. Classwork and the complete fee ledger are available in SMS Web. The APK pupil has one paid invoice with a demo receipt and one overdue invoice.

The seed retains in-app update history and discards only the push jobs created within the same transaction by these demo homework and payment rows. It sends no phone notifications. Use a new QA action to test push delivery.

Hosted rollback, commit and replay verified these counts.

| QA cohort | Students | Attendance marks | Classwork and homework | Sample submissions | Fee demands | Demo receipts |
|---|---:|---:|---:|---:|---:|---:|
| Fee Credit | 2,000 | 14,000 | 240 | 1,000 | 4,000 | 500 |
| MFA | 2,000 | 14,000 | 240 | 1,000 | 3,566 retained | 0 |
| Android Student and linked Parent | 1 | 1 | 4 | 1 | 2 | 1 |

Both APK logins loaded the same pupil’s attendance, two homework tasks, one graded submission and four in-app Updates through the mobile data helpers. The web fee ledger returned two invoices and one receipt. A same-school pupil without a link remained inaccessible. Two hosted query changes retain the existing scope checks and keep the homework list and Updates usable with the larger roster.

## 9 November update — large roster in the same QA login

The original large roster was in the separate MFA QA school. The Fee Credit QA Admin's existing school now has **2,044 students**: 44 original records plus 2,000 fictional students in 15 grade bands (Nursery to Class 12) and 60 new sections. The [insert-only seed](sms-fee-credit-roster-qa.sql) defaults to rollback. It does not create login accounts or add fees, attendance or teacher assignments for the new classes. The original student, role, academic-year and fee ledger fingerprints matched before and after.

Use the same QA Fee Credit Admin login. Refresh **Dashboard** and check **Total Students: 2,044**. In **Students**, choose **QA Roster · Nursery → A** to see 34 enrolled pupils, then search `SMSFCQA26-0001`. Students in another school stay outside this account's scope.

## Original 6 November demo seed

6 November 2026 · Task tag `SMS-DESIGN-QA` · Reviewed hosted demo seed completed

Target is only the existing founder demo school `7727a1bf-6330-4dbe-962e-b2bb50646c72` (`ERP-FEE-CREDIT-QA-a852f1dc`). The SQL asserts its current session, class/sections/subject, existing active admin and teacher, existing Student placement, and already verified Guardian-child edge before writing. Missing or changed scope aborts the entire transaction. A revoked child link is never recreated by this seed.

[`sms-design-qa.sql`](sms-design-qa.sql) defaults to **ROLLBACK**. Run it as one trusted SQL transaction after reviewing the concrete statements. A committed run requires changing only its final dry-run rollback to commit. It creates no Auth accounts and changes no passwords, profiles, school roles, parent identities or guardian links. It does add eligible subject/class teaching assignments to the already authorized demo teacher, as requested for the demo school.

## Seed-owned dataset and minimal local fixture

- 40 new fictional pupils, with deterministic UUIDs and `SMS-DESIGN-QA-001` through `SMS-DESIGN-QA-040` admission numbers. No login profile or registered mobile is attached to these new pupils.
- The seed targets three classes (the founder's existing class plus two demo classes), two sections per class, and three subjects (the existing subject plus Mathematics and English demo subjects). Existing extra sections and subjects remain; hosted totals are recorded separately below.
- Eighteen section/subject teaching assignments across that scope, reusing existing assignments through their unique mapping rather than duplicating them. The existing class-teacher assignment is preserved.
- Thirty calendar attendance dates including today for the 40 new pupils plus the two known existing siblings when active. All original attendance marks win; the seed inserts missing records only. Today's new fictional pupils have deterministic Present/Absent/Late/On Leave distribution. Existing linked siblings are Present today only when no mark already exists. New pupils have no guardian recipients.
- Six published class logs, twelve classwork/homework activities and two text-only study-material activities. Two additional legacy study-material metadata rows have no external URL or uploaded file. These records do not claim that a file exists.
- Two completed classroom assessments and one upcoming assessment, scoped to the founder class and existing teacher. Completed assessments include every current active pupil in their section, using explicitly synthetic practice scores. The minimal local fixture produces 22 marks; a live demo roster with more existing pupils will produce more.
- Four published, school-scoped in-app notices. No email, SMS, WhatsApp or mobile-push provider is called.
- No new fee demands, money posting, refunds or receipts. The transaction compares existing school fee/payment/refund rows before and after and aborts if any changed. Existing founder finance stories remain intact.

Dates are relative to the current IST day, bounded by the existing current session. Attendance statuses and practice scores are synthetic QA facts, not school calendar, grading or leave policy. Existing rows are never updated or deleted. Every insert uses a stable task/school-derived identity and `ON CONFLICT DO NOTHING`; already edited demo placements cause an explicit stop rather than being moved back silently.

## Local verification

Run `node scripts/qa/verify-design-seed.mjs`. It accepts no database URL, credentials, connection or output arguments. It replays the exact pre-pending application checkpoint into a fresh embedded database, creates a synthetic matching founder-scope fixture, then verifies:

1. The default seed rolls back and preserves every application/Auth row.
2. A committed local run creates the planned counts (42 pupils including the existing pair, 1,260 attendance rows, six logs, fourteen activities, two materials, three assessments, 22 marks and four notices).
3. A second committed run preserves every row exactly, without duplicate inserts or silent changes.
4. Existing Auth/profile/role/parent/link and fee/payment/refund rows remain identical.
5. Today's new-pupil status distribution is mixed; existing linked pupils remain Present.
6. A wrong-school preflight fails without partial writes.

The local check passes against the captured pre-pending schema, matching the currently hosted schema rather than assuming the nine pending migrations are already installed. This is synthetic local proof. Root separately completed the reviewed hosted rollback and commit described below; the preparing agent executed no hosted DML.

## Hosted demo readback — completed

After the user explicitly requested test data, root reviewed the concrete SQL, ran its hosted **ROLLBACK dry run**, and then ran the exact reviewed transaction with only the final statement changed to **COMMIT** through the Supabase connector. The target remained `ERP-FEE-CREDIT-QA-a852f1dc`. This populated synthetic demo records; it did not apply any of the nine pending schema migrations, deploy code or perform a backup/restore.

Root's post-commit readback verified:

| Record | Hosted result |
|---|---|
| Students | 42 total, including 40 new fictional pupils |
| Classes / sections / subjects | 3 / 7 / 4; existing extras preserved |
| Attendance | 1,260 rows across the 30-date demo window |
| Today's attendance | 25 Present, 8 Absent, 3 Late, 6 On Leave |
| Published academic logs / activities | 6 / 14 |
| Study materials | 2 text-only metadata records; no external/uploaded file claimed |
| Assessments / notices | 3 / 4 |
| Existing Auth, school roles and guardian links | Unchanged |
| Existing finances | Unchanged; the existing monthly ₹850 figure remained unchanged |

The hosted 7-section/4-subject totals are larger than the minimal local fixture because extra existing demo masters were preserved. The new-pupil distribution is 23 Present, 8 Absent, 3 Late and 6 On Leave; the two existing linked pupils contribute the additional two Present records without overwriting any saved attendance.

The checked-in SQL still ends with **ROLLBACK**. The local verifier still passes rollback preservation, same-day idempotence, wrong-school denial and unchanged account/link/financial evidence. New assessment-result publication remains pending its schema/frontend rollout and independent acceptance; this hosted seed does not mark that feature deployed or concurrency-tested.
