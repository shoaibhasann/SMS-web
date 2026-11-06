import type { PGlite } from "@electric-sql/pglite";

export const recoveryIds: Readonly<Record<string, string>>;
export function seedRecoveryData(db: PGlite): Promise<typeof recoveryIds>;
