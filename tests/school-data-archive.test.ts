// @vitest-environment node
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { exportDatasets, schoolArchive, schoolExportPageSize } from "@/lib/school-data/archive";

const school = "b9a7d887-c9aa-4f27-9c9e-40365238befa";
const path = `${school}/student-homework/answer.pdf`;
const file = { bucket: "homework-submissions", path, source: "activity_submissions", source_id: "example", byte_size: 4 };
const datasets = [
  { name: "schools", keys: ["id"] }, { name: "students", keys: ["id"] },
  { name: "files", keys: ["source", "source_id"] }, { name: "unavailable_files", keys: ["source", "source_id"] },
];
const files = [{ name: "files", keys: ["source", "source_id"] }];
const signal = new AbortController().signal;

async function unpack(stream: ReadableStream<Uint8Array>) {
  const bytes = gunzipSync(Buffer.from(await new Response(stream).arrayBuffer()));
  const files = new Map<string, string>();
  let offset = 0;
  while (bytes[offset] !== 0) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, header.indexOf(0)).toString();
    const size = parseInt(header.subarray(124, 135).toString(), 8);
    expect(header.subarray(257, 263).toString()).toBe("ustar\0");
    files.set(name, bytes.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(bytes.length - offset).toBe(1024);
  return files;
}

