# Marks, notices and academic history QA

6 November 2026 · **Production is Ready:** [stable SMS login](https://kids-corner-erp-frontend.vercel.app/login), code `2dfb1e26`, deployment `dpl_Hn7b55aj4ThnjDC1tykBJAGxHP1J`. The requested nine migrations plus two hosted-QA fixes (**11 total**) are applied and their source/history hashes verified in [the rollout ledger](../../supabase/recovery/hosted-rollout-2026-11-06.json). Four-role Production read-only QA passed at 17:06 IST: 142 school reads, zero school writes/runtime errors and 4/4 local Auth-session cleanups. Individual manual founder cases remain unticked. Use [the Production founder checklist](PRODUCTION-RELEASE-QA.md) for the current release.

## What changed

| Audit finding | Behavior |
|---|---|
| 4 · Stale mark saves | Send only changed pupils. Each pupil's RPC locks the assessment, checks its captured version, then compares the saved mark's identity/version/value/remarks or performs a plain insert. Conflicts retain drafts; partial success reports only confirmed rows. |
| 5 · Incomplete activity reads | Page every activity within the selected logs, verify exact counts/IDs and reject incomplete/duplicate data before enabling destructive full-list edits. Parent version checks remain in place. |
| 6 · Stale notice edits | Database-issued UUID versions cover all writers, including no-op and change-then-restore edits. Edit, publication toggle and delete compare the captured version. List Refresh never promotes an open draft to a newer version. |
| 9 · Generated-log cleanup race | Removing an activity leaves its generated parent in place; the client no longer deletes a parent after a separate empty check. |
| 11 · Truncated result ranking | Load complete filtered assessments, marks and pupil mappings with counts, stable order and chunk validation. Missing/inconsistent data blocks ranks rather than producing a partial report. |
| 12 · Academic history cap | Remove the silent 200-log limit. Current year is the default; older/all available years and date/scope filters are explicit and applied to reads. |

Editors keep their original source snapshots through list/filter reloads. A successful academic save resets the editor instead of combining stale form values with a newly fetched version. Controls lock during writes. Mark reload refreshes parent metadata as well as pupil marks. Clearing a previously saved score is explicitly rejected; this phase does not add a mark-deletion workflow.

## Applied rollout dependencies

The four [access-security patches](ACCESS-SECURITY-QA.md) preceded these two applied integrity migrations. All are included in the verified 11-patch hosted chain:

1. `20261105191227_notice_optimistic_versions.sql` — adds notice tokens without changing existing business fields or grants.
2. `20261105192540_optimistic_assessment_mark_writes.sql` — requires the previous assessment security guard; adds the invoker mark-save RPC and advances timestamp versions for no-op/ABA updates. Existing infinite versions require normalization by an authorized writer before use.

The matching frontend is deployed on Production. The later `20261106105822_assessment_mark_conflict_http_status.sql` patch changes the two deterministic stale-mark SQLSTATEs to `PT409`; the final `20261106110537_bound_assessment_publication_candidates.sql` bounds the teacher candidate query while retaining its authorization helper. Missing schema/RPC still fails visibly; no unconditional-write fallback exists. The executable replay and private 99-table / 2,401-row application snapshot passed embedded restore verification; native Auth/Storage/provider recovery is not established by that check.

## Founder and engineering checks · Production

Record deployment URL/revision, applied migrations, tester/date/device and fresh results. Prepare synthetic teacher/admin/principal accounts and a second school. Use separate browser profiles/windows for competing sessions. Keep credentials and tokens out of screenshots/reports.

- [ ] **INT-01 · Two teachers' tabs, different pupils.** Open the same assessment in A and B with baseline One=30 and Two=40. A changes One to 35 and saves; B changes only Two to 55 and saves. Each response reports one changed mark. Reload both: One=35, Two=55. An unchanged pupil must never be sent back with an old score.
- [ ] **INT-02 · Same pupil conflict and partial result.** Both tabs load One=35. A saves 45; B tries 38. B gets a conflict/unconfirmed message and retains 38, while the saved score stays 45. Try a batch containing one stale pupil and one valid changed pupil: report confirmed and failed rows separately, advance only confirmed baselines and retain unresolved drafts. Explicit **Discard changes and reload marks** fetches current values before another reviewed save. A lost response must not be reported as confirmed success.
- [ ] **INT-03 · Assessment context and insert retry.** Open an ungraded assessment in A, then change its subject or maximum in B before A's first mark. A's stale save fails even without refreshing its list. Explicit reload obtains the new parent context and marks; a reviewed save succeeds. Competing first marks produce one row, never an upsert overwrite. Blank new scores stay unmarked; clearing a saved score is rejected. Reject wrong pupil/school, revoked Teacher role and inactive profile through direct RPC requests too.
- [ ] **INT-04 · Complete result report.** Prepare at least 25 assessments × 50 scored pupils (1,250 marks). Select year/class/section/subject/assessment filters and compare pupil count, totals and tied ranks with the fixture. Refresh/filter rapidly; late responses from the old scope must not replace the selected report. Simulate a lower response cap, missing page/count, missing pupil and duplicate row: either all matching data loads or ranks are withheld with an actionable error. Test an authorized report against the other school as well.
- [ ] **INT-05 · Notice privacy conflict.** A opens a published Everyone notice. B withdraws it and restricts it to Teachers. A changes only the title, optionally refreshes the list, then saves. The stale save fails, the draft remains and the notice remains Teachers/Draft. **Discard draft and reload** loads the actual audience/publication state; only a newly reviewed save succeeds. Refresh the page and check family inboxes remain excluded.
- [ ] **INT-06 · Notice status, delete and unknown response.** Change a notice in B after A loads it. A's stale publish/unpublish and delete fail without changing the current row. Refresh/review before retrying. Change a field then restore it in B: the original A version still fails. Disconnect after a save is accepted: A retains its draft and asks for reconciliation rather than claiming the write failed. Failed reload or a deleted notice retains useful draft text until explicit cancellation.
- [ ] **INT-07 · More than 200 logs and 1,000 activities.** Prepare 211 current-year logs with six activities each. Verify the oldest log and activity 1,266 are available, including under an 80-row response cap. Default history excludes an older year; selecting that year or All available years and applying filters makes permitted older work reachable. Check date/class/section/subject/type filters on their corresponding pages and refresh. Family access remains limited to published authorized records.
- [ ] **INT-08 · Complete source before editing.** Open a log with several activity types and edit only its topic. All untouched children remain. Simulate a missing/duplicate activity page: save is blocked. While a draft is open, reload/filter history after B changes the source; A retains its original expected version and cannot overwrite B. After a successful save, the old form resets; a post-save background read must not arm old values with a newer version. Input changes during pending writes are blocked.
- [ ] **INT-09 · Activity removal and preserved siblings.** Delete one homework/classwork entry while B adds a sibling activity to its generated log. The sibling and parent remain after refresh. Removing the last entry may leave an empty parent; no client cleanup request may cascade-delete newly added work. Verify submitted-work/file protection still behaves as before.
- [ ] **INT-10 · Phone, keyboard and error recovery.** At 390 px and laptop width, reach conflict messages, pending states, explicit reload/discard and history controls by touch/keyboard. Check both themes and labels that identify each pupil's mark/remarks. Tables may scroll within their container; the page must not overflow horizontally. Check success/error text and refresh after each reviewed operation.

## Historical integrity-phase engineering evidence — 6 November 2026

Focused local tests cover real SQL/RLS and actual React components with competing state, plus lower-cap/count/duplicate pagination cases. The ordered migration integration applies all six pending security/integrity migrations in one database and preserves original business rows; notice version backfill is intentional. Final aggregate checks are recorded in [the implementation log](PHASES.md).

Controlled Chrome checks use real existing QA Auth login but **intercept school-data REST/RPC traffic into synthetic state**. Notice privacy conflict/reload/save, mark conflict/parent-context reload, and 211 logs/1,266 activities through an 80-row cap are browser checks, not proof of hosted SQL persistence. QA sessions are signed out; these browser checks write no hosted school/financial rows.

The historical controlled results above are preserved as phase evidence. The 11-patch hosted rollout and private application-row/embedded restore verification are now complete. Still pending separately: real competing-session schedules, production load, native Auth/Storage/provider recovery and founder sign-off. Exact counts and duplicate checks are conservative completeness guards, not a transaction-wide read snapshot; concurrent same-count replacements can evade them. Result ranks are calculated from the complete returned set, not a serializable reporting snapshot. New-notice creation still lacks idempotent retry handling. Assessment metadata edit/delete outside the mark-save RPC retains its existing workflow. Family historical visibility follows existing enrollment/RLS rules. No gateway or unrelated commercial module is added in this phase.

| Checkpoint | Result |
|---|---|
| Local regression/lint/TypeScript/build |1005/1005 tests across 105 files; lint, TypeScript and isolated production build pass.70 additional regression cases this phase. |
| Controlled browser checks | Passed with intercepted school data; real QA Auth only |
| Hosted migration rollout | All 11 patches applied with exact source/history hashes verified. |
| Current deployed database/browser acceptance | Four-role Production read-only QA passed at 17:06 IST; record each manual INT case independently. This does not mark its write/conflict fixtures Pass. |
| Independent concurrent connections / load / native provider recovery | Pending; application-row embedded restore is verified separately. |
| Founder Production acceptance | Pending |
