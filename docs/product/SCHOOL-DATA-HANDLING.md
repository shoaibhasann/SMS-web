# School data onboarding, export and handling

## Import and exit handover

- School Settings groups existing UTF-8 CSV templates for academic setup, roster, staff, assignments, guardian invites, historical calendar and opening fee balances. Preview and reconcile each selected school's batch before committing. Historical marks, historical attendance records, receipt ledgers, detailed profiles and document migration require field mapping and a supervised migration.
- A School Admin with a current authenticator-verified session can download a school archive from School Settings. It contains versioned JSON Lines datasets, the original bytes of matched private attachments, an attachment index and a manifest with row counts and unavailable references. Keep passwords, authentication factors, tokens, provider secrets and delivery infrastructure outside the handover.
- Agree an export window before revoking school access. Pause writes during the live paginated export. Check `manifest.json`, counts and a representative set of student records, payments and attachments before accepting the handover. Use a supervised export for unusually large or incomplete archives. The archive is a portability copy and has no automatic import back into SMS.
- After access closes, deliver any agreed repeat export through an authenticated handover to a school-authorized contact. Agree the export window, retention dates, legal holds and deletion evidence in writing before onboarding.

## Proposed school agreement terms

- The school retains control over the school records it supplies. Where the school determines the processing purpose, SMS processes that data on documented instructions to provide, support, secure and migrate the service. Specify the data categories, purpose, access and school responsibilities in the data-processing addendum. Exclude sale, advertising use and model training.
- Restrict production access to authorized people on a need-to-know basis. Use scoped school roles, tenant checks, authenticator verification for bulk export, private attachment buckets and HTTPS. Review access on staff departures and log administrative export attempts. Exchange downloads through a secure channel with verified recipients.
- Record the approved subprocessors and their purpose. The hosted PostgreSQL project is in Mumbai. Document actual hosting and transfer locations for app compute, email and notification providers before agreeing to residency terms.
- Report confirmed incidents affecting school records to the school's named contact without undue delay. Provide known scope, containment steps and updates. Agree incident contacts, notice timing and each party's regulatory responsibilities.
- Document separate encrypted backups for database records and attachment bytes, with restricted access and restore drills. Agree retention, recovery objectives and deletion deadlines after measuring an actual restore. Supabase database backups cover attachment metadata. Attachment bytes need their own backup.
- Include an agreed return and deletion window, handling for lawful retention, backup expiry, and written confirmation when deletion is complete. Offboarding deletion and backup retention are operational procedures.

Review the agreement for the applicable Indian DPDP commencement dates, children's data requirements and the school's statutory record-retention obligations before signing.

[Digital Personal Data Protection Act, 2023](https://www.meity.gov.in/static/uploads/2024/02/Digital-Personal-Data-Protection-Act-2023.pdf) · [Digital Personal Data Protection Rules, 2025](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) · [Supabase database backup coverage](https://supabase.com/docs/guides/platform/backups)

## School-side QA

- [ ] In School Settings, select a QA school and open Import school data. Download the Students template, preview a CSV with one duplicate admission number, and confirm the invalid batch creates no students. Fix the duplicate, import the batch, and reload the directory for the selected year, class and section.
- [ ] From the same school, follow the opening fee balances shortcut and verify the selected tenant and ledger after refresh.
- [ ] As a School Admin, verify your authenticator. Download the archive, open it locally, and compare the school ID, roster and attendance counts, payment rows, and one private attachment against the school records.
- [ ] Review `manifest.json` and the attachment index. Reconcile any missing files and retain the confirmed archive before closing access.
- [ ] Verify that a Principal, Teacher, Student, Guardian, an Admin from another school, and an Admin session without authenticator verification cannot download the archive.
