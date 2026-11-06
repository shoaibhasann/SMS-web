type Environment = { url: string; publishableKey: string; secretKey: string };
type Kind = 'submission' | 'activity' | 'material';
type Grant = {
  user_id: string; school_id: string; kind: Kind; id: string; bucket: string; path: string;
  file_name: string; content_type: string; byte_size: number; version: string;
};
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, X-Content-Type-Options',
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Surrogate-Control': 'no-store',
  'Vary': 'Authorization',
  'X-Content-Type-Options': 'nosniff',
};
const failure = (status: number) => Response.json({ error: status === 401 ? 'Sign in to your school account.' : status === 400 ? 'Choose a valid school attachment.' : status === 404 ? 'This attachment is unavailable for your current school access.' : 'The attachment could not be checked. Please retry.' }, { status, headers });
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function boundedBytes(response: Response | Request, maximum: number, timeout = 10_000): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body?.cancel(); throw new Error('Size unavailable'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Body unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Size exceeded');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  try { return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Body timed out')); void reader.cancel().catch(() => {}); }, timeout); })]); }
  finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
function checkedGrant(value: unknown, kind: Kind, id: string): Grant {
  const row = record(value);
  if (!uuid(row.user_id) || !uuid(row.school_id) || row.kind !== kind || row.id !== id
    || !['homework-submissions', 'study-materials'].includes(String(row.bucket)) || typeof row.path !== 'string'
    || row.path.length > 600 || row.path.split('/')[0] !== row.school_id || row.path.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/.test(part))
    || typeof row.file_name !== 'string' || !row.file_name.trim() || row.file_name.length > 240
    || !['application/pdf', 'image/jpeg', 'image/png', 'text/plain', 'application/octet-stream'].includes(String(row.content_type))
    || typeof row.byte_size !== 'number' || !Number.isSafeInteger(row.byte_size) || row.byte_size < 1
    || row.byte_size > (row.bucket === 'homework-submissions' ? 10 : 20) * 1024 * 1024
    || typeof row.version !== 'string' || !/^[a-f0-9]{64}$/.test(row.version)) throw new Error('Grant unavailable');
  return { user_id: row.user_id, school_id: row.school_id, kind, id, bucket: row.bucket as string, path: row.path, file_name: row.file_name,
    content_type: row.content_type as string, byte_size: row.byte_size, version: row.version };
}

/** User grants run with the caller JWT; only the fixed, checked object fetch uses a server secret. */
export async function privateAcademicFile(request: Request, environment: Environment, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' } });
  if (request.signal.aborted) return failure(499);
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.length > 8192 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) return failure(401);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(400);
  let input: { kind: Kind; id: string };
  try {
    const body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(request, 256, 1000))));
    if (Object.keys(body).length !== 2 || !['submission', 'activity', 'material'].includes(String(body.kind)) || !uuid(body.id)) return failure(400);
    input = { kind: body.kind as Kind, id: body.id };
  } catch { return failure(400); }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(environment.url) || !environment.publishableKey || !environment.secretKey || environment.publishableKey === environment.secretKey) return failure(503);
  const origin = environment.url.replace(/\/$/, ''), signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const grant = async (): Promise<{ status: number } | { value: Grant }> => {
    const response = await fetcher(`${origin}/rest/v1/rpc/authorize_private_academic_file`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal,
      headers: { apikey: environment.publishableKey, Authorization: authorization, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ p_kind: input.kind, p_id: input.id }),
    });
    if (!response.ok) { await response.body?.cancel(); return { status: [400, 401, 403, 404].includes(response.status) ? response.status === 401 ? 401 : 404 : 503 } as const; }
    return { value: checkedGrant(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 4096))), input.kind, input.id) } as const;
  };
  try {
    const before = await grant();
    if ('status' in before) return failure(before.status);
    if (signal.aborted) return failure(499);
    const allowed = before.value;
    const path = allowed.path.split('/').map(encodeURIComponent).join('/');
    const response = await fetcher(`${origin}/storage/v1/object/${allowed.bucket}/${path}?cacheNonce=${crypto.randomUUID()}`, {
      cache: 'no-store', redirect: 'error', signal,
      headers: { apikey: environment.secretKey, ...(!environment.secretKey.startsWith('sb_secret_') ? { Authorization: `Bearer ${environment.secretKey}` } : {}), 'Cache-Control': 'no-store' },
    });
    if (!response.ok || response.status !== 200) { await response.body?.cancel(); return failure(response.status === 404 ? 404 : 503); }
    const bytes = await boundedBytes(response, allowed.byte_size);
    if (bytes.byteLength !== allowed.byte_size || signal.aborted) return failure(503);
    if (allowed.bucket === 'homework-submissions') {
      const ext = allowed.path.split('.').at(-1), expected = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ['jpg', 'jpeg'].includes(ext ?? '') ? 'image/jpeg' : null;
      const valid = ext === 'pdf' ? String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-' : ext === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!expected || expected !== allowed.content_type || !valid) return failure(503);
    }
    // Recheck the same source, object version and live session after fetching; never stream before authorization completes.
    const after = await grant();
    if ('status' in after) return failure(after.status);
    if (JSON.stringify(after.value) !== JSON.stringify(allowed) || signal.aborted) return failure(404);
    let name = allowed.content_type === 'application/octet-stream' ? 'school-attachment.bin' : allowed.file_name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
    const suffix = ({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt' } as Record<string, string>)[allowed.content_type];
    if (suffix && !name.toLowerCase().endsWith(`.${suffix}`) && !(suffix === 'jpg' && name.toLowerCase().endsWith('.jpeg'))) name += `.${suffix}`;
    const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(bytes.buffer, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="school-attachment"; filename*=UTF-8''${encoded}`, 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch { return failure(request.signal.aborted ? 499 : 503); }
}

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown };
if (typeof Deno !== 'undefined') {
  const key = (name: string, legacy: string) => {
    try { const value = JSON.parse(Deno.env.get(name) ?? '{}').default; if (typeof value === 'string' && value) return value; } catch { /* Legacy keys remain supported by hosted runtimes. */ }
    return Deno.env.get(legacy) ?? '';
  };
  Deno.serve(request => privateAcademicFile(request, { url: Deno.env.get('SUPABASE_URL') ?? '',
    publishableKey: key('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), secretKey: key('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY') }));
}
