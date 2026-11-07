# Official family attendance percentages

7 November 2026 · Hosted calculation and local browser verified · Main/Production pending

## Approved calculation and scope

The user approved formula `daily-v1`: Present and Late earn one day, Half Day earns 0.5, Leave and Absent earn zero. The denominator is the pupil's known enrolled working days in the school calendar. Weekly closures and dated school holidays are excluded; an explicit extra working day is included. This is the approved product calculation, not a claim of board certification or school acceptance.

The Student and Guardian dashboards show a selected current-academic-year month and session-to-date summary. Server school time is Asia/Kolkata. Future days, dates outside the academic year and dates before the verified admission/promotion start or after a governed withdrawal are excluded. Same-session section moves retain one pupil/day and use the dated placement for mark coherence.

No percentage is issued for unresolved working-day marks, missing calendar coverage, uncertain enrollment dates or conflicting canonical records. Missing attendance is Unmarked, never inferred Absent. An imported `enrolled_at` timestamp is ingestion metadata, not proof of admission. A pupil-level legacy Holiday mark on a configured working day is a conflict to review, not permission to silently shrink the denominator. Closed-day records remain in history but do not affect the rate.

The current-year selector requires exactly one coherent current school year, with at most 366 inclusive days. Unsupported, missing or ambiguous years are explained instead of guessed. Historical years, exports, period attendance and a school-specific formula editor are outside this slice.

## Security and data boundary

The server checks the current native family identity/session, explicit Student or Guardian role, school and own/current linked pupil. A revoked child link, retired login, expired/logged-out session, foreign pupil or user-editable role claim cannot authorize a summary. UI requests pin the captured owner and child and suppress stale responses after account, child or month changes. No raw attendance, calendar, link, fee or notification mutation is added.

Existing calendar authority remains exclusively actual same-school School Admin/Principal with verified native MFA. This reporting phase does not change weekdays, publish holidays, backdate a real school policy, write absent marks, activate providers or reset read state.

## Verification record

| Checkpoint | Observed result |
|---|---|
| Pre-change hosted baseline | 128 application tables / 3,052 rows match the previous phase exactly; zero concurrent deltas. Private original-column fingerprints and attendance catalog captured. |
| Migration/source/ACL | Applied `20261107114728_family_official_attendance_summary.sql`, exact SHA-256 `73585dcdf108492bb6feee60977db0f25896cb61cff4a154c4d665a33968593a` and hosted ledger MD5 `ebaa32613847512c9085152ec80b92da`. Only two new routines, no new tables or old-routine edits. Private Definer/public Invoker both volatile, empty search path, owner postgres, execute only postgres/authenticated. Private/public body MD5s `5becc8aed14823eacd485c2ed839a0dc` / `82191902b55f197e992fa8cc61dba51e` match source. |
| Whole web checks | All 2,963 tests/183 files pass (17:19:40 IST start, 110.66 seconds); whole lint, optimized build and subsequent TypeScript pass. Final post-alignment SQL/calendar/replay 108 tests/three files and UI/client/dashboard 108/three pass; those groups overlap with the whole suite. |
| Managed Supabase Auth/SDK and calculation | 92 assertions pass: 22 fresh Auth/bootstrap, 56 calculation/correction/access and 14 revoke/reinvite/accept. Actual frozen TS helper reads 50%, remains 50% during the native Teacher pending request, then reads 58.33% after independent native Admin approval of Absent → Half Day. Missing sibling and unconfigured school return NULL percentage. Two visible raw-history rows out of seven saved do not change the six-day denominator; the separate local DB case covers more than 60 rows. Cross-role/child/school, anonymous, wrong owner and logged-out retained JWT requests deny. Existing product revoke → re-invite → same verified Guardian acceptance restores only the new sibling link, resetting its preference epoch OFF while the other child stays 58.33%; no SQL link restoration is used. |
| Local browser | Guardian sees both 58.33% cards with six working, one excluded closed, 3.5 earned and zero unmarked days; expanded details show Present 2/Late 1/Half Day 1/Leave 1/Absent 1. Hard refresh preserves the result. October has no elapsed enrolled days/NULL monthly rate while session remains 58.33%; panel Refresh retains the chosen month. Missing sibling shows one unmarked day/NULL rates, survives selected-child hard refresh, and rapid sibling switching ends on the correct complete child. Student owns both 58.33% rates after hard refresh without a Guardian child selector. Foreign-school Student sees seven unconfigured days/NULL rates before and after refresh. Canonical history retains 3 November Half Day and the excluded 4 November Present record. |
| Local responsive/appearance | 390×844 phone viewport in Light and Dark has document/content width 382/382, with no horizontal overflow; monthly controls and summaries remain usable. Native keyboard November→October selection is observed. The original Dark preference and default viewport are restored. All three local browser identities log out to observed Login. |
| Production browser | Pending released Student/Guardian readback, refresh and logout. |
| Post-local / pre-Production preservation | All 3,107 pre-browser full-row hashes and all 3,052 original rows remain exact, with 128 tables/3,107 rows and zero owned sessions. All 50 attendance routines match the post-API reference; SQL/helper/ledger parity holds. All 123 original Auth users/contact/metadata hashes, 21 factor descriptors and 443 session descriptors are retained; current 129 users/23 factors/443 sessions includes only the fresh accounts/factors. Both intended links/new OFF preferences, reviewed Half Day, zero fresh alerts and prior gate events/devices remain unchanged. A fresh 3,107-row pre-Production snapshot is saved privately. |
| Final post-Production proof | Pending released browser/logouts and final read-only comparison. |
| Main/Production | Pending tested runtime release and stable-URL/checklist readback. |

The fresh multi-day hosted fixture contains explicitly synthetic historical calendar versions created through trusted test seeding on a new school. This does not demonstrate or enable backdated calendar publication through the Office product API. Actual correction requests and independent approval are recorded separately from fixture preparation.

After DDL, the security-advisor groups are unchanged from before: 59 private deny-all RLS INFO entries, five platform-owned search-path warnings, five intentional authenticated-definer warnings and one disabled leaked-password-protection warning. Supabase managed password/TOTP sessions and SDK calls are being tested here, not an Android application. No new advisor groups or findings were introduced by the two read-only functions; existing warnings remain open. References: [private RLS](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [search paths](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable), [definer grants](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

The trusted historical seed adds 51 isolated application rows (3,103 total before workflow). All 3,052 original row fingerprints are preserved. The correction/access workflows end at 3,107 rows/128 tables; 48 original attendance routines remain exact and only the two new functions are added. All managed owned native sessions close. The fresh Guardian has no gate/absence alerts; old notifications/read timestamps, prior devices and gate evidence remain unchanged. A complete 3,107-row pre-browser snapshot is saved privately for the final read-only comparison.

## Founder acceptance

Use the [focused checklist](../../public/qa/official-attendance-checklist.md). All founder cases remain unchecked until the founder records their own result. Private test credentials and factors stay outside Git. Physical gate units, real SMS/push delivery, native app distribution and real-school data/board acceptance remain independent gates.
