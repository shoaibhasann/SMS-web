# Official family attendance PDF export

7 November 2026. [Founder checklist](../../public/qa/attendance-pdf-checklist.md) · [Stable Production login](https://kids-corner-erp-frontend.vercel.app/login).

## Product boundary

Student and Parent web dashboards and Attendance pages export the selected supported academic year and month as a local PDF. The document includes the verified school and pupil identity, reporting period/cutoff, monthly and academic-session totals, register states, calendar revision and daily-v1 formula. It is a dated snapshot of current verified school records, including approved corrections; it is not a digitally signed certificate. Unknown or incomplete source records retain their explicit state and do not become invented percentages.

Export uses the existing authorized family report APIs and RLS reads. The selected pupil/year/month are pinned; fresh access/data checks surround asynchronous PDF generation. The file is generated locally and is not uploaded, stored in a public bucket or sent to another provider. No SQL migration, attendance write, guardian-link change or notification activation is part of this phase. A file already downloaded to an authorized user's device cannot be remotely revoked.

## Verification and release

Whole web **3,198 tests / 190 files** pass, together with whole ESLint, optimized Next build, subsequent TypeScript and `git diff --check`. Focused renderer checks pass 15 tests and client/UI checks pass 68; these overlap the whole suite and must not be added as separate totals. Race tests cover changed displayed counts/revisions before export, source/identity changes during generation, late access/session failures, account/child/year/month/loading changes and duplicate clicks. Unknown setup and invalid scope block export; valid incomplete periods retain their null percentage.

The pinned on-demand PDF stack is `pdf-lib@1.17.1`, `@pdf-lib/fontkit@1.1.1` and the small required Indic-shaping polyfill `regenerator-runtime@0.14.1`. The lazy renderer loads only local licensed Noto fonts (Latin, plus conditional Devanagari) and embeds subsets. Real complete/Hindi/long-name incomplete samples are reopened with pdf-lib, extracted with Poppler and rendered to PNG for visual review: ordinary reports fit one A4 page, long labels paginate without dropping their endings, and unsupported glyphs fail with actionable text. Dependency audit matches the prior lockfile: the same ten existing moderate ESLint/minimatch development-tool advisories, with no new advisory introduced.

Actual final-source native Auth/SDK QA passes **51 assertions** through two real Student/Guardian sessions, both cleaned up by logout. Five real product PDFs cover current 100%, Student/Guardian archive 58.33%, missing sibling's withheld percentage/one unmarked workday, and February before admission with no monthly rate while the full session stays 58.33%. Wrong pupil/sibling/year/school/role/owner/month, unowned/future/unenrolled years, logged-out sessions, stale displayed revisions and cancellation deny export. No renderer mock or backdated native-write claim is used; only local relative-font fetches are resolved to the bundled files in the Node harness.

Local browser QA downloads six actual PDFs: Student Dashboard Current 100%; Student Dashboard archive 58.33% after hard refresh; Student Attendance selected February with no elapsed monthly rate/full-session 58.33%; Parent Dashboard complete archive 58.33%; Parent missing archive after hard refresh; and Parent Attendance missing archive with all 13 raw records retained. Each child's year preference is isolated. Poppler verifies all six as one-page A4 documents with the correct school/pupil, selected year/month, cutoff, formula/revision and expected rates/states. Actual PDF and 390px phone screenshots are visually checked; content width is 382px, the Download PDF button remains visible, and the temporary viewport is reset. Both browser sessions log out to Login.

Prephase and post-local/pre-Production read-only snapshots retain **all 3,244 application full-row hashes / 129 tables**. All 137 native identity/contact/metadata references, 27 factor descriptors, 443 historical-session descriptors and 65 routine references remain exact. Owned sessions are zero; 27 marks/two links, zero fresh absence/gate alerts and both OFF/version-zero gate preferences are unchanged. Prior 46 gate events/seven devices remain, with zero active devices. No new accounts, factors, seed rows, schema changes or provider sends are needed. Evidence/PDFs are private under `attendance-pdf-20261107` with directory 0700/files 0600; source and public MD contain no credentials.

Main/Production release and stable-URL browser evidence follow after the validated runtime is deployed. Founder acceptance remains independent and unchecked.

## Remaining acceptance

Founder/school review of its actual calendar/enrollment records and the exported document remains open. Native-app export, digital signatures, class/school aggregate reports and daily-row PDF histories are outside this change.
