import { createClient } from "@supabase/supabase-js";
import { rateLimitIpHash, smsHookKey, vercelClientIp } from "@/lib/auth/client-ip";

export type AuthAttemptAction = "admin_email_request" | "admin_email_verify" | "recovery_request" | "recovery_mfa";

let warned = false;

// Fails open: Supabase's own per-IP limits still apply when the throttle is unavailable. Say so once per process.
function failOpen() {
  if (!warned) {
    warned = true;
    console.warn("[auth-throttle] App-level auth endpoint throttle is inactive (missing configuration, RPC error or timeout); requests are allowed without it.");
  }
  return true;
}

// Server-side Auth calls share this host's egress IP, so per-client limits are enforced here first.
export async function allowAuthAttempt(request: Request, action: AuthAttemptAction, subject: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceKey) return failOpen();
  const ip = vercelClientIp(request);
  try {
    const { data, error } = await createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }).rpc("consume_auth_endpoint_attempt", {
      // Same keyed digest as SMS delivery; the service-role key is the fallback secret when SMS sign-in is not configured.
      p_action: action, p_ip_hash: ip && rateLimitIpHash(smsHookKey() ?? serviceKey, "auth-throttle-ip", ip), p_subject: subject,
    }).abortSignal(AbortSignal.timeout(1_500));
    return error ? failOpen() : data !== false;
  } catch {
    return failOpen();
  }
}
