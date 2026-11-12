# Private academic file delivery — engineering QA

7 November 2026 · Production downloads verified · Four measured raw-cache windows closed after expiry · Unknown signed-cache scope unverified

New academic downloads use a current-session checked byte proxy. The database migration and exact Edge source are applied to the intended demo project; matching Student/Teacher web callers and client tests are implemented. This does **not** establish that every previously cached raw URL or older signed capability has been invalidated. The owner’s authoritative UI at 00:22 IST confirms the replacement Storage URL key is Active and the previous key is Revoked. The credential handoff is complete. Post-rotation proxy QA passes. The four held raw contexts initially replayed cached bytes, then all denied after old JWT expiry at the 01:08:07 IST follow-up. Unknown historical signed-cache responses remain unverified. The checked `main` runtime is now Production Ready, with actual Student and assigned-Teacher browser downloads verified below. Founder acceptance remains independent.

## Protected delivery contract

- `authorize_private_academic_file(p_kind,p_id)` is `SECURITY INVOKER`. It accepts only a source UUID and one of `submission`, `activity`, or `material`; source, school, publication, assignment, own/linked-child and object permissions retain their existing RLS predicates. Callers cannot choose a bucket, path, owner or external destination.
- New authenticated raw-read, signed-read/signing and list operations are denied at the Storage origin for both protected buckets. Metadata operations needed for permitted pending uploads/replacements/deletes remain. This origin rule cannot itself invalidate an existing CDN response or an already issued capability.
- `private-academic-file` authorizes before fetching and rechecks the same current session/source/object grant after fetching. A changed or unavailable grant withholds the body. The fixed server-side object fetch uses no cache and refuses redirects; it does not fetch an arbitrary stored URL.
- Request/grant bodies, timeouts and file sizes are bounded. Homework is capped at 10 MB and supported PDF/JPG/PNG signatures; materials are capped at 20 MB or a smaller configured bucket limit. The fetched byte length must equal the authorized object size.
- Responses return bytes as `application/octet-stream`, attachment disposition, `nosniff`, and private/no-store browser/CDN headers. No signed URL or Storage destination is returned. Already delivered/downloaded copies cannot be recalled; revocation is checked at request authorization, including the final grant check, rather than undoing bytes already received.
- Student submission and Teacher grading buttons call the proxy by saved submission ID. The client rejects URL/JSON/HTML payloads, cacheable/redirected responses and empty or oversized blobs; it aborts stale account/panel/unmount work before creating a browser blob download. Upload and protected pending-file cleanup retain their existing flow.
- `activity` and `material` source kinds are available in the backend. A new study-material download UI and native original-file download UI are outside this slice. The native app continues to show private attachment metadata, upload Student work and read feedback.

## Source and hosted parity

| Item | Verified source |
| --- | --- |
| Hosted migration / aligned local filename | `20261106183702_proxy_private_academic_downloads.sql` |
| SQL SHA-256 | `c1df0e39d1699f9d7cc522ccc90d89672c78792a6dd1b0c162ee30552b3450a7` |
| SQL MD5 | `036ee0f71b518d3f15415cae282a71a1` |
| Hosted Edge version | `private-academic-file` version 2 |
| Edge source SHA-256 | `58cf9c8d3c907e6fc25f99a44bacd5e1e57ee5dbe7944536d853767853e0a362` |

The local SQL/Edge file hashes match those records. Hosted source was checked against the exact target project. Credentials, raw URLs, tokens, private object keys and probe artifacts remain outside Git and public documentation.

## Verified Production release — 7 November 2026

