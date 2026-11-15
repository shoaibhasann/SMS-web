import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Pages that need a signed-in school account. Auth, invite and recovery pages, /auth/*, /api/*, assets and unknown paths never match.
const protectedPage = /^\/(?:dashboard|activate|account\/settings|modules\/[a-z0-9-]+)$/;

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  let signedOut = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    signedOut = !data && !error;
  } catch {
    // Non-Auth failures (e.g. WebCrypto) must not turn every page into a 500; the page's own gate still runs.
  }
  const { pathname, search } = request.nextUrl;
  // Redirect only on a definite "no session": a failed check (network, JWKS, refresh race) falls through to the page's own gate, so it cannot loop.
  if (signedOut && protectedPage.test(pathname)) {
    const login = new URL("/login", request.url);
    // Sign-in lands on /dashboard by default, and /activate is not a page to return to.
    if (pathname !== "/dashboard" && pathname !== "/activate") login.searchParams.set("next", pathname + search);
    const redirect = NextResponse.redirect(login);
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie)); // keep cookie deletions issued by getClaims
    return redirect;
  }
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
