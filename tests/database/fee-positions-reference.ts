import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";

const SOURCE = new URL("../../supabase/migrations/20261105170615_office_student_advance_credit.sql", import.meta.url);

/** Rows that app_private.office_fee_positions and the SQL definition it replaced disagree on, over the given calls. */
export async function comparePositionsWithSqlDefinition(db: PGlite, calls: [string, string | null, string | null][]) {
  const sql = await readFile(SOURCE, "utf8");
  const start = sql.indexOf("create or replace function app_private.office_fee_positions(");
  await db.exec(sql.slice(start, sql.indexOf("$$;", start) + 3).replace("office_fee_positions(", "office_fee_positions_sql("));
  let differing = 0, rows = 0;
  for (const call of calls) {
    const { rows: [result] } = await db.query<{ differing: number; rows: number }>(`select
      (select count(*) from (
        (select * from app_private.office_fee_positions($1,$2,$3) except all select * from app_private.office_fee_positions_sql($1,$2,$3))
        union all
        (select * from app_private.office_fee_positions_sql($1,$2,$3) except all select * from app_private.office_fee_positions($1,$2,$3))) d)::int as differing,
      (select count(*) from app_private.office_fee_positions($1,$2,$3))::int as rows`, call);
    differing += result.differing;
    rows += result.rows;
  }
  return { differing, rows };
}
