// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateAcademicFile } from '@/supabase/functions/private-academic-file/index';

const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const environment = { url: 'https://school.supabase.co', publishableKey: 'sb_publishable_test', secretKey: 'sb_secret_server-only-test' };
const token = 'Bearer signed.native.session';
const bytes = new TextEncoder().encode('%PDF-1.7\nPrivate school answer\n%%EOF');
const grant = { user_id: id(1), school_id: id(2), kind: 'submission', id: id(3), bucket: 'homework-submissions',
  path: [id(2), id(4), id(5), id(6), id(7), id(8), id(9), `${id(10)}.pdf`].join('/'),
  file_name: 'answer.pdf', content_type: 'application/pdf', byte_size: bytes.byteLength, version: 'a'.repeat(64) };
function request(body: unknown = { kind: 'submission', id: id(3) }, options: RequestInit = {}) {
  return new Request('https://school.supabase.co/functions/v1/private-academic-file', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
}
function fixture() {
  let checks = 0;
  const state = { before: grant as Record<string, unknown>, after: grant as Record<string, unknown>, denyBefore: 0, denyAfter: 0,
    file: bytes as Uint8Array<ArrayBuffer>, declared: String(bytes.byteLength), fileStatus: 200 };
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input).includes('/rest/v1/rpc/')) {
      checks++; const status = checks === 1 ? state.denyBefore : state.denyAfter;
      return status ? Response.json({ error: 'Private SQL must not escape' }, { status }) : Response.json(checks === 1 ? state.before : state.after);
    }
    return new Response(state.file, { status: state.fileStatus, headers: { 'Content-Type': 'application/pdf', 'Content-Length': state.declared } });
  });
  return { state, fetcher, run: (req = request(), env = environment) => privateAcademicFile(req, env, fetcher) };
}
afterEach(() => vi.useRealTimers());

