import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const localRecoveryCookie = "kc-recovery";
const secureRecoveryCookie = "__Host-kc-recovery";
export const recoveryDestination = "/update-password";
export const recoveryFailureDestination = "/forgot-password?error=invalid_recovery";
const recoveryAgeSeconds = 15 * 60;

export async function createRecoveryClient(secure?: boolean, requesting = false) {
  const store = await cookies();
  const secured = secure ?? (process.env.NODE_ENV === "production" || store.getAll().some(({ name }) =>
    name === secureRecoveryCookie || name.startsWith(secureRecoveryCookie + ".")));
  const recoveryCookieName = secured ? secureRecoveryCookie : localRecoveryCookie;
  const issuedVerifiers = new Set<string>();
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: secured };
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: { ...cookieOptions, name: recoveryCookieName },
      cookies: {
        getAll: () => store.getAll().filter(({ name }) => name === recoveryCookieName
          || name.startsWith(recoveryCookieName + ".") || name.startsWith(recoveryCookieName + "-")),
        setAll: (changes) => {
          for (const { name, value, options } of changes) {
            const verifier = name.endsWith("-code-verifier");
            // A provider error can delete or rewrite the newly issued verifier.
            // Keep the same response cookies for valid email submissions.
            if (requesting && verifier && issuedVerifiers.has(name)) continue;
            if (requesting && verifier && options.maxAge !== 0) issuedVerifiers.add(name);
            try {
              store.set(name, value, { ...options, maxAge: options.maxAge === 0 ? 0 : verifier ? 3600 : recoveryAgeSeconds });
            } catch {
              // A server component can read cookies but cannot persist refreshes.
            }
          }
        },
      },
    },
  );

  function clearSession() {
    for (const { name } of store.getAll()) {
      if (name === recoveryCookieName || name.startsWith(recoveryCookieName + ".")) {
        store.set(name, "", { ...cookieOptions, maxAge: 0 });
      }
    }
  }

  return { supabase, clearSession };
}

export function allowedRecoveryOrigin(url: URL) {
  return url.protocol === "https:" || (url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

export function sameOriginRecoveryPost(request: Request) {
  const url = new URL(request.url);
  if (!allowedRecoveryOrigin(url)) return null;
  const origin = url.origin;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return request.headers.get("origin") === origin && contentType === "application/json" ? origin : null;
}

export async function verifiedRecoverySession(supabase: SupabaseClient, token?: string) {
  const { data, error } = await supabase.auth.getClaims(token);
  const claims = data?.claims;
  const now = Math.floor(Date.now() / 1000);
  if (error || !claims || claims.role !== "authenticated" || !claims.sub || !claims.session_id
    || !Array.isArray(claims.amr) || !claims.amr.some((entry) => {
      if (!entry || typeof entry !== "object" || entry.method !== "recovery" || !Number.isInteger(entry.timestamp)) return false;
      return entry.timestamp >= now - recoveryAgeSeconds && entry.timestamp <= now + 60;
    })) return null;

  const user = await supabase.auth.getUser(token);
  if (user.error || user.data.user?.id !== claims.sub || user.data.user.is_anonymous) return null;
  return { sessionId: claims.session_id, userId: claims.sub, accountLabel: user.data.user.email ?? user.data.user.phone ?? "your SMS account" };
}
