import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

export const schoolExportPageSize = 1000;
const filePrefetch = 4;
const fileBuckets = new Set(["homework-submissions", "study-materials", "school-assets", "student-documents", "report-cards"]);
const datasetName = /^[a-z][a-z0-9_]{0,62}$/;
type Row = Record<string, unknown>;
type ReadPage = (dataset: string, after: Row | null) => Promise<unknown>;
type ReadFile = (bucket: string, path: string) => Promise<ReadableStream<Uint8Array> | null>;
type ExportDataset = { name: string; keys: string[] };
type ArchiveEntry = { name: string; size: number; bytes: Uint8Array | ReadableStream<Uint8Array> };

function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length > schoolExportPageSize || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Unexpected school export data.");
  }
  return value;
}

export function exportDatasets(value: unknown): ExportDataset[] {
  const datasets = rows(value).map(({ name, order_key: key }) => ({ name, keys: typeof key === "string" ? key.split(",") : [""] }));
  const names = datasets.map(({ name }) => name);
  if (names.some((name) => typeof name !== "string" || !datasetName.test(name) || name === "manifest")
      || datasets.some(({ keys }) => keys.some((key) => !datasetName.test(key)))
      || new Set(names).size !== names.length || !names.includes("schools") || !names.includes("files")) {
    throw new Error("Unexpected school export manifest.");
  }
  return datasets as ExportDataset[];
}

function entry(name: string, text: string): ArchiveEntry {
  const bytes = Buffer.from(text);
  return { name, size: bytes.byteLength, bytes };
}

function fileReference(row: Row, schoolId: string) {
  const { bucket, path, byte_size: size } = row;
  if (typeof bucket !== "string" || !fileBuckets.has(bucket) || typeof path !== "string" || path.length > 1024
      || path.split("/")[0] !== schoolId || !path.includes("/")
      || path.split("/").some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/.test(part))
      || (size !== null && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > 0o77777777777))) {
    throw new Error("Unexpected school file reference.");
  }
  return { bucket, path, size };
}

async function* exportEntries(schoolId: string, datasets: ExportDataset[], readPage: ReadPage, readFile: ReadFile, signal: AbortSignal): AsyncGenerator<ArchiveEntry> {
  const startedAt = new Date().toISOString();
  const counts: Record<string, number> = Object.create(null);
  let copiedFiles = 0;
  let missingFiles = 0;
  yield entry("README.txt", [
    "SMS school data export",
    "data/ contains UTF-8 JSON Lines. Join datasets using the exported record IDs.",
    "data/files/ maps records to the binary entries under files/. A missing path is recorded with a reason.",
    "Review manifest.json after extraction. If it is missing or complete is false, the export has gaps.",
    "This is a live export. Records added or removed while it runs (for example automatic gate scans) may be absent; run it outside school hours with staff changes paused.",
    "This archive contains private school data. Store and transfer it securely.",
    "",
  ].join("\n"));
  for (const { name: dataset, keys } of datasets) {
    let after: Row | null = null;
    let batch = 0;
    let count = 0;
    while (true) {
      signal.throwIfAborted();
      const page = rows(await readPage(dataset, after));
      const exported: Row[] = [];
      if (dataset === "files") {
        const refs = page.map((row) => fileReference(row, schoolId));
        // Bounded prefetch: up to four attachment fetches in flight, written to the tar in order.
        const pending: Promise<ReadableStream<Uint8Array> | null>[] = [];
        const start = (index: number) => {
          if (index >= refs.length || index < pending.length) return;
          const { bucket, path, size } = refs[index];
          pending[index] = size === null ? Promise.resolve(null) : readFile(bucket, path);
          pending[index].catch(() => undefined);
        };
        let index = 0;
        let handedOff = 0;
        try {
          for (; index < page.length; index++) {
            signal.throwIfAborted();
            for (let next = index; next < index + filePrefetch; next++) start(next);
            const { path, size } = refs[index];
            const bytes = await pending[index];
            if (!bytes || size === null) {
              missingFiles++;
              exported.push({ ...page[index], archive_path: null, reason: "Storage object unavailable" });
              continue;
            }
            const suffix = /\.[a-z0-9]{1,10}$/i.exec(path)?.[0] ?? "";
            const name = `files/${++copiedFiles}${suffix}`;
            handedOff = index + 1; // the tar writer owns (and cancels) bodies it has received
            yield { name, size, bytes };
            exported.push({ ...page[index], archive_path: name });
          }
        } finally {
          // Release prefetched bodies the tar never read (abort or an earlier failure).
          for (const body of pending.slice(handedOff)) body?.then((stream) => stream?.cancel(), () => undefined);
        }
      }
      const contents = dataset === "files" ? exported : page;
      if (contents.length || batch === 0) {
        yield entry(`data/${dataset}/${String(++batch).padStart(6, "0")}.jsonl`, contents.map((row) => JSON.stringify(row) + "\n").join(""));
      }
      count += page.length;
      if (page.length < schoolExportPageSize) break;
      // The SQL reads only the order-key fields, so wide rows are not posted back.
      const last = page[page.length - 1];
      after = Object.fromEntries(keys.map((key) => [key, last[key]]));
    }
    counts[dataset] = count;
  }
  signal.throwIfAborted();
  const unavailableFiles = counts.unavailable_files ?? 0;
  yield entry("manifest.json", JSON.stringify({
    format_version: 1, school_id: schoolId, started_at: startedAt, finished_at: new Date().toISOString(),
    datasets: counts, copied_files: copiedFiles, missing_files: missingFiles, unavailable_references: unavailableFiles,
    complete: missingFiles + unavailableFiles === 0,
  }, null, 2) + "\n");
}

function tarHeader(name: string, size: number) {
  // POSIX ustar, with bounded ASCII member names generated by the exporter.
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(size.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0" + "00", 257);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  return header;
}

async function* tar(entries: AsyncIterable<ArchiveEntry>, signal: AbortSignal) {
  for await (const { name, size, bytes } of entries) {
    // Take the body before any check or yield so an abort at either still cancels it.
    const reader = bytes instanceof Uint8Array ? null : bytes.getReader();
    try {
      signal.throwIfAborted();
      yield tarHeader(name, size);
      if (!reader) yield bytes as Uint8Array;
      else {
        let written = 0;
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          written += value.byteLength;
          if (written > size) throw new Error("School file size changed during export.");
          yield value;
        }
        if (written !== size) throw new Error("School file size changed during export.");
      }
    } finally {
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    const padding = (512 - size % 512) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

export function schoolArchive(schoolId: string, datasets: ExportDataset[], readPage: ReadPage, readFile: ReadFile, signal: AbortSignal) {
  const input = Readable.from(tar(exportEntries(schoolId, datasets, readPage, readFile, signal), signal), { objectMode: false, signal });
  const gzip = createGzip();
  input.on("error", (error) => gzip.destroy(error));
  gzip.on("close", () => input.destroy());
  return Readable.toWeb(input.pipe(gzip)) as ReadableStream<Uint8Array>;
}
