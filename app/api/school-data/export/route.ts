import { exportDatasets, schoolArchive } from "@/lib/school-data/archive";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 300;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const privateHeaders = {
  "Cache-Control": "private, no-store, no-transform",
  "CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const failure = (message: string, status: number) => new Response(message, { status, headers: privateHeaders });

export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return failure("Open the export from SMS School Settings.", 403);
  const schoolId = new URL(request.url).searchParams.get("school");
  if (!schoolId || !uuid.test(schoolId)) return failure("Select a school in School Settings.", 400);

  const client = await createClient();
  let { data: { session } } = await client.auth.getSession();
  // The stream pins one token for up to five minutes, so refresh one that could expire mid-export.
  if (session?.access_token && (session.expires_at ?? 0) * 1000 - Date.now() < 300_000) {
    const refreshed = await client.auth.refreshSession();
    session = refreshed.error ? null : refreshed.data.session;
  }
  if (!session?.access_token) return failure("Sign in to SMS again to export school data.", 401);
  const token = session.access_token;
  const { data: { user }, error: userError } = await client.auth.getUser(token);
  if (userError || !user || user.is_anonymous) return failure("Sign in to SMS again to export school data.", 401);

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(285_000)]);
  const page = (dataset: string, after: Record<string, unknown> | null) => client.rpc("export_school_dataset", {
    p_school_id: schoolId, p_dataset: dataset, p_after: after,
  }).setHeader("Authorization", `Bearer ${token}`).abortSignal(signal);

  try {
    const { data, error } = await page("manifest", null);
    if (error?.code === "42501") return failure("This export requires School Admin access and a verified authenticator for the selected school.", 403);
    if (error) throw error;
    const datasets = exportDatasets(data);
    const origin = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!origin || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(origin) || !secret) throw new Error("Storage export unavailable.");

    const stream = schoolArchive(schoolId, datasets, async (dataset, after) => {
      const result = await page(dataset, after);
      if (result.error) throw new Error("School export page unavailable.");
      return result.data;
    }, async (bucket, path) => {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`${origin}/storage/v1/object/${bucket}/${encoded}?cacheNonce=${crypto.randomUUID()}`, {
        signal, cache: "no-store", redirect: "error",
        headers: { apikey: secret, ...(!secret.startsWith("sb_secret_") ? { Authorization: `Bearer ${secret}` } : {}) },
      });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error("School file unavailable."); }
      return response.body;
    }, signal);

    const date = new Date().toISOString().slice(0, 10);
    return new Response(stream, { headers: {
      ...privateHeaders,
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="sms-school-${schoolId}-${date}.tar.gz"`,
    } });
  } catch {
    return failure("School export could not start. Try again from School Settings.", 503);
  }
}