describe('private academic binary proxy', () => {
  it('checks caller grants twice and fetches only the exact fixed project object with a server key', async () => {
    const f = fixture(), response = await f.run();
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    const [[before, first], [object, privileged], [after, last]] = f.fetcher.mock.calls;
    expect(before).toBe(`${environment.url}/rest/v1/rpc/authorize_private_academic_file`); expect(after).toBe(before);
    expect(JSON.parse(String(first?.body))).toEqual({ p_kind: 'submission', p_id: id(3) });
    expect(first?.headers).toEqual(expect.objectContaining({ apikey: environment.publishableKey, Authorization: token }));
    expect(last?.headers).toEqual(first?.headers);
    expect(String(object)).toMatch(new RegExp(`^${environment.url}/storage/v1/object/homework-submissions/`));
    expect(String(object)).toContain('?cacheNonce='); expect(String(object)).not.toContain('signed.native.session');
    expect(privileged?.headers).toEqual({ apikey: environment.secretKey, 'Cache-Control': 'no-store' });
    for (const [, options] of f.fetcher.mock.calls) expect(options).toEqual(expect.objectContaining({ redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream'); expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''answer.pdf"); expect(response.headers.get('Location')).toBeNull();
    expect([...response.headers.entries()].flat().join(' ')).not.toContain(environment.secretKey);
  });
  it('supports a legacy server JWT only on the privileged object fetch', async () => {
    const f = fixture(); await f.run(request(), { ...environment, secretKey: 'legacy.service.role' });
    expect(f.fetcher.mock.calls[1][1]?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer legacy.service.role' }));
    expect(f.fetcher.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Authorization: token }));
  });
  it.each(['', 'Bearer sb_publishable_public', 'Bearer malformed', `${token}, extra`])('rejects a missing/non-JWT authorization header %s before any upstream access', async Authorization => {
    const f = fixture(), response = await f.run(request(undefined, { headers: { Authorization, 'Content-Type': 'application/json' } }));
    expect(response.status).toBe(401); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'submission', id: '../another-file' }, { kind: 'submission', id: id(3), path: grant.path }, { kind: 'bucket', id: id(3) }, { kind: 'submission', id: id(3), url: 'https://attacker.test' }, [], null])('rejects malformed input without a path/URL fetching surface: %j', async body => {
    const f = fixture(); expect((await f.run(request(body))).status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('bounds input bytes without trusting Content-Length and times out a slow body', async () => {
    const f = fixture(); expect((await f.run(request({ kind: 'submission', id: id(3), junk: 'x'.repeat(300) }))).status).toBe(400);
    vi.useFakeTimers(); const stream = new ReadableStream<Uint8Array>({ start() {} });
    const pending = f.run(new Request('https://school.supabase.co/functions/v1/private-academic-file', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit));
    await vi.advanceTimersByTimeAsync(1001); expect((await pending).status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])('does not use server credentials after the first grant rejects with %s', async status => {
    const f = fixture(); f.state.denyBefore = status; const response = await f.run();
    expect(response.status).toBe(status === 401 ? 401 : status === 500 ? 503 : 404); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain('Private SQL'); expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
  it.each([{ user_id: 'bad' }, { school_id: id(99) }, { kind: 'material' }, { id: id(99) }, { bucket: 'avatars' }, { path: 'https://attacker.test/private.pdf' },
    { path: `${id(2)}/../private.pdf` }, { path: `${id(2)}/%2e%2e/private.pdf` }, { byte_size: 0 }, { byte_size: 10 * 1024 * 1024 + 1 }, { byte_size: 1.5 }, { version: 'unverified' }, { content_type: 'text/html' }])('rejects incoherent trusted-boundary grants %j before using the server credential', async patch => {
    const f = fixture(); f.state.before = { ...grant, ...patch }; expect((await f.run()).status).toBe(503); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ version: 'b'.repeat(64) }, { user_id: id(99) }, { file_name: 'changed.pdf' }])('discards fetched bytes if the grant/source/session changes %j', async patch => {
    const f = fixture(); f.state.after = { ...grant, ...patch }; const response = await f.run(); expect(response.status).toBe(404); expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.text()).not.toContain('Private school answer');
  });
  it('does not return bytes when logout or role/link revocation happens while the object is fetched', async () => {
    const f = fixture(); f.state.denyAfter = 403; const response = await f.run(); expect(response.status).toBe(404); expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(await response.text()).not.toContain('%PDF');
  });
  it.each(['999999999', 'not-a-size', '0'])('rejects excessive/incoherent upstream lengths %s', async length => {
    const f = fixture(); f.state.declared = length; if (length === '0') f.state.file = new Uint8Array();
    expect((await f.run()).status).toBe(503); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('also bounds chunked bytes when the upstream lies about its length and rejects forged file signatures', async () => {
    const f = fixture(); f.state.declared = '1'; f.state.file = new Uint8Array(bytes.byteLength + 1); expect((await f.run()).status).toBe(503);
    const forged = fixture(); forged.state.file = new Uint8Array(bytes.byteLength); expect((await forged.run()).status).toBe(503);
  });
  it('does not follow upstream redirects or expose backend bodies', async () => {
    const f = fixture(); f.state.fileStatus = 302; const response = await f.run(); expect(response.status).toBe(503); expect(await response.text()).not.toContain('%PDF');
    expect(f.fetcher.mock.calls[1][1]?.redirect).toBe('error');
  });
  it('returns safe binary attachments for legacy text and unknown material formats without inline execution', async () => {
    for (const content_type of ['text/plain', 'application/octet-stream']) {
      const f = fixture(); const material = { ...grant, kind: 'material', bucket: 'study-materials', content_type, file_name: 'unsafe.html\r\nheader', path: `${id(2)}/shared/${id(10)}.txt` };
      f.state.before = material; f.state.after = material;
      const response = await f.run(request({ kind: 'material', id: id(3) })); expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream'); expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
      expect(response.headers.get('Content-Disposition')).not.toContain('\r'); expect(response.headers.get('Content-Disposition')).toMatch(content_type === 'text/plain' ? /\.txt$/ : /\.bin$/);
    }
  });
  it('fails closed for missing configuration, cancellation and unsupported methods, with public noncredentialed preflight', async () => {
    const f = fixture(); expect((await f.run(request(), { ...environment, secretKey: '' })).status).toBe(503); expect(f.fetcher).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(); expect((await f.run(request(undefined, { signal: controller.signal }))).status).toBe(499);
    expect((await f.run(new Request('https://school.test', { method: 'GET' }))).status).toBe(405);
    const preflight = await f.run(new Request('https://school.test', { method: 'OPTIONS' })); expect(preflight.status).toBe(204); expect(preflight.headers.has('Access-Control-Allow-Credentials')).toBe(false);
  });
});
