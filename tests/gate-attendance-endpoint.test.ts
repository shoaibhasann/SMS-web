// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateAttendanceEvent } from '@/supabase/functions/gate-attendance-events/index';

const device = '78000000-0000-4000-8000-000000000001';
const secret = 'a'.repeat(43);
const environment = { url: 'https://school.supabase.co', secretKey: 'sb_secret_private_server_key' };
const event = { eventId: 'unit-boot1:100', subjectId: 'card-01', direction: 'IN', occurredAt: '2026-11-07T08:00:00+05:30' };
const receipt = { receipt_id: '78000000-0000-4000-8000-000000000002', event_id: event.eventId,
  status: 'accepted', reason: 'marked_present', attendance_id: '78000000-0000-4000-8000-000000000003', attendance_status: 'present', duplicate: false };
function request(body: unknown = event, options: RequestInit = {}) {
  return new Request('https://school.supabase.co/functions/v1/gate-attendance-events', { method: 'POST',
    headers: { Authorization: `Bearer ${device}.${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
}
function fixture(data: unknown = receipt, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(data, { status }));
  return { fetcher, run: (req = request(), env = environment) => gateAttendanceEvent(req, env, fetcher) };
}
afterEach(() => vi.useRealTimers());

describe('machine-authenticated gate attendance endpoint', () => {
  it('passes only a scoped machine credential and four event fields to the fixed atomic SQL capability', async () => {
    const f = fixture(), response = await f.run();
    expect(response.status).toBe(200); expect(await response.json()).toEqual(receipt);
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith(`${environment.url}/rest/v1/rpc/ingest_gate_attendance_event`, expect.objectContaining({
      method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { apikey: environment.secretKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_device_id: device, p_secret: secret, p_event_id: event.eventId, p_subject_id: event.subjectId,
        p_direction: event.direction, p_occurred_at: event.occurredAt }),
    }));
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect([...response.headers.entries()].flat().join(' ')).not.toContain(secret);
  });
  it('uses a hosted legacy service JWT only as the server credential, never the connector credential', async () => {
    const f = fixture(); await f.run(request(), { ...environment, secretKey: 'legacy.private.jwt' });
    expect(f.fetcher.mock.calls[0][1]?.headers).toEqual({ apikey: 'legacy.private.jwt', Authorization: 'Bearer legacy.private.jwt', 'Content-Type': 'application/json' });
  });
  it.each(['', 'Bearer student.native.jwt', 'Bearer sb_publishable_123', 'Bearer sb_secret_123', `Bearer ${device}.short`, `Bearer ${device}.${secret},extra`])(
    'rejects user JWTs, API keys and malformed machine credentials before any DB call: %s', async Authorization => {
      const f = fixture(); expect((await f.run(request(event, { headers: { Authorization, 'Content-Type': 'application/json' } }))).status).toBe(401);
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  it('rejects non-POST without consuming a body or touching the database', async () => {
    const f = fixture(), res = await f.run(new Request('https://school.test', { method: 'GET' }));
    expect(res.status).toBe(405); expect(res.headers.get('allow')).toBe('POST'); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([{ ...event, schoolId: device }, { ...event, studentId: device }, { ...event, status: 'present' },
    { ...event, subjectId: '' }, { ...event, subjectId: '../card' }, { ...event, eventId: 'x'.repeat(129) },
    { ...event, direction: 'in' }, { ...event, direction: ['IN'] }, { ...event, direction: 'PRESENT' }, [], null, {}])(
    'rejects undeclared scope, status or malformed event payload: %j', async body => {
      const f = fixture(); expect((await f.run(request(body))).status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
    });
  it.each(['2026-02-30T08:00:00Z', '2026-11-07', '2026-11-07T08:00:00', '2026-11-07T24:00:00Z',
    '2026-11-07T08:00:00+14:01', '0000-11-07T08:00:00Z', '2026-13-07T08:00:00Z', '2026-11-07T08:00:00.1234567Z'])('rejects invalid/ambiguous event time %s', async occurredAt => {
    const f = fixture(); expect((await f.run(request({ ...event, occurredAt }))).status).toBe(400); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['2024-02-29T08:00:00Z', '2026-11-07T08:00:00.123456+05:30', '2026-11-07T08:00:00-04:00'])('preserves a valid explicit-offset timestamp for SQL normalization %s', async occurredAt => {
    const f = fixture(); expect((await f.run(request({ ...event, occurredAt }))).status).toBe(200);
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).p_occurred_at).toBe(occurredAt);
  });
  it.each(['text/plain', 'application/x-www-form-urlencoded', ''])('requires JSON content type %s', async contentType => {
    const f = fixture(); expect((await f.run(request(event, { headers: { Authorization: `Bearer ${device}.${secret}`, 'Content-Type': contentType } }))).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('bounds actual bytes without trusting a lying Content-Length and cancels slow uploads', async () => {
    const f = fixture();
    expect((await f.run(request({ ...event, junk: 'x'.repeat(5000) }, { headers: { Authorization: `Bearer ${device}.${secret}`, 'Content-Type': 'application/json', 'Content-Length': '1' } }))).status).toBe(400);
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel });
    const pending = f.run(new Request('https://school.test', { method: 'POST', headers: { Authorization: `Bearer ${device}.${secret}`, 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit));
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).status).toBe(400); expect(cancel).toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['http://school.supabase.co', 'https://u:pass@school.supabase.co', 'https://school.supabase.co/other', 'https://school.supabase.co/?url=attacker', 'bad-url'])('rejects an unsafe server target %s', async url => {
    const f = fixture(); expect((await f.run(request(), { ...environment, url })).status).toBe(503); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('fails closed when the managed server key is missing', async () => {
    const f = fixture(); expect((await f.run(request(), { ...environment, secretKey: '' })).status).toBe(503); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([['42501', 401], ['22023', 400], ['22007', 400], ['PT409', 409], ['PT429', 429], ['23505', 503], ['XX000', 503]])(
    'maps SQL %s without exposing private error details', async (code, status) => {
      const f = fixture({ code, message: `private-${secret}`, details: environment.secretKey }, 400), res = await f.run();
      expect(res.status).toBe(status); expect(await res.text()).not.toMatch(/private-|sb_secret/);
      if (status === 429) expect(res.headers.get('retry-after')).toBe('60');
    });
  it.each([{ ...receipt, duplicate: true }, { ...receipt, status: 'held_review', reason: 'approved_leave', attendance_id: null, attendance_status: null },
    { ...receipt, reason: 'recorded_out', attendance_id: null, attendance_status: null }])('returns confirmed duplicates, review holds and OUT without claiming an unmade attendance mark', async data => {
    const f = fixture(data); const res = await f.run(request({ ...event, direction: data.reason === 'recorded_out' ? 'OUT' : 'IN' }));
    expect(res.status).toBe(200); expect(await res.json()).toEqual(data);
  });
  it.each([{ receipt_id: 'bad' }, { event_id: 'wrong-event' }, { status: ['accepted'] }, { duplicate: 'yes' }, { reason: 'secret-error' },
    { attendance_status: ['present'] }, { attendance_id: null }, { attendance_status: 'unknown' }])('treats malformed upstream receipts as unconfirmed: %j', async patch => {
    const f = fixture({ ...receipt, ...patch }); const res = await f.run(); expect(res.status).toBe(503); expect(await res.text()).toContain('exact same event ID');
  });
  it('strips unexpected upstream receipt fields and returns no credentials', async () => {
    const f = fixture({ ...receipt, secret, privateKey: environment.secretKey }); const res = await f.run();
    expect(await res.json()).toEqual(receipt);
  });
  it('never reports success when the SQL commit may have happened but the response was lost', async () => {
    const f = fixture(); f.fetcher.mockRejectedValue(new Error(`private-${secret}`)); const res = await f.run();
    expect(res.status).toBe(503); const text = await res.text(); expect(text).toContain('exact same event ID'); expect(text).not.toContain(secret);
  });
  it('bounds upstream response bytes, redirects and unreadable responses', async () => {
    const f = fixture();
    for (const result of [new Response('x'.repeat(5000)), new Response('not-json'), Response.json(receipt, { headers: { 'Content-Length': '999999' } })]) {
      f.fetcher.mockResolvedValueOnce(result); expect((await f.run()).status).toBe(503);
    }
    f.fetcher.mockRejectedValueOnce(new TypeError('Redirect not allowed')); expect((await f.run()).status).toBe(503);
  });
});
