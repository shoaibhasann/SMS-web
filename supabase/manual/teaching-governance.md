# Apply teaching-assignment governance

Locally verified and reviewed, ready for manual application. All 250 distinct tests pass (248 combined regression cases plus two dedicated verifier/trigger-drift cases), along with TypeScript, scoped lint and production build. All 26 checks pass in the local database fixture. This guide does not report a remote migration or deployed frontend. The user confirms that the project contains test/demo data and that both preceding permission patches were applied successfully.

## Prerequisites

Before this patch, `verify-role-permissions.sql` must return all 15 flags true, and `verify-staff-school-scope.sql` must return all 20 flags true. Those are the preceding role-assignment and staff school-scope contracts. Apply the governance migration only after the frontend assignment flow and database tests pass together.

Use the same test project's SQL Editor with its trusted owner context. Review the complete `supabase/migrations/20261102170543_govern_teacher_assignments.sql`; keep both earlier migrations in place.

## Expected behavior

Administrators and principals manage teaching assignments only for schools they administer. Existing global super administrators retain their authorized school selection. Teachers can read their own approved assignments and use the work access those assignments provide; they cannot assign themselves classes or class-teacher duties.

The local frontend's existing Teaching Assignments entry uses real school records. Select an authorized school, choose its teacher, class, section and subject, then save. The current academic year must be unambiguous. A changed or inaccessible row does not produce a success message. Teachers reach a read-only view with a clear handoff to their administrator or principal when assignments are missing.

The database contract must reject direct API attempts that bypass these controls. Assignment references must agree on school, and a section must belong to the selected class. Protected teacher/profile/master identity changes require a separate reviewed maintenance path. Registration keeps its public function signature while checking current teacher authority and approved scope.

## Apply and verify

1. Run the **complete** governance migration, including its transaction and postconditions. If it fails, retain the exact error and review incompatible schema, data, grants, policies or custom triggers. Run `ROLLBACK;` if the editor session remains in a failed transaction. Do not execute selected fragments to bypass a failed preflight.
2. After a successful commit, run the complete `supabase/manual/verify-teaching-governance.sql`. It returns **26 rows**. Every `passes` value must be `true`.
3. Record the boolean results or error. The verifier reads catalog metadata and selects no pupil, teacher, role-membership or other application rows.
4. Confirm the matching frontend behavior in the test environment: an administrator/principal assigns an existing teacher; that teacher reads the assignment and uses the permitted academic/attendance flow; teacher self-assignment and cross-school manager writes fail.

The earlier staff verifier's exact policy/source contract is intentionally superseded by this governance patch. Run the new governance verifier after this patch. A later failure of an intentionally replaced staff-policy fingerprint is not an instruction to reapply an older patch over governance. The first role verifier's 15 checks should still pass.

## Remaining limits

- Local fixtures use PGlite PostgreSQL 18.6; the recovered Supabase snapshot is PostgreSQL 17.11. Catalog checks do not establish a live multi-user Supabase/Auth test or prove complete tenant safety.
- Existing global unique class-teacher indexes remain stricter than the year-scoped indexes. They can block a duty in a new year. Do not drop them or promise successful rollover as part of this patch.
- Student registration still needs an idempotency contract. A retry after an uncertain response can create another pupil; inspect the class register before retrying. This patch does not claim to make registration exactly once.
- Existing profile/master data and role grants need review. The patch does not repair historical inconsistent records, complete staff onboarding, or turn browser demo setup into database records.
- Other tenant ALL policies, family/audience rules, fee integrity, activation and storage remain separate work. Restrict real-school onboarding until those remaining access and integrity risks are resolved.
