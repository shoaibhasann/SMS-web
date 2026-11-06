import { readFile } from "node:fs/promises";
import { createStaffScopeDatabase } from "./staff-scope-fixture";

export const activationMigration = new URL("../../supabase/migrations/20261105184942_atomic_student_account_activation.sql", import.meta.url);
export const readStudentActivationSql = () => readFile(activationMigration, "utf8");

/** Real recovered public policies/helpers, plus synthetic Auth payload/JWTs.
 * The recovered activate_student body is unchanged in the 2026-11-06 read-only
 * catalog; this fixture intentionally permits reproducing its missing binding.
 */
export async function createStudentActivationDatabase({ applyMigration = true } = {}) {
  const db = await createStaffScopeDatabase({ includeTeachingRpcs: true, applyGovernance: true, includeGuardianInvitations: true });
  try {
    await db.exec(`alter table auth.users add column deleted_at timestamptz,
      add column phone text, add column phone_confirmed_at timestamptz`);
    const snapshot = JSON.parse(await readFile(new URL("../../supabase/schema-snapshots/2026-11-02/schema-metadata.json", import.meta.url), "utf8")) as {
      routines: { schema: string; name: string; definition: string }[];
    };
    const recovered = snapshot.routines.find((routine) => routine.schema === "public" && routine.name === "activate_student");
    if (!recovered) throw new Error("Recovered student activation is missing.");
    await db.exec(recovered.definition);
    await db.exec(`revoke all on function public.activate_student(text,date,text) from public,anon;
      grant execute on function public.activate_student(text,date,text) to authenticated,service_role`);
    if (applyMigration) await db.exec(await readStudentActivationSql());
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
