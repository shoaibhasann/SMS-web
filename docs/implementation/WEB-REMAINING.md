# Remaining web work

7 November 2026 · Current source and private-file follow-up · Founder acceptance pending

The web app has live attendance, roster, guardian access, academic work, reviewed result publication and office finance flows. It still contains Admin demo screens and role fallbacks. A visible menu item does not establish a working school workflow. The separate native app will reuse the backend; it does not replace the remaining web work below.

## Code to build or finish

| Priority | Work | Current boundary and evidence |
|---|---|---|
| P0, before real school data | Staff MFA, school-assisted lost-number recovery and permission-management UI | Current own-password and guardian contact verification flows exist. Staff MFA and lost-number administration remain outside that implementation. Role/module navigation is a static map; a school permission editor is not implemented. See [hybrid auth scope](HYBRID-AUTH-QA.md) and `lib/modules.ts:53`. |
| P0, before strict file-revocation claims | Close legacy private-file capabilities and confirm the release | The new source-ID INVOKER grant, pre/post-authorized noncached byte proxy and Storage-origin raw/sign/list denial are applied; updated Student/Teacher web callers are verified in source. Four held warmed raw capabilities still replayed from the CDN; the captured short-lived signed test had expired before key revocation, so its denial cannot prove rotation’s effect. Owner UI confirms the replacement key Active and previous key Revoked; post-rotation QA is complete (9pass/3sessionsclosed), confirming protected proxy success and retained-session denial while all four exact warmed raw URLs still replay200/Cloudflare HIT and fresh nonce denies400. Main/Vercel/browser readback remains pending. Record the known cache lifetime boundary before claiming immediate global revocation. Native original-download UI remains deferred. See [current private-file evidence](PRIVATE-FILE-DELIVERY-QA.md). |
| P0 | Real School Settings and guided new-school onboarding | Academic setup, CSV imports, roster admission/transfer/promotion and invitations exist. `/modules/settings` still opens the local demo. Build school-scoped settings and connect a clean school through the complete setup sequence, with role checks and a separate school's isolation proof. See [SET-01 and build sequence](../product/PRD.md). |
| P1 | Connect the remaining office screens | Admin Parent directory, dedicated Admissions, Events, School Profile, Documents and Reports still route to `AdminDemoWorkspace`. Basic admission already works inside Students, and guardian invitation/link management is live; those should be reused. A read-only Supabase Parent view exists in `components/admin/admin-people-workspace.tsx` but is not routed. See `app/(dashboard)/modules/[module]/page.tsx:303` and `components/admin/admin-demo-workspace.tsx:45`. |
| P1 | School calendar, attendance rules and period attendance | The current attendance repository loads/saves a class register by date, with no period in its context. Daily attendance, reviewed corrections and cutoff monitoring are implemented. Separate period registers, school correction windows and calendar/rate rules remain. School-approved holiday, leave and half-day calculations are required before reporting them as official rates. See `lib/attendance/types.ts:61` and PRD ATT-01–03. |
| P1 | Full term report cards | Published single-assessment snapshots and browser printing exist. Term aggregation, school grading/pass-fail/rank rules and retained report-card PDFs are not implemented. The result card states this limit in `components/academic/result-publication-workspace.tsx:284`. School-approved formats and calculations are still required. |
| P1 | Hindi and English family UX | Parent/student flows currently use English strings; no translation resources or language-selection infrastructure was found. Translate the supported family workflows and verify child switching, dates, validation and narrow-screen layout in both languages. See PRD FAM-01. |
| P1 | Remaining manual finance flows | Historical advance-credit import and partial refunds of ordinary fee-payment receipts remain. Monthly/opening demands, reviewed reductions/additional charges, full payment-entry reversals, advance allocation/returns and unused-advance offline refunds already exist. Preserve those journal and review rules. See `lib/finance/fee-changes.ts:5`, `lib/finance/advance-credit.ts` and PRD FIN-01. |
| P1 | Remaining notification event coverage and staff workflows | Existing family absence/result/leave events, independent read state, native push preferences/devices and dispatch backend are implemented. Late attendance, homework, fee, exam and announcement triggers, school-level trigger controls and staff recipient workflows remain. The Admin Notifications screen is still a local demo. See [family notifications](FAMILY-NOTIFICATIONS-QA.md), [native push backend](NATIVE-PUSH-QA.md) and PRD NTF-01. |
| P2, package scope to be confirmed | Real operations modules | Library, Transport, Inventory, HR/Payroll and staff Leave Management still use localStorage demo records. Build each module's school-scoped records, permissions and daily operations before including it in a commercial package. Student leave requests are a separate implemented flow. See PRD OPS-01. |
| P2 | Platform operations and subscriptions | School provisioning, subscription/package administration, monitoring and support handoff still need a complete operational workflow. Assign backup ownership and prove recovery of the managed services before real-school launch. Existing imports and demo data do not establish new-school onboarding or subscription readiness. See PRD PLT-01. |
| P2, confirm the first school's import need | Native Excel import | The implemented import forms accept UTF-8 CSV with preview/validation. Native `.xlsx` parsing is not present, while PRD RST-02 lists Excel and CSV. The school can use the existing reviewed CSV flow; confirm whether direct Excel upload is needed for its initial migration. |

