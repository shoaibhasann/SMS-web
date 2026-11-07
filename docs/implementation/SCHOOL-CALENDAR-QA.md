# School calendar and daily attendance rules

7 November 2026 · Hosted SDK/local browser verified · Post-local preservation verified · Production release pending

This slice governs working weekdays, dated holiday/extra-working-day exceptions and a school-configured Teacher correction-request window. It uses the existing daily register, correction review and gate ingestion. No classroom devices, period attendance, automatic absence inference or official percentage formula is introduced.

## Intended behavior

- No rule is automatically activated for existing schools. An unconfigured school retains its existing manual/gate behavior and is explicitly labelled unconfigured.
- Current native School Admin/Principal identities manage their own school with AAL2, reasons, shared revision checks and actor-bound exact request receipts. Teacher, family, foreign-school and signed-out identities cannot configure rules.
- New policy snapshots and dated exceptions are immutable revisions. Effective dates are today/future; a current-day change is rejected once attendance or gate evidence exists. Previous attendance, payments, links and inbox read state are not rewritten.
- One server resolver governs manual attendance, device weekday decisions and the submission monitor. A configured closed day blocks direct marks, retains gate scans as held evidence and does not create a pending register or fabricated Holiday/Absent rows. An explicit working-day exception overrides the weekly pattern.
- Teacher historical correction requests follow the policy active on the request date. Existing pending/exact requests and independently reviewed office exceptions retain the established reason, scope and review controls.
- Family dashboard summaries identify their loaded saved-record sample. Present/Late counts are not presented as an official rate based on incomplete records or assumed Leave/Holiday/Half Day weights.
- Teacher raw legacy-holiday writes and direct/correction changes to or from pupil Holiday status are blocked. The existing Office controls require actual same-school School Admin/Principal authority and a native verified authenticator session; an already-pending Holiday request can still be independently reviewed under those controls.

## Verification record

Applied migration `20261107104519_govern_school_attendance_calendar.sql` matches reviewed SHA-256 `bc62767d51af92268307b627f1d1d191ad54b42433247fe3c1c58594e496a580` and hosted ledger MD5 `133439364f2de7b6838ec354da2aae27`. The hosted/local 20-routine definition/configuration/owner/ACL digest is `def5100bc38d3cec25ec61e4caa42709`. All-routine comparison identifies 15 additions and only five intended modifications: private correction request/review, private gate ingestion and private/public submission-monitor definitions. Family notification, fee and Guardian-access routines are unchanged.

Three private tables use RLS and deny raw client/server-role CRUD. Legacy holidays SELECT is retained while table and column mutation grants are denied. Two nullable gate-event provenance columns retain policy/exception revisions without rewriting old values. Attendance row shape is unchanged so pending whole-row correction snapshots remain valid. Recovery now has 96 sources/26 forward patches/128 application tables/five views.

Security-advisor INFO no-policy entries increase 56→59 for the three deliberate private deny-all tables. The five platform-constructor search-path warnings, five intentional authenticated-definer warnings and one disabled leaked-password-protection warning are unchanged. References: [private RLS](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [search paths](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [definer grants](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

| Verification | Observed result |
|---|---|
| Whole local web | 2,860 tests/180 files, whole lint, optimized build and subsequent TypeScript pass. |
| SQL/calendar/gate/alert/replay | Final post-alignment 154 tests/four files pass. Overlaps with the whole suite are not additional unique tests. |
| New calendar UI/client and integration | Calendar helper/UI 38 focused tests pass; register/day-context/monitor integration 86 focused tests pass. Family sample counts and existing dashboard/Settings regressions are also covered by the whole run. |
| Hosted source/ACL | Exact SQL source/ledger and 20-routine parity verified; native-factor, role, row/column grant and private-table checks pass. |
| Managed SDK workflow and original history | 96 successful feature/security checks plus 21 native-bootstrap checks. Admin/Principal native AAL2 positive; Teacher/family/foreign/anonymous/stale/AAL1 and metadata-spoof denial, exact retry, shared-revision conflict, immutable past/future resolution, Holiday bypass denial and correction-window 2→0 pass. Existing pending review returns its established TEXT `approved` acknowledgement and changes only the new QA yesterday mark to Late. |
| Local browser save/reload/role controls | Admin A future 14 November Holiday → Working → Inherit saves survive hard refresh at revisions 7/8/9. Principal B future 15 November Holiday → Inherit survives refresh at revisions 3/4 while unrelated School details remains read-only. Teacher A sees today closed with no Save and disabled Holiday, reads retained yesterday Late, cannot request a new correction at window zero and is denied direct Settings despite spoofed user metadata. Guardian A sees only linked Pupil A, the `1 of 1` saved-record sample label and yesterday Late after hard refresh; no calendar editor. All four browser identities log out to observed Login. |
| Pre-Production preservation | All 2,980 original rows/125 tables (including 60 old preference rows) and 16 managed calendar records remain exact. Current 3,048 rows/128 tables; zero owned native sessions; all seven devices revoked. |
| Main/Production release | Pending actual deployment/readback. |

Founder cases stay unchecked until founder testing. SDK and browser evidence are independent; tests do not certify physical gate hardware, future date rollover or real phone delivery.

The managed gate checks use only new isolated schools. School A has today closed: an IN is held as `non_working_day`, creates no mark, and produces zero arrival/absence alerts even when its fresh Guardian has opted into both gate choices. School B has device weekday OFF but an explicit working exception: qualifying IN marks Late with policy/exception provenance. Concurrent requests for a first IN and today exception observe the gate-first branch, then reject the calendar action with PT409; Principal manually changes the new mark afterwards. This is an observed client-request race, not SQL-lock instrumentation, load certification or proof of every interleaving. Existing devices are not used.

Pre-DDL and core checkpoints preserve all 2,980 original application rows across 125 original tables, comparing their original columns so additive nullable provenance does not fabricate row differences. The core total is 3,038 rows across 128 tables, including only fresh fixtures; post-local comparison preserves every original row and all 16 managed calendar records. After the five local future exception decisions and receipts, the verified pre-Production total is 3,048 rows/128 tables: four policies, nine exceptions and 13 receipts; A revision 9/B revision 4. Zero owned native sessions remain; all seven devices are revoked, 46 events/19 mappings/12 provenance days are unchanged, duplicates/post-revocation events remain zero, and School A today still has no marks or new Guardian alerts. The complete pre-Production snapshot is saved privately. Final post-release proof remains pending. All managed SDK sessions close and all seven synthetic devices are revoked before browser QA. Browser QA appends five future exception revisions and their receipts; it does not rewrite attendance, preferences or old decisions. A harmless harness expectation of a UUID correction-review acknowledgement was corrected to the existing TEXT contract and resumed from saved stages without replaying writes; no original row was restored.

The private starting baseline is captured independently from the prior release. Fixture records, passwords, native factors and event credentials must remain outside Git. Never restore over another actor's concurrent changes to manufacture a passing comparison.

## Acceptance boundary

Use the [focused founder checklist](../../public/qa/school-calendar-checklist.md). Physical terminal adapters/delivery, native binary distribution, school-specific official rate calculations, overnight calendars and provider activation remain separate work. The existing [gate ingestion](GATE-ATTENDANCE-QA.md) and [optional Guardian gate alerts](GATE-ALERTS-QA.md) retain their independent release evidence.
