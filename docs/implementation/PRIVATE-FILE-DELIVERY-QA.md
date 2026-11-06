# Private academic file delivery — engineering QA

7 November 2026 · Hosted backend and post-rotation QA verified · Known legacy CDN cache limitation · Release confirmation pending

New academic downloads use a current-session checked byte proxy. The database migration and exact Edge source are applied to the intended demo project; matching Student/Teacher web callers and client tests are implemented. This does **not** establish that every previously cached raw URL or older signed capability has been invalidated. The owner’s authoritative UI at 00:22 IST confirms the replacement Storage URL key is Active and the previous key is Revoked. The credential handoff is complete. Post-rotation QA is complete: the protected proxy passes and the known legacy warmed-response replay remains observable. Main/Vercel release confirmation must be recorded separately before founder acceptance.

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

## Function deployment note

There is no project-wide function config scaffold in this repository. Deploy this handler with its explicit gateway setting from the repository root:

```sh
npx supabase functions deploy private-academic-file --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

Replace the project-ref placeholder with the intended project. This function-specific flag disables the gateway JWT precheck; the handler still requires a Bearer JWT and forwards it to PostgREST for signature validation and the live database session/resource grant before and after fetching bytes. It does not grant anonymous file access. The fixed privileged object fetch occurs only between those caller-authorized checks. Recheck the authenticated byte path and retained-token logout denial after redeploying. The flag is documented in the current [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-functions-deploy).

## Engineering evidence

- Whole web suite: **2,089 tests / 150 files**. Separate focused database/recovery rerun: **110 passed**. The aligned hosted-ledger filename/replay follow-up: **73 passed**. These reruns overlap the whole suite and are not additional unique test totals.
- TypeScript, Deno checking, scoped/full lint and the optimized Next build pass. Client file/UI regression coverage verifies source-ID payloads, generic authorization errors, no direct Storage fallback, bounds, safe local filenames and cancellation of a previous account’s late response.
- Actual hosted SDK QA: **34 checks**, exact original-byte comparisons across **five authorized role contexts and all three source kinds**, including the actual web read helper and permitted pending upload/discard, with **11/11 owned Auth sessions closed** and **zero SMS/email/FCM sends**. This is SDK plus DOM/component evidence, not an observed native or browser file-download walkthrough.
- Final post-rotation read-only QA: **9 checks pass**. Student, Guardian and assigned Teacher proxy calls plus the actual web read helper return exact original bytes. All three retained clients are denied after logout; **3/3 owned sessions close**. These checks supplement the earlier run; no provider channel is activated.
- The three original objects retain their metadata, versions and paths; provider last-access bookkeeping is excluded. All original **13 logs /30 activities /5 submissions /4 materials** remain unchanged. The permitted new QA log/activity bring log/activity totals to **14/31**. Global **1,307 attendance /18 student fees /16 payments /34 guardian links** are unchanged; no historical attachment or protected row was reset to make the flow pass.
- Advisor counts retain the prior baseline: **41 INFO**, with existing warning-group counts **7 mutable search path /2 anonymous access /6 authenticated access /1 leaked-password protection**. This phase adds no new finding and does not declare those existing warnings resolved.
- Assignment-revocation during file authorization is covered in the local database regressions. It was **not** tested by mutating a live teaching assignment.

## Confirmed legacy CDN cache limitation

A temporary maintenance purge probe against the two fixed protected buckets returned **403** on the Free plan. The normal proxy was restored immediately; the deployed function has no maintenance path. No successful purge is claimed.

After rotation/revocation, all **four exact held warmed raw-object URLs still returned 200 / Cloudflare HIT** with their previously authorized request context. Fresh unique-nonce origin requests were denied with **400**. This is a completed replay check with a known residual CDN cache result, not an unperformed test. The captured 120-second signed test had already expired before the old-key revocation and was denied afterward. Its denial cannot be attributed to revocation and does not prove every older cached capability is gone.

The owner’s authoritative UI confirms the replacement key is Active and the previous key is Revoked; the credential handoff is complete. That key-status proof and the completed post-rotation replay are recorded separately: the proxy denies retained sessions, while the four previously warmed raw responses still replay from the CDN. Do not infer that every previously cached raw or signed response disappeared, or claim that old signed URLs remain origin-valid, from a key-status screenshot alone. Do not claim immediate global revocation of previously cached raw bytes. Cache-window elimination remains an external/provider lifetime boundary before making that claim; the current engineering tests and owner handoff are complete. No paid-plan upgrade or successful purge is claimed. [Provider explanation of private Storage cache behavior](https://supabase.com/kb/troubleshooting/storage-private-bucket-files-still-accessible-after-remove-access-or-logout).

Engineering records now confirm the replacement-Active / previous-Revoked owner UI, the completed post-rotation proxy/logout checks, and the four residual CDN HITs. The captured signed test expired before revocation, so its denial is not counted as proof of key revocation’s effect. Private evidence retains the exact probe contexts; none are published here.

- [ ] Record the checked `main` revision, Ready Vercel deployment and observed stable-alias browser readback of the updated Student/Teacher buttons.

The [founder checklist](https://kids-corner-erp-frontend.vercel.app/qa/private-file-checklist.md) remains entirely unticked until manually observed on that release.

The release readback above is the remaining engineering verification step. The known legacy CDN limitation remains explicit. This milestone does not certify complete commercial ERP readiness, native original downloads, provider delivery or managed-service disaster recovery.
