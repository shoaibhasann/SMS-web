import { createClient as createAuthClient, type SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { allowAuthAttempt } from "@/lib/auth/attempt-throttle";
import { allowedRecoveryOrigin } from "@/lib/auth/recovery";
import { readStaffMfaStatus } from "@/lib/auth/staff-mfa";
import { createClient } from "@/lib/supabase/server";

const headers = { "Cache-Control": "no-store" };
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function reply(status: number) {
  return Response.json({ ok: status === 200 }, { status, headers });
}

async function recordVerifiedEmailSession(auth: SupabaseClient, service: SupabaseClient, userId: string, accessToken: string) {
  try {
    const { data, error } = await auth.auth.getClaims(accessToken);
    const claims = data?.claims;
    if (!error && claims?.sub === userId && claims.aal === "aal1" && claims.session_id) {
      await service.rpc("allow_school_admin_email_otp_dashboard", { p_user_id: userId, p_session_id: claims.session_id });
    }
  } catch {
    // The ordinary authenticator challenge remains available if the optional dashboard grant cannot be recorded.
  }
}

export async function POST(request: Request) {
  const origin = process.env.ADMIN_EMAIL_OTP_ORIGIN;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return reply(403);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.NEXT_PUBLIC_ADMIN_EMAIL_OTP_ENABLED !== "true" || !origin || !url || !publishableKey || !serviceKey) {
    return reply(503);
  }
  const parsedOrigin = URL.parse(origin);
  if (!parsedOrigin || parsedOrigin.origin !== origin || !allowedRecoveryOrigin(parsedOrigin)) return reply(503);
  if (request.headers.get("origin") !== origin) return reply(403);

  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > 1024) return reply(400);
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400); }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400);
  if (body.action !== "request" && (body.action !== "verify" || typeof body.code !== "string" || !/^\d{6,10}$/.test(body.code))) {
    return reply(400);
  }
  if (!await allowAuthAttempt(request, body.action === "request" ? "admin_email_request" : "admin_email_verify", email)) return reply(429);
  const auth = createAuthClient(url, publishableKey, clientOptions);
  const service = createAuthClient(url, serviceKey, clientOptions);

  if (body.action === "request") {
    // Respond before the private lookup to avoid exposing whether the address belongs to an admin.
    after(async () => {
      try {
        const { data, error } = await service.rpc("find_admin_email_otp_user", { p_email: email });
        if (!error && typeof data === "string") {
          await auth.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        }
      } catch {
        // Keep the same response for unknown addresses and provider errors.
      }
    });
    return reply(200);
  }

  let verified = false;
  let installed = false;
  try {
    const browser = await createClient();
    const current = await browser.auth.getSession();
    if (current.error || current.data.session) {
      const { error } = await browser.auth.signOut({ scope: "local" });
      if (error) return reply(503);
    }
    const { data, error } = await auth.auth.verifyOtp({ email, token: body.code, type: "email" });
    if (error) return reply(error.status === 429 ? 429 : 401);
    if (!data.session) return reply(401);
    verified = true;
    const userId = data.user?.id;
    if (!userId || data.session.user.id !== userId || data.user?.email?.toLowerCase() !== email) return reply(401);
    const [eligible, security] = await Promise.all([
      service.rpc("find_admin_email_otp_user", { p_email: email }),
      readStaffMfaStatus(auth, userId),
    ]);
    if (eligible.error) return reply(503);
    if (eligible.data !== userId || security?.action !== "challenge" || security.current_aal !== "aal1") {
      return reply(401);
    }

    await recordVerifiedEmailSession(auth, service, userId, data.session.access_token);
    const session = await browser.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    installed = !session.error && session.data.user?.id === userId;
    return reply(installed ? 200 : 503);
  } catch {
    return reply(503);
  } finally {
    if (verified && !installed) await auth.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
}
