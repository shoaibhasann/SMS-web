import { createHmac } from "node:crypto";
import { isIP } from "node:net";

// Only Vercel's own header is trusted, and only as a single address; any other forwarding header is caller-controlled.
export function vercelClientIp(request: Request) {
  if (process.env.VERCEL !== "1") return null;
  const value = request.headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  return isIP(value) ? value : null;
}

// One IPv6 client usually controls a whole /64, so it is one rate-limit bucket; IPv4-mapped IPv6 counts as its IPv4.
function rateLimitAddress(ip: string) {
  if (isIP(ip) !== 6) return ip;
  const host = new URL(`http://[${ip}]`).hostname.slice(1, -1); // canonical: lowercase, compressed, hex-only
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) return [mapped[1], mapped[2]].flatMap((part) => [parseInt(part, 16) >> 8, parseInt(part, 16) & 255]).join(".");
  const [head, tail] = host.split("::").map((part) => (part ? part.split(":") : []));
  const groups = tail ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

// Keyed so the stored digest cannot be reversed by hashing every address.
export function rateLimitIpHash(key: Buffer | string, purpose: string, ip: string) {
  return createHmac("sha256", key).update(`${purpose}:${rateLimitAddress(ip)}`).digest("hex");
}

export function smsHookKey() {
  const secret = process.env.SUPABASE_SMS_HOOK_SECRET?.match(/^(?:v1,)?whsec_([A-Za-z0-9+/]+={0,2})$/)?.[1];
  const key = secret ? Buffer.from(secret, "base64") : null;
  return key && key.length >= 24 && key.length <= 64 && key.toString("base64") === secret ? key : null;
}
