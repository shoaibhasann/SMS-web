import type { NextConfig } from "next";

function supabaseOrigin() {
  try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin; } catch { return "https://*.supabase.co"; }
}

const supabase = supabaseOrigin();
const turnstile = "https://challenges.cloudflare.com";

// Full policy is Report-Only until browser reports confirm nothing legitimate is blocked; frame-ancestors is enforced
// separately because browsers ignore it inside a Report-Only policy.
const reportOnlyCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${turnstile}${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabase}`,
  "font-src 'self'",
  `connect-src 'self' ${supabase}`,
  `frame-src ${turnstile}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
        ],
      },
      { source: "/qa/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};
export default nextConfig;