describe("school archive", () => {
  it("pages school rows by cursor, includes real attachment bytes and writes the final manifest", async () => {
    const readFile = vi.fn(async () => new Response("%PDF").body);
    const readPage = vi.fn(async (dataset: string, after: Record<string, unknown> | null) => {
      if (dataset === "students") return Array.from({ length: after ? 2 : 1000 }, (_, i) => ({ id: (after ? 1000 : 0) + i, notes: "x".repeat(5000) }));
      if (dataset === "files") return [file];
      return dataset === "schools" ? [{ id: school }] : [];
    });

    const archive = await unpack(schoolArchive(school, datasets, readPage, readFile, signal));

    expect(schoolExportPageSize).toBe(1000);
    expect(readPage.mock.calls.filter(([dataset]) => dataset === "students")).toEqual([["students", null], ["students", { id: 999 }]]);
    expect(readPage).toHaveBeenCalledWith("files", null);
    expect(archive.get("data/students/000001.jsonl")).toContain("x".repeat(5000));
    expect(readFile).toHaveBeenCalledWith("homework-submissions", path);
    expect(archive.get("data/students/000002.jsonl")!.trim().split("\n")).toHaveLength(2);
    expect(archive.get("files/1.pdf")).toBe("%PDF");
    expect(JSON.parse(archive.get("data/files/000001.jsonl")!)).toMatchObject({ source_id: "example", archive_path: "files/1.pdf" });
    expect(JSON.parse(archive.get("manifest.json")!)).toMatchObject({
      school_id: school, complete: true, copied_files: 1, datasets: { students: 1002 },
    });
    expect(archive.get("README.txt")).toContain("run it outside school hours");
  });

  it("prefetches at most four attachments and still writes them in order", async () => {
    const refs = Array.from({ length: 9 }, (_, i) => ({ ...file, source_id: `file-${i}`, path: `${school}/hw/${i}.txt`, byte_size: 1 }));
    let inFlight = 0;
    let peak = 0;
    const readFile = vi.fn(async (_bucket: string, filePath: string) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 9 - Number(/(\d)\.txt$/.exec(filePath)![1])));
      const body = new Response(/(\d)\.txt$/.exec(filePath)![1]).body!;
      const reader = body.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) { inFlight--; controller.close(); } else controller.enqueue(value);
        },
      });
    });
    const archive = await unpack(schoolArchive(school, files, async (_dataset, after) => after ? [] : refs, readFile, signal));
    expect(readFile).toHaveBeenCalledTimes(9);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(refs.map((_, i) => archive.get(`files/${i + 1}.txt`))).toEqual(refs.map((_, i) => String(i)));
  });

  it("fails the archive when a prefetched attachment fails", async () => {
    const refs = Array.from({ length: 3 }, (_, i) => ({ ...file, source_id: `file-${i}`, path: `${school}/hw/${i}.pdf` }));
    const readFile = vi.fn(async (_bucket: string, filePath: string) => {
      if (filePath.endsWith("2.pdf")) throw new Error("School file unavailable.");
      return new Response("%PDF").body;
    });
    const archive = schoolArchive(school, files, async () => refs, readFile, signal);
    await expect(new Response(archive).arrayBuffer()).rejects.toThrow("School file unavailable");
  });

  it("reports missing attachments and unresolved references in the manifest", async () => {
    const archive = await unpack(schoolArchive(school, datasets, async (dataset) => {
      if (dataset === "files") return [file];
      return dataset === "unavailable_files" ? [{ reason: "External link" }] : [];
    }, async () => null, signal));

    expect(JSON.parse(archive.get("manifest.json")!)).toMatchObject({
      complete: false, missing_files: 1, unavailable_references: 1,
    });
  });

  it("fails closed on foreign paths and rejects truncated attachment bodies", async () => {
    const readFile = vi.fn(async () => new Response("%").body);
    const foreign = schoolArchive(school, files, async () => [{ ...file, path: "foreign/file.pdf" }], readFile, signal);
    await expect(new Response(foreign).arrayBuffer()).rejects.toThrow("Unexpected school file reference");
    expect(readFile).not.toHaveBeenCalled();
    const truncated = schoolArchive(school, files, async () => [file], readFile, signal);
    await expect(new Response(truncated).arrayBuffer()).rejects.toThrow("School file size changed");
  });

  it("posts back only the catalogue order-key columns as the next-page cursor", async () => {
    const wide = { result_snapshot: { pupils: Array.from({ length: 50 }, (_, i) => ({ i, marks: "9".repeat(200) })) }, before: { a: 1 } };
    const readPage = vi.fn(async (dataset: string, after: Record<string, unknown> | null) => {
      if (dataset === "gate_attendance_days") {
        return after ? [] : Array.from({ length: 1000 }, (_, i) => ({ student_id: `s-${i}`, attendance_date: "2026-11-11", ...wide }));
      }
      return [];
    });
    await unpack(schoolArchive(school, [
      { name: "gate_attendance_days", keys: ["student_id", "attendance_date"] }, ...files,
    ], readPage, async () => null, signal));
    expect(readPage.mock.calls).toEqual([
      ["gate_attendance_days", null],
      ["gate_attendance_days", { student_id: "s-999", attendance_date: "2026-11-11" }],
      ["files", null],
    ]);
  });

  it("cancels every prefetched attachment the tar never read when the export is aborted", async () => {
    const refs = Array.from({ length: 6 }, (_, i) => ({ ...file, source_id: `file-${i}`, path: `${school}/hw/${i}.pdf` }));
    for (const abortAt of [0, 4]) {
      const controller = new AbortController();
      const cancelled: number[] = [];
      const readFile = vi.fn(async (_bucket: string, filePath: string) => {
        const i = Number(/(\d)\.pdf$/.exec(filePath)![1]);
        if (i === abortAt) controller.abort(new Error("Export cancelled."));
        // abortAt 0: the first file is missing, so the abort is seen at the top of the next iteration.
        if (i === 0 && abortAt === 0) return null;
        let sent = false;
        return new ReadableStream<Uint8Array>({
          pull: (c) => { if (sent) c.close(); else { sent = true; c.enqueue(new TextEncoder().encode("%PDF")); } },
          cancel: () => { cancelled.push(i); },
        });
      });
      const archive = schoolArchive(school, files, async () => refs, readFile, controller.signal);
      await expect(new Response(archive).arrayBuffer()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // abortAt 4: file 0 was fully written; file 1 was handed to the tar writer as the abort landed.
      expect(cancelled.sort()).toEqual(abortAt === 0 ? [1, 2, 3] : [1, 2, 3, 4]);
    }
  });

  it("rejects malformed or unsafe dataset names and order keys", () => {
    const manifest = [
      { name: "files", order_key: "source,source_id" }, { name: "schools", order_key: "id" },
    ];
    expect(exportDatasets(manifest)).toEqual([
      { name: "files", keys: ["source", "source_id"] }, { name: "schools", keys: ["id"] },
    ]);
    expect(() => exportDatasets([...manifest, { name: "../auth", order_key: "id" }])).toThrow();
    for (const order_key of [undefined, "", "id,", "id) or (true", 1]) {
      expect(() => exportDatasets([...manifest, { name: "students", order_key }])).toThrow();
    }
  });
});
