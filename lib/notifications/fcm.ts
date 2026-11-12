import "server-only";

import { createPrivateKey } from "node:crypto";
import { JWT } from "google-auth-library";

export type FcmConfiguration = { projectId: string; email: string; privateKey: string };
export type PushSendResult = {
  outcome: "accepted" | "retry" | "invalid_token" | "failed";
  code: string; providerId?: string; retryAfterSeconds?: number;
};

export function fcmConfiguration(): FcmConfiguration | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.length > 16_384) return null;
  try {
    const value = JSON.parse(raw);
    if (value.type !== "service_account" || typeof value.project_id !== "string"
      || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.project_id)
      || typeof value.client_email !== "string" || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(value.client_email)
      || typeof value.private_key !== "string" || !value.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) return null;
    const key = createPrivateKey(value.private_key);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    return { projectId: value.project_id, email: value.client_email, privateKey: value.private_key };
  } catch { return null; }
}

export async function fcmAccessToken(config: FcmConfiguration): Promise<string> {
  const client = new JWT({ email: config.email, key: config.privateKey,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
    transporterOptions: { timeout: 5_000, retry: false } });
  const result = await client.getAccessToken();
  if (typeof result.token !== "string" || !result.token || result.token.length > 8_192 || /[\r\n]/.test(result.token)) throw new Error("Push provider authentication unavailable");
  return result.token;
}

function retryAfter(value: string | null) {
  if (!value || value.length > 100) return 60;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1_000);
  return Number.isFinite(seconds) ? Math.max(60, Math.min(86_400, seconds)) : 60;
}

async function responseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > 16_384) throw new Error("Oversized push response");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing push response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) throw new Error("Oversized push response");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { void reader.cancel().catch(() => undefined); }
}

export async function sendFcmNotification(config: FcmConfiguration, accessToken: string,
  job: { device_fid: string; platform: "android" | "ios"; kind: string; expires_at: string }): Promise<PushSendResult> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(job.device_fid) || !["android", "ios"].includes(job.platform)) throw new Error("Invalid prepared push device");
  const remaining = Math.floor((Date.parse(job.expires_at) - Date.now()) / 1_000);
  if (!Number.isFinite(remaining) || remaining <= 0) return { outcome: "failed", code: "EXPIRED" };
  // Keep the alert for phones that reconnect within the job lifetime; a future gate kind must cap this at 2 h.
  const ttl = Math.min(86_400, remaining);
  // Due-today fee reminders are daytime nudges, not urgent alerts.
  const urgent = job.kind !== "fee_due";
  try {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        fid: job.device_fid,
        notification: { title: "SMS school update", body: "Open SMS to view your school updates." },
        // A dispatch can race revocation; resolve private records only after app sign-in.
        data: { screen: "notifications" },
        // Reminders use the app's low-importance "sms-reminders" Android channel and play no APNs sound.
        ...(job.platform === "android" ? { android: { priority: urgent ? "high" : "normal", ttl: `${ttl}s`, collapse_key: "sms-school-updates", notification: { tag: "sms-school-updates", ...(urgent ? {} : { channel_id: "sms-reminders" }) } } }
          : { apns: { headers: { "apns-priority": urgent ? "10" : "5", "apns-push-type": "alert", "apns-expiration": String(Math.floor(Date.now() / 1_000) + ttl), "apns-collapse-id": "sms-school-updates" }, ...(urgent ? { payload: { aps: { sound: "default" } } } : {}) } }),
      } }), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 429 || response.status >= 500) {
      void response.body?.cancel().catch(() => undefined);
      return { outcome: "retry", code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE", retryAfterSeconds: retryAfter(response.headers.get("retry-after")) };
    }
    const data = await responseJson(response) as { name?: unknown; error?: { details?: unknown } };
    if (response.ok) {
      return typeof data?.name === "string" && new RegExp(`^projects/${config.projectId}/messages/[A-Za-z0-9%:_~.+=-]+$`).test(data.name) && data.name.length <= 300
        ? { outcome: "accepted", code: "FCM_ACCEPTED", providerId: data.name }
        : { outcome: "retry", code: "UNKNOWN_RESPONSE", retryAfterSeconds: 60 };
    }
    const unregistered = Array.isArray(data?.error?.details) && data.error.details.some((value: unknown) => {
      const item = value as Record<string, unknown> | null;
      return item?.["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" && item.errorCode === "UNREGISTERED";
    });
    if (response.status === 404 && unregistered) return { outcome: "invalid_token", code: "UNREGISTERED" };
    if (response.status === 401 || response.status === 403) return { outcome: "retry", code: "PROVIDER_AUTH", retryAfterSeconds: 3_600 };
    return { outcome: "failed", code: "PROVIDER_REJECTED" };
  } catch { return { outcome: "retry", code: "NETWORK_OR_RESPONSE_ERROR", retryAfterSeconds: 60 }; }
}
