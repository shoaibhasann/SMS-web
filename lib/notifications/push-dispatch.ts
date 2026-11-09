import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fcmAccessToken, fcmConfiguration, sendFcmNotification } from "./fcm";

const headers = { "Cache-Control": "no-store" };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function configuration() {
  if (process.env.NATIVE_PUSH_ENABLED !== "true") return null;
  const firebase = fcmConfiguration(), serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const secret = process.env.PUSH_DISPATCH_SECRET;
  if (!firebase || !serviceKey || !secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { firebase, serviceKey, secret, url: url.origin };
  } catch { return null; }
}
function authorized(request: Request) {
  const secret = process.env.PUSH_DISPATCH_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function nativePushStatus() {
  return Response.json({ configured: configuration() !== null, nativeAppRequired: true }, { headers });
}
export async function dispatchNativePush(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const config = configuration();
  if (!config) return Response.json({ error: "Native push delivery is not configured" }, { status: 503, headers });
  const result = { claimed: 0, accepted: 0, retry: 0, invalid_token: 0, failed: 0, suppressed: 0, unconfirmed: 0 };
  try {
    // Verify provider credentials before claiming jobs or starting delivery attempts.
    const accessToken = await fcmAccessToken(config.firebase);
    const client = createClient(config.url, config.serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const response = await client.rpc(name, args).abortSignal(AbortSignal.timeout(2_000));
      if (response.error) throw new Error("Push state unavailable");
      return response.data as unknown;
    };
    const jobs = await rpc("claim_family_push_jobs", { p_batch_id: randomUUID(), p_limit: 20 });
    if (!Array.isArray(jobs) || jobs.length > 20 || jobs.some(job => !uuid(job?.id) || !uuid(job?.lease_id))
      || new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error("Invalid push claim");
    result.claimed = jobs.length;
    const deadline = Date.now() + 40_000;
    for (let offset = 0; offset < jobs.length; offset += 5) {
      await Promise.all(jobs.slice(offset, offset + 5).map(async (job) => {
      if (Date.now() >= deadline) { result.unconfirmed++; return; }
      try {
        const source = await rpc("prepare_family_push_job", { p_job_id: job.id, p_lease_id: job.lease_id });
        if (source === null) { result.suppressed++; return; }
        const prepared = record(source);
        if (prepared.job_id !== job.id || prepared.lease_id !== job.lease_id
          || typeof prepared.device_fid !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(prepared.device_fid)
          || !["android", "ios"].includes(String(prepared.platform)) || !["parent", "student"].includes(String(prepared.recipient_role))
          || !["absence", "result_published", "leave_decision", "exam_schedule", "homework_assigned"].includes(String(prepared.kind)) || !uuid(prepared.event_id)
          || typeof prepared.expires_at !== "string" || !prepared.expires_at.includes("T") || !Number.isFinite(Date.parse(prepared.expires_at))) throw new Error("Invalid prepared push");
        const outcome = await sendFcmNotification(config.firebase, accessToken, {
          device_fid: prepared.device_fid, platform: prepared.platform as "android" | "ios", expires_at: prepared.expires_at,
        });
        const confirmed = await rpc("finish_family_push_job", { p_job_id: job.id, p_lease_id: job.lease_id,
          p_outcome: outcome.outcome, p_code: outcome.code, p_provider_id: outcome.providerId ?? null,
          p_retry_after_seconds: outcome.retryAfterSeconds ?? null });
        if (confirmed !== true) { result.unconfirmed++; return; }
        result[outcome.outcome]++;
      } catch { result.unconfirmed++; }
      }));
    }
    return Response.json(result, { status: result.unconfirmed ? 503 : 200, headers });
  } catch { return Response.json({ error: "Push dispatch could not be confirmed", ...result }, { status: 503, headers }); }
}
