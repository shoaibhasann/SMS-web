// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readCompletePages } from "../lib/complete-pages";

const row = (id: number) => ({ id: String(id) });

describe("complete paged reads", () => {
  it("continues through a server cap below the requested page size", async () => {
    const saved = Array.from({ length: 407 }, (_, id) => row(id));
    const offsets: number[] = [];
    const loaded = await readCompletePages(async (from, to) => {
      offsets.push(from);
      return { data: saved.slice(from, Math.min(to + 1, from + 73)), count: saved.length, error: null };
    }, "History");
    expect(loaded).toEqual(saved);
    expect(offsets).toEqual([0, 73, 146, 219, 292, 365]);
  });

  it.each([undefined, null, -1, 1.5, Number.NaN])("rejects unreadable exact count %s", async (count) => {
    await expect(readCompletePages(async () => ({ data: [row(1)], count, error: null }), "History"))
      .rejects.toThrow("completeness could not be verified");
  });

  it("rejects a changing count instead of returning a partial set", async () => {
    await expect(readCompletePages(async (from) => ({
      data: Array.from({ length: from ? 1 : 200 }, (_, id) => row(from + id)), count: from ? 200 : 201, error: null,
    }), "History")).rejects.toThrow("records changed");
  });

  it("rejects a duplicated page caused by ignored ranges or moved records", async () => {
    await expect(readCompletePages(async () => ({ data: [row(1)], count: 2, error: null }), "History"))
      .rejects.toThrow("records changed");
  });

  it("rejects an early empty page and an overfull response", async () => {
    await expect(readCompletePages(async (from) => ({ data: from ? [] : [row(1)], count: 2, error: null }), "History"))
      .rejects.toThrow("full register could not be loaded");
    await expect(readCompletePages(async () => ({ data: [row(1)], count: 0, error: null }), "History"))
      .rejects.toThrow("complete set could not be loaded");
    await expect(readCompletePages(async () => ({ data: Array.from({ length: 201 }, (_, id) => row(id)), count: 201, error: null }), "History"))
      .rejects.toThrow("invalid page");
  });

  it("preserves query failures and accepts a verified empty scope", async () => {
    await expect(readCompletePages(async () => ({ data: null, error: { message: "Access denied" } }), "History"))
      .rejects.toThrow("History: Access denied");
    expect(await readCompletePages(async () => ({ data: [], count: 0, error: null }), "History")).toEqual([]);
  });
});
