// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { discardPendingHomeworkFile, downloadHomeworkFile, HOMEWORK_FILE_MAX_BYTES, readHomeworkFile, uploadHomeworkFile, validateHomeworkFile } from "@/lib/homework/files";

const id = (n: number) => `30000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const scope = { schoolId: id(1), academicYearId: id(2), classId: id(3), sectionId: id(4), subjectId: id(5), activityId: id(6), studentId: id(7) };
const path = [...Object.values(scope), `${id(8)}.pdf`].join("/");
const pdf = () => new File(["%PDF-1.4\nQA homework fixture"], "answer.pdf", { type: "application/pdf" });
function client() {
  const upload = vi.fn(async (key: string) => ({ data: { path: key }, error: null }));
  const download = vi.fn(async () => ({ data: new Blob(["private evidence"]), error: null }));
  const remove = vi.fn(async (keys: string[]) => ({ data: keys.map((name) => ({ name })), error: null }));
  const from = vi.fn(() => ({ upload, download, remove }));
  return { client: { storage: { from } } as unknown as SupabaseClient, from, upload, download, remove };
}

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

  it("downloads through fresh authenticated requests and refuses arbitrary URLs or bucket traversal", async () => {
    const fake = client();
    expect(await (await readHomeworkFile(fake.client, path)).text()).toBe("private evidence");
    await readHomeworkFile(fake.client, path);
    const calls = fake.download.mock.calls as unknown as [string, { cacheNonce: string }, { cache: string }][];
    expect(calls[0]).toEqual([path, { cacheNonce: expect.any(String) }, { cache: "no-store", signal: undefined }]);
    expect(calls[0][1].cacheNonce).not.toBe(calls[1][1].cacheNonce);
    await expect(readHomeworkFile(fake.client, `https://example.com/${path}`)).rejects.toThrow(/could not be verified/);
    await expect(readHomeworkFile(fake.client, `../${path}`)).rejects.toThrow();
    expect(fake.download).toHaveBeenCalledTimes(2);
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
    fake.download.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const objectUrl = vi.spyOn(URL, "createObjectURL");
    const controller = new AbortController();
    try {
      const pending = downloadHomeworkFile(fake.client, path, "answer.pdf", controller.signal);
      controller.abort();
      finish({ data: new Blob(["private old-account bytes"]), error: null });
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