## Where the demo boundary is visible

Admin routing currently sends Parents, Admissions, Events, Admin Notifications, Library, Transport, Inventory, HR/Payroll, staff Leave, School Profile, Documents, Reports and School Settings to `AdminDemoWorkspace`. Its `useDemoList` reads `window.localStorage` as the source of truth. Other unsupported role/module combinations reach `GenericModule`, which only says the module is ready for a dedicated screen.

Evidence: `app/(dashboard)/modules/[module]/page.tsx:303`, `:336`; `components/admin/admin-demo-workspace.tsx:45`; `lib/admin/admin-demo-service.ts`.

The working Students, Teachers, guardian invitations/access, attendance, timetable, published results, notices, academic work and finance routes have dedicated implementations. Replacing a remaining demo should preserve and reuse these existing flows.

## Implemented, with activation or acceptance still open

| Capability | What remains before acceptance |
|---|---|
| Guardian mobile OTP | Approved funded provider/template, Turnstile/Auth hook setup, real-phone delivery and phone-change/recovery QA. Sending remains disabled until that setup is accepted. See [hybrid auth checklist](HYBRID-AUTH-QA.md). |
| Native push backend | Native OS permission and Firebase installation registration, provider credentials, a protected recurring dispatcher schedule and real-device delivery QA. The web account settings and backend queue are already implemented. Provider acceptance is not proof of phone delivery or read state. See [native push checklist](NATIVE-PUSH-QA.md). |
| Fee and academic acceptance | The school must approve its fee policy, opening/migration sources, grading/report-card format and sample reconciled cycle. Existing demo QA does not supply those decisions. |
| Attendance policy | The school must approve working days, holidays, period rules, correction windows, rate formulas and retention. Do not choose these from demo values. |
| Recovery | Executable replay and embedded application-row restore checks exist. An actual isolated Supabase/Auth/Storage/provider recovery rehearsal, attachment-byte comparison, operator ownership and approved recovery targets remain. See [recovery boundary](DATABASE-RECOVERY-QA.md). |
| Founder and school acceptance | Run the manual checklists against the released revision, then a clean school with approved data. Record actual results; engineering tests do not tick founder cases automatically. |

## Intentionally deferred payment gateway

A live payment gateway is deferred by the agreed scope. There is no gateway checkout or simulated payment success to accept. The office ledger supports recorded manual payments and controlled offline payouts; a later integration must verify provider settlement, preserve idempotency and reconcile refunds without replacing the existing journal.

See [the settlement boundary](FEE-SETTLEMENT-BOUNDARY.md). Gateway credentials, settlement webhooks, chargebacks and actual bank refunds need their own implementation and tests when the provider is chosen.

## Suggested web sequence alongside the native app

Close the legacy private-file capability/release gate, staff/account security and real School Settings/onboarding first. Then finish school attendance/report-card policy flows, bilingual family UX and the remaining finance cases. Replace the office and operations demos according to the founder's approved package. Activate messaging only after the actual provider/device checks pass.

The original web audit changed documentation only. The later native Learning/security phase and source-authorized file phase verified their own hosted boundaries; see [mobile evidence](MOBILE-PILOT-QA.md) and the [still-open legacy file gate](PRIVATE-FILE-DELIVERY-QA.md). Neither checkpoint certifies the complete ERP for sale.
