import { readPages } from "@/lib/attendance/repository";

type Page<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

/** Destructive editors and rankings must never accept an unverified partial set. */
export async function readCompletePages<T extends { id: string }>(
  query: (from: number, to: number) => PromiseLike<Page<T>>,
  description: string,
): Promise<T[]> {
  const seen = new Set<string>();
  let expectedCount: number | undefined;
  const rows = await readPages<T>(async (from, to) => {
    const result = await query(from, to);
    if (result.error) return result;
    const count = result.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${description}: completeness could not be verified. Refresh before continuing.`);
    }
    expectedCount ??= count;
    if (Array.isArray(result.data)) {
      if (result.data.length > to - from + 1) throw new Error(`${description}: an invalid page was returned.`);
      for (const row of result.data) {
        if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id)) {
          throw new Error(`${description}: records changed while loading. Please refresh.`);
        }
        seen.add(row.id);
      }
    }
    return result;
  }, description);
  if (rows.length !== expectedCount) {
    throw new Error(`${description}: the complete set could not be loaded. Please refresh.`);
  }
  return rows;
}