| Item | Recorded evidence |
| --- | --- |
| Runtime source pushed to `main` | `0e3fc33e7bb23595345b74a835e62783963c6334` |
| Stable Production | [SMS login](https://sms-web-shoaibhasann.vercel.app/login) |
| Deployment | `dpl_6pSrK4dchx34j7WHJGCMuJ5VJVcg` · Production · Ready |
| Build and GitHub status | 18-second Vercel build; GitHub Vercel status Success |
| Public readback | `/login` 200; released checklist bytes matched source |
| Released checklist SHA-256 | `fb6b251afbee6248e107973ae18ad0256cda419eb6cc99321342f614211195f4` |

Actual stable-Production browser QA signs in as the Student, opens the saved graded submission, downloads the original **608-byte PDF**, and logs out to Login. The assigned Teacher then signs in, opens Homework → View submissions, downloads the same original bytes, refreshes submissions and confirms the existing **8/10 grade and exact feedback** remain, then logs out to Login. Both owned browser sessions close through the UI. Each downloaded file matches SHA-256 `6441ab81104f2e7a48c34169266aebc6d3acc3b66335cf8de95715aa88d86af3`.

Those two observed browser paths establish the deployed buttons and browser CORS path. Permission negatives remain SDK/database evidence; native file downloads and physical-device behavior are not claimed. A deployment-scoped Vercel error-log query returned no entries in the new-release window; this is not long-term monitoring evidence. The checklist hash above records the `0e3fc33e` release checkpoint; this documentation follow-up preserves that runtime evidence.

## Function deployment note

`supabase/config.toml` pins `[functions.private-academic-file] verify_jwt = false` (it holds only Edge Function gateway settings; never run `supabase config push` with it). Deploy this handler with its explicit gateway setting from the repository root as well:

```sh
npx supabase functions deploy private-academic-file --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

Replace the project-ref placeholder with the intended project. This function-specific flag disables the gateway JWT precheck; the handler still requires a Bearer JWT and forwards it to PostgREST for signature validation and the live database session/resource grant before and after fetching bytes. It does not grant anonymous file access. The fixed privileged object fetch occurs only between those caller-authorized checks. Recheck the authenticated byte path and retained-token logout denial after redeploying. The flag is documented in the current [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-functions-deploy).

## Engineering evidence

- Whole web suite: **2,089 tests / 150 files**. Separate focused database/recovery rerun: **110 passed**. The aligned hosted-ledger filename/replay follow-up: **73 passed**. These reruns overlap the whole suite and are not additional unique test totals.
- TypeScript, Deno checking, scoped/full lint and the optimized Next build pass. Client file/UI regression coverage verifies source-ID payloads, generic authorization errors, no direct Storage fallback, bounds, safe local filenames and cancellation of a previous account’s late response.
- Actual hosted SDK QA: **34 checks**, exact original-byte comparisons across **five authorized role contexts and all three source kinds**, including the actual web read helper and permitted pending upload/discard, with **11/11 owned Auth sessions closed** and **zero SMS/email/FCM sends**. That initial run is SDK plus DOM/component evidence. The separate Production release record above adds two actual web-browser role paths; it does not establish native download behavior or browser coverage for every negative case.
- Final post-rotation read-only QA: **9 checks pass**. Student, Guardian and assigned Teacher proxy calls plus the actual web read helper return exact original bytes. All three retained clients are denied after logout; **3/3 owned sessions close**. These checks supplement the earlier run; no provider channel is activated.
- The three original objects retain their metadata, versions and paths; provider last-access bookkeeping is excluded. All original **13 logs /30 activities /5 submissions /4 materials** remain unchanged. The permitted new QA log/activity bring log/activity totals to **14/31**. Global **1,307 attendance /18 student fees /16 payments /34 guardian links** are unchanged; no historical attachment or protected row was reset to make the flow pass.
- Advisor counts retain the prior baseline: **41 INFO**, with existing warning-group counts **7 mutable search path /2 anonymous access /6 authenticated access /1 leaked-password protection**. This phase adds no new finding and does not declare those existing warnings resolved.
- Assignment-revocation during file authorization is covered in the local database regressions. It was **not** tested by mutating a live teaching assignment.

## Legacy cache timeline and current boundary

**Current measured status, 7 November at 01:08:07 IST (6 November 19:38:07 UTC):** all **four exact held raw-object contexts return 400 /Cloudflare DYNAMIC**, and fresh-nonce requests also return 400. Their old Auth JWT expired at **01:06:14 IST**. No 200/HIT remains in this measured follow-up. This closes the observed expiry window for those four known raw contexts; it does not establish instant logout revocation or a global purge of unknown historical capabilities.

The earlier evidence remains chronological:

1. A temporary maintenance probe attempted to purge the two fixed protected buckets and returned 403 on the Free plan. The normal proxy was restored immediately, with no deployed maintenance route. No successful purge is claimed.
2. Owner UI at 00:22 IST confirms the replacement Storage URL key Active and the previous key Revoked. The credential handoff is complete.
3. In the initial post-rotation replay, all four exact held warmed raw contexts still returned 200 /Cloudflare HIT with their previously authorized request context; fresh-nonce origin requests denied 400. The new proxy separately denied retained sessions after logout.
4. After the captured old JWT expired, the 01:08:07 IST follow-up denied all four exact raw contexts with 400/DYNAMIC, alongside 400 fresh-nonce denial. The closing result is observed expiry evidence for those captures, not evidence of a successful purge.

The captured 120-second signed test had expired before old-key revocation. Its later denial cannot be attributed to the rotation. **Unknown historical signed-cache responses remain unverified**; no claim is made that every older raw/signed capability disappeared or that a key-status screenshot purged cached bytes. No paid-plan upgrade or successful bucket purge occurred. Already downloaded/shared copies cannot be recalled. [Provider explanation of private Storage cache behavior](https://supabase.com/kb/troubleshooting/storage-private-bucket-files-still-accessible-after-remove-access-or-logout).

Private evidence retains the exact probe contexts and timestamps without publishing URLs or credentials. The measured four-context raw window is closed; broader historical signed-cache closure remains a separate boundary.

The checked `main` revision, Ready deployment, stable-alias readback and two observed browser download/logout paths are recorded above.

The [founder checklist](https://sms-web-shoaibhasann.vercel.app/qa/private-file-checklist.md) remains entirely unticked until manually observed on that release.

Engineering release readback is complete for the recorded scope. Founder acceptance and the unverified scope of unknown historical signed-cache responses remain explicit. This milestone does not certify complete commercial ERP readiness, native original downloads, provider delivery or managed-service disaster recovery.
