// @vitest-environment node
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { exportDatasets, schoolArchive } from "@/lib/school-data/archive";

const school = "b9a7d887-c9aa-4f27-9c9e-40365238befa";
const path = `${school}/student-homework/answer.pdf`;
const file = { bucket: "homework-submissions", path, source: "activity_submissions", source_id: "example", byte_size: 4 };
const datasets = ["schools", "students", "files", "unavailable_files"];
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
  it("pages school rows, includes real attachment bytes and writes the final manifest", async () => {
    const readFile = vi.fn(async () => new Response("%PDF").body);
    const readPage = vi.fn(async (dataset: string, offset: number) => {
      if (dataset === "students") return Array.from({ length: offset ? 2 : 250 }, (_, i) => ({ id: offset + i }));
      if (dataset === "files") return [file];
      return dataset === "schools" ? [{ id: school }] : [];
    });

    const archive = await unpack(schoolArchive(school, datasets, readPage, readFile, signal));

    expect(readPage).toHaveBeenCalledWith("students", 250);
    expect(readFile).toHaveBeenCalledWith("homework-submissions", path);
    expect(archive.get("files/1.pdf")).toBe("%PDF");
    expect(JSON.parse(archive.get("data/files/000001.jsonl")!)).toMatchObject({ source_id: "example", archive_path: "files/1.pdf" });
    expect(JSON.parse(archive.get("manifest.json")!)).toMatchObject({
      school_id: school, complete: true, copied_files: 1, datasets: { students: 252 },
    });
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
    const foreign = schoolArchive(school, ["files"], async () => [{ ...file, path: "foreign/file.pdf" }], readFile, signal);
    await expect(new Response(foreign).arrayBuffer()).rejects.toThrow("Unexpected school file reference");
    expect(readFile).not.toHaveBeenCalled();
    const truncated = schoolArchive(school, ["files"], async () => [file], readFile, signal);
    await expect(new Response(truncated).arrayBuffer()).rejects.toThrow("School file size changed");
  });

  it("rejects malformed or unsafe dataset names", () => {
    expect(exportDatasets(datasets.map((name) => ({ name })))).toEqual(datasets);
    expect(() => exportDatasets([...datasets, "../auth"].map((name) => ({ name })))).toThrow();
  });
});
