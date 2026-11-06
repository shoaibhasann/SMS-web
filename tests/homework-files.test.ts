// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { discardPendingHomeworkFile, downloadHomeworkFile, HOMEWORK_FILE_MAX_BYTES, readHomeworkFile, uploadHomeworkFile, validateHomeworkFile } from "@/lib/homework/files";

const id = (n: number) => `30000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const scope = { schoolId: id(1), academicYearId: id(2), classId: id(3), sectionId: id(4), subjectId: id(5), activityId: id(6), studentId: id(7) };
const path = [...Object.values(scope), `${id(8)}.pdf`].join("/");
const submissionId = id(9);
const pdf = () => new File(["%PDF-1.4\nQA homework fixture"], "answer.pdf", { type: "application/pdf" });
type Invocation = { data: unknown; error: unknown; response?: Response };
function response(cache = "private, no-store, max-age=0") {
  return new Response(null, { headers: { "content-type": "application/octet-stream", "cache-control": cache } });
}
function client() {
  const upload = vi.fn(async (key: string) => ({ data: { path: key }, error: null }));
  const download = vi.fn();
  const invoke = vi.fn<(name: string, options: Record<string, unknown>) => Promise<Invocation>>().mockResolvedValue({ data: new Blob(["private evidence"], { type: "application/octet-stream" }), error: null, response: response() });
  const remove = vi.fn(async (keys: string[]) => ({ data: keys.map((name) => ({ name })), error: null }));
  const from = vi.fn(() => ({ upload, download, remove }));
  return { client: { functions: { invoke }, storage: { from } } as unknown as SupabaseClient, from, upload, download, remove, invoke };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private homework file client", () => {
  it("rejects empty, oversized or mismatched files and invalid signatures before sending bytes", async () => {
    for (const file of [
      { name: "empty.pdf", size: 0, type: "application/pdf" },
      { name: "large.pdf", size: HOMEWORK_FILE_MAX_BYTES + 1, type: "application/pdf" },
      { name: "page.html", size: 100, type: "text/html" },
      { name: "renamed.pdf", size: 100, type: "image/png" },
    ]) expect(() => validateHomeworkFile(file)).toThrow();
    const fake = client();
    await expect(uploadHomeworkFile(fake.client, scope, new File(["<svg>"], "fake.pdf", { type: "application/pdf" }))).rejects.toThrow(/does not match/);
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it("uses unique immutable assignment paths and no cache for a valid PDF upload", async () => {
    const fake = client();
    const first = await uploadHomeworkFile(fake.client, scope, pdf());
    const second = await uploadHomeworkFile(fake.client, scope, pdf());
    expect(first.path.split("/").slice(0, 7)).toEqual(Object.values(scope));
    expect(first.path).not.toBe(second.path);
    expect(first.name).toBe("answer.pdf");
    expect(fake.from).toHaveBeenCalledWith("homework-submissions");
    expect(fake.upload).toHaveBeenCalledWith(first.path, expect.any(File), { contentType: "application/pdf", cacheControl: "0", upsert: false });
    await expect(uploadHomeworkFile(fake.client, { ...scope, studentId: "../../outside" }, pdf())).rejects.toThrow(/could not be verified/);
    expect(fake.upload).toHaveBeenCalledTimes(2);
  });

  it("accepts original JPEG/PNG signatures and infers an empty browser MIME from a supported extension", async () => {
    const fake = client();
    const png = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "work.PNG");
    expect((await uploadHomeworkFile(fake.client, scope, png)).mimeType).toBe("image/png");
    const jpg = new File([Uint8Array.from([255, 216, 255, 224])], "photo.jpg", { type: "image/jpeg" });
    expect((await uploadHomeworkFile(fake.client, scope, jpg)).mimeType).toBe("image/jpeg");
  });

  it("reads bytes only through the fixed authenticated function using the saved submission ID", async () => {
    const fake = client(), controller = new AbortController();
    expect(await (await readHomeworkFile(fake.client, submissionId, controller.signal)).text()).toBe("private evidence");
    await readHomeworkFile(fake.client, submissionId);
    expect(fake.invoke).toHaveBeenNthCalledWith(1, "private-academic-file", { body: { kind: "submission", id: submissionId }, signal: controller.signal });
    expect(fake.invoke).toHaveBeenNthCalledWith(2, "private-academic-file", { body: { kind: "submission", id: submissionId }, signal: undefined });
    expect(fake.from).not.toHaveBeenCalled(); expect(fake.download).not.toHaveBeenCalled();
    for (const invalid of [path, `https://example.com/${path}`, `../${path}`, "invalid-submission", ""]) await expect(readHomeworkFile(fake.client, invalid)).rejects.toThrow(/could not be verified/);
    expect(fake.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not expose authentication, provider, or transport error details", async () => {
    const fake = client();
    for (const error of [{ code: "42501", message: "private storage path" }, new Error("secret provider detail")]) {
      fake.invoke.mockResolvedValueOnce({ data: null, error, response: response() });
      await expect(readHomeworkFile(fake.client, submissionId)).rejects.toThrow("This attachment is unavailable. Refresh homework to check your access.");
    }
    fake.invoke.mockRejectedValueOnce(new Error("signed URL secret"));
    await expect(readHomeworkFile(fake.client, submissionId)).rejects.toThrow("This attachment is unavailable. Refresh homework to check your access.");
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("rejects URL/JSON/HTML payloads, empty or oversized blobs, redirects, and cacheable responses", async () => {
    const fake = client(), binary = () => new Blob(["private evidence"], { type: "application/octet-stream" });
    const redirected = response(); Object.defineProperty(redirected, "redirected", { value: true });
    const invalid: Invocation[] = [
      { data: "https://example.test/signed-secret", error: null, response: response() },
      { data: { signedUrl: "https://example.test/signed-secret" }, error: null, response: response() },
      { data: { size: 10, type: "application/octet-stream" }, error: null, response: response() },
      { data: new Blob(["<html>sign in</html>"], { type: "text/html" }), error: null, response: response() },
      { data: new Blob([], { type: "application/octet-stream" }), error: null, response: response() },
      { data: new Blob([new Uint8Array(HOMEWORK_FILE_MAX_BYTES + 1)], { type: "application/octet-stream" }), error: null, response: response() },
      { data: binary(), error: null, response: response("public,max-age=3600") },
      { data: binary(), error: null, response: undefined },
      { data: binary(), error: null, response: redirected },
    ];
    for (const reply of invalid) {
      fake.invoke.mockResolvedValueOnce(reply);
      await expect(readHomeworkFile(fake.client, submissionId)).rejects.toThrow("This attachment is unavailable");
    }
    fake.invoke.mockResolvedValueOnce({ data: new Blob([new Uint8Array(HOMEWORK_FILE_MAX_BYTES)], { type: "application/octet-stream" }), error: null, response: response() });
    expect((await readHomeworkFile(fake.client, submissionId)).size).toBe(HOMEWORK_FILE_MAX_BYTES);
  });

  it("honors an already cancelled owner context without calling the function", async () => {
    const fake = client(), controller = new AbortController(); controller.abort();
    await expect(readHomeworkFile(fake.client, submissionId, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.invoke).not.toHaveBeenCalled();
  });

  it("uses only an authorized blob URL and a sanitized local filename hint for browser downloads", async () => {
    const fake = client(), anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn(), schedule = vi.fn();
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { appendChild } });
    vi.stubGlobal("window", { setTimeout: schedule });
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:authorized-homework");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await downloadHomeworkFile(fake.client, submissionId, "../../original?.pdf");
    expect(create).toHaveBeenCalledWith(expect.any(Blob)); expect(anchor.href).toBe("blob:authorized-homework");
    expect(anchor.download).toMatch(/\.pdf$/); expect(anchor.download).not.toMatch(/[\\/?:]/);
    expect(appendChild).toHaveBeenCalledWith(anchor); expect(anchor.click).toHaveBeenCalledOnce(); expect(anchor.remove).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);
    schedule.mock.calls[0][0](); expect(revoke).toHaveBeenCalledWith("blob:authorized-homework");
    await downloadHomeworkFile(fake.client, submissionId, "page.html"); expect(anchor.download).toBe("homework-attachment");
    expect(fake.invoke.mock.calls[0][1].body).toEqual({ kind: "submission", id: submissionId });
  });

  it("does not report zero-row pending cleanup as success", async () => {
    const fake = client();
    fake.remove.mockResolvedValueOnce({ data: [], error: null });
    await expect(discardPendingHomeworkFile(fake.client, path)).rejects.toThrow(/submitted files stay protected/);
    await expect(discardPendingHomeworkFile(fake.client, path)).resolves.toBeUndefined();
  });

  it("does not create a browser download when an old account's late response completes after cancellation", async () => {
    const fake = client();
    let finish!: (result: { data: Blob; error: null }) => void;
    fake.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = (value) => resolve({ ...value, response: response() }); }));
    const objectUrl = vi.spyOn(URL, "createObjectURL");
    const controller = new AbortController();
    try {
      const pending = downloadHomeworkFile(fake.client, submissionId, "answer.pdf", controller.signal);
      controller.abort();
      finish({ data: new Blob(["private old-account bytes"], { type: "application/octet-stream" }), error: null });
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(objectUrl).not.toHaveBeenCalled();
    } finally { objectUrl.mockRestore(); }
  });

  it("ignores a late upload after cancellation and only attempts protected pending cleanup", async () => {
    const fake = client();
    let finish!: (result: { data: { path: string }; error: null }) => void;
    let uploadedKey = "";
    fake.upload.mockImplementationOnce((key: string) => {
      uploadedKey = key;
      return new Promise((resolve) => { finish = resolve; });
    });
    const controller = new AbortController();
    const pending = uploadHomeworkFile(fake.client, scope, pdf(), controller.signal);
    await vi.waitFor(() => expect(fake.upload).toHaveBeenCalled());
    controller.abort();
    finish({ data: { path: uploadedKey }, error: null });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.remove).toHaveBeenCalledWith([uploadedKey]);
  });
});
