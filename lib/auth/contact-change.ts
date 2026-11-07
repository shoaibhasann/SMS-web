import { createServerClient } from "@supabase/ssr";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { allowedRecoveryOrigin } from "./recovery";

const maxAge = 15 * 60;
const flowIdPattern = /^[a-zA-Z0-9_-]{8,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ContactBinding = { userId: string; email: string; sessionId: string; issuedAt: number };

export function sameOriginContactPost(request: Request) {
  const url = new URL(request.url);
  return allowedRecoveryOrigin(url) && request.headers.get("origin") === url.origin
    && request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json" ? url.origin : null;
}

/** Contact PKCE never writes ordinary application cookies or persists copied primary tokens. */
export async function createContactChangeClient(secure: boolean, binding?: ContactBinding) {
  const store = await cookies(), prefix = secure ? "__Host-kc-contact" : "kc-contact";
  const options = { path: "/", httpOnly: true, sameSite: "lax" as const, secure, maxAge };
  const issued = new Set<string>();
  const flowKey = (flowId: string) => `${prefix}-flow-${flowId}-context`;
  const ownCookie = (name: string) => name === prefix || name.startsWith(`${prefix}.`) || name.startsWith(`${prefix}-`);
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { ...options, name: prefix },
    cookies: {
      getAll: () => store.getAll().filter(({ name }) => ownCookie(name) && name.endsWith("-code-verifier")),
      setAll: (changes) => {
        for (const { name, value, options: changed } of changes) {
          if (!ownCookie(name) || !name.endsWith("-code-verifier")) continue;
          if (binding && issued.has(name) && changed.maxAge === 0) continue;
          store.set(name, value, { ...options, maxAge: changed.maxAge === 0 ? 0 : maxAge });
          if (binding && changed.maxAge !== 0) {
            issued.add(name);
            const flowId = name.slice(`${prefix}-flow-`.length, -"-code-verifier".length);
            if (name.startsWith(`${prefix}-flow-`) && flowIdPattern.test(flowId)) {
              store.set(flowKey(flowId), Buffer.from(JSON.stringify(binding)).toString("base64url"), options);
            }
          }
        }
      },
    },
  });
  function readBinding(flowId: string): ContactBinding | null {
    if (!flowIdPattern.test(flowId)) return null;
    try {
      const value = JSON.parse(Buffer.from(store.get(flowKey(flowId))?.value ?? "", "base64url").toString());
      const now = Math.floor(Date.now() / 1000);
      if (typeof value?.userId !== "string" || !uuid.test(value.userId) || typeof value?.email !== "string" || value.email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) || typeof value?.sessionId !== "string" || !uuid.test(value.sessionId)
        || !Number.isInteger(value.issuedAt) || value.issuedAt > now + 60 || value.issuedAt < now - maxAge) return null;
      return value;
    } catch { return null; }
  }
  function clearFlow(flowId: string) {
    if (!flowIdPattern.test(flowId)) return;
    for (const { name } of store.getAll()) {
      if (name === flowKey(flowId) || name === `${prefix}-flow-${flowId}-code-verifier`
        || name === prefix || name.startsWith(`${prefix}.`)) store.set(name, "", { ...options, maxAge: 0 });
    }
  }
  return { supabase, readBinding, clearFlow };
}

export async function requestContactEmail(primary: SupabaseClient, session: Session,
  email: string, origin: string) {
  const claims = await primary.auth.getClaims(session.access_token);
  if (claims.error || claims.data?.claims.sub !== session.user.id || typeof claims.data.claims.session_id !== "string") throw new Error("invalid_owner");
  const contact = await createContactChangeClient(origin.startsWith("https:"), {
    userId: session.user.id, email, sessionId: claims.data.claims.session_id, issuedAt: Math.floor(Date.now() / 1000),
  });
  const copied = await contact.supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (copied.error || copied.data.user?.id !== session.user.id) throw new Error("invalid_owner");
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", "/modules/profile?view=guardian&contact=email");
  const result = await contact.supabase.auth.updateUser({ email }, { emailRedirectTo: callback.href });
  if (result.error) return { error: result.error };
  if (result.data.user?.id !== session.user.id || result.data.user.new_email?.toLowerCase() !== email) throw new Error("unconfirmed");
  return { error: null };
}

/** The binding is routing metadata; only the provider's one-use code + per-flow PKCE verifier proves ownership. */
export async function finishGuardianEmailChange(url: URL, code: string | null): Promise<"email-returned" | "email-pending" | "email-link-error"> {
  if (!allowedRecoveryOrigin(url) || url.searchParams.has("error") || url.searchParams.has("error_code")) return "email-link-error";
  const flowId = url.searchParams.get("sb_flow_id") ?? "";
  const contact = await createContactChangeClient(url.protocol === "https:").catch(() => null);
  if (!contact) return "email-link-error";
  const binding = contact.readBinding(flowId);
  if (!binding) return "email-link-error";
  if (!code?.trim()) return url.searchParams.get("message")?.startsWith("Confirmation link accepted") ? "email-pending" : "email-link-error";
  let exchangedUserId: string | undefined;
  try {
    const result = await contact.supabase.auth.exchangeCodeForSession(code, { flowId });
    exchangedUserId = result.data.user?.id;
    if (result.error || !result.data.session || result.data.user?.id !== binding.userId) return "email-link-error";
    const verified = await contact.supabase.auth.getUser(result.data.session.access_token);
    const user = verified.data.user;
    if (verified.error || user?.id !== binding.userId || user.is_anonymous) return "email-link-error";
    if (user.email_confirmed_at && user.email?.toLowerCase() === binding.email) return "email-returned";
    if (user.new_email?.toLowerCase() === binding.email) return "email-pending";
    return "email-link-error";
  } catch { return "email-link-error"; }
  finally {
    // A provider can return the original native session; never revoke that copied primary session.
    try {
      const claims = await contact.supabase.auth.getClaims();
      const native = claims.data?.claims;
      if (!claims.error && native && exchangedUserId && native.sub === exchangedUserId && typeof native.session_id === "string"
        && native.session_id !== binding.sessionId) await contact.supabase.auth.signOut({ scope: "local" });
    } catch { /* No contact tokens are persisted, even if native cleanup is unavailable. */ }
    contact.clearFlow(flowId);
  }
}
