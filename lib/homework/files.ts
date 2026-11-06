import type { SupabaseClient } from "@supabase/supabase-js";

export const HOMEWORK_FILE_BUCKET = "homework-submissions";
export const HOMEWORK_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const HOMEWORK_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png";
export type HomeworkFileScope = {
  schoolId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  subjectId: string;
  activityId: string;
  studentId: string;
};
export type HomeworkAttachment = { path: string; name: string; size: number; mimeType: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mimeTypes: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
const extension = (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "";

export function validateHomeworkFile(file: Pick<File, "name" | "size" | "type">): void {
  const expected = mimeTypes[extension(file.name)];
  if (!expected || file.type && file.type !== expected) throw new Error("Choose a PDF, JPG or PNG file.");
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error("Choose a file that is not empty.");
  if (file.size > HOMEWORK_FILE_MAX_BYTES) throw new Error("Choose a file of 10 MB or less.");
}

function checkPath(path: string) {
  const parts = path.split("/");
  if (parts.length !== 8 || !parts.slice(0, 7).every((part) => uuid.test(part))) throw new Error("This homework attachment could not be verified. Refresh homework to try again.");
  const ending = parts[7].split(".");
  if (ending.length !== 2 || !uuid.test(ending[0]) || !mimeTypes[ending[1].toLowerCase()]) throw new Error("This homework attachment could not be verified. Refresh homework to try again.");
}

function filename(name: string | undefined, path: string) {
  const ext = extension(path);
  const safe = (name ?? "homework").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 160) || "homework";
  return extension(safe) === ext ? safe : `${safe}.${ext}`;
}

async function validateSignature(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ext = extension(file.name);
  const valid = ext === "pdf" ? String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-"
    : ext === "png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw new Error("The file does not match its PDF, JPG or PNG format. Select the original file and try again.");
}

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Homework file action cancelled.", "AbortError");
}

export async function uploadHomeworkFile(client: SupabaseClient, scope: HomeworkFileScope, file: File, signal?: AbortSignal): Promise<HomeworkAttachment> {
  cancelled(signal);
  validateHomeworkFile(file);
  const segments = [scope.schoolId, scope.academicYearId, scope.classId, scope.sectionId, scope.subjectId, scope.activityId, scope.studentId];
  if (!segments.every((part) => uuid.test(part))) throw new Error("Your homework class could not be verified. Refresh homework before uploading.");
  await validateSignature(file);
  cancelled(signal);
  const path = [...segments, `${crypto.randomUUID()}.${extension(file.name)}`].join("/");
  const mimeType = mimeTypes[extension(file.name)];
  const { data, error } = await client.storage.from(HOMEWORK_FILE_BUCKET).upload(path, file, { contentType: mimeType, cacheControl: "0", upsert: false });
  if (error || !data || data.path !== path) throw new Error("The upload did not finish. Keep your file selected and try again, or refresh homework if your access changed.");
  if (signal?.aborted) {
    // The SDK does not expose cancellation for upload. Only an unlinked file
    // may be removed; a racing successful submit remains protected by Storage.
    await client.storage.from(HOMEWORK_FILE_BUCKET).remove([path]).catch(() => undefined);
    cancelled(signal);
  }
  return { path, name: filename(file.name, path), size: file.size, mimeType };
}

export async function readHomeworkFile(client: SupabaseClient, submissionId: string, signal?: AbortSignal): Promise<Blob> {
  if (!uuid.test(submissionId)) throw new Error("This homework attachment could not be verified. Refresh homework to try again.");
  cancelled(signal);
  try {
    const { data, error, response } = await client.functions.invoke<Blob>("private-academic-file", {
      body: { kind: "submission", id: submissionId }, signal,
    });
    cancelled(signal);
    const noStore = response?.headers.get("cache-control")?.toLowerCase().split(",").some((part) => part.trim() === "no-store");
    if (error || !(data instanceof Blob) || data.size < 1 || data.size > HOMEWORK_FILE_MAX_BYTES
      || data.type.split(";")[0].trim().toLowerCase() !== "application/octet-stream" || !noStore || response?.redirected) {
      throw new Error("Unverified attachment response.");
    }
    return data;
  } catch {
    cancelled(signal);
    throw new Error("This attachment is unavailable. Refresh homework to check your access.");
  }
}

export async function downloadHomeworkFile(client: SupabaseClient, submissionId: string, name?: string, signal?: AbortSignal): Promise<void> {
  const blob = await readHomeworkFile(client, submissionId, signal);
  cancelled(signal);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = name && mimeTypes[extension(name)] ? filename(name, name) : "homework-attachment";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function discardPendingHomeworkFile(client: SupabaseClient, path: string): Promise<void> {
  checkPath(path);
  const { data, error } = await client.storage.from(HOMEWORK_FILE_BUCKET).remove([path]);
  if (error || !data?.some((row) => row.name === path || row.name === path.split("/").at(-1))) {
    throw new Error("The attachment could not be removed. Refresh homework before trying again; submitted files stay protected.");
  }
}
