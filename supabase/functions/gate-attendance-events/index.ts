type Environment = { url: string; secretKey: string };
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const headers = { 'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reasons = new Set(['marked_present', 'marked_late', 'already_marked', 'earlier_in_applied', 'recorded_out',
  'unknown_subject', 'historical_date', 'future_clock', 'non_working_day', 'student_inactive', 'enrollment_unavailable',
  'roster_date_conflict', 'approved_leave', 'reviewed_attendance', 'manual_or_changed_mark']);
const statuses = new Set(['present', 'absent', 'late', 'half_day', 'leave', 'holiday']);

function failure(status: number): Response {
  const error = status === 401 ? 'Device authorization required.' : status === 400 ? 'Invalid gate event.'
    : status === 405 ? 'Use POST.' : status === 409 ? 'Event ID already used with a different payload.'
      : status === 429 ? 'Device event limit reached. Retry the same event later.'
        : 'Event outcome unconfirmed. Retry the exact same event ID and payload.';
  return Response.json({ error }, { status, headers: { ...headers, ...(status === 405 ? { Allow: 'POST' } : {}),
    ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}

async function boundedText(source: Request | Response, timeout: number): Promise<string> {
  const length = source.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) {
    void source.body?.cancel().catch(() => undefined);
    throw new Error('Body size');
  }
  const reader = source.body?.getReader();
  if (!reader) throw new Error('Body missing');
  const bytes = new Uint8Array(4096); let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
      if (size + value.byteLength > bytes.length) throw new Error('Body size');
      bytes.set(value, size); size += value.byteLength;
    }
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('Body timeout')); void reader.cancel().catch(() => undefined); }, timeout);
    })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number.isFinite(Date.parse(value));
}

/** Machine credentials resolve school/pupil scope inside the atomic SQL capability. */
export async function gateAttendanceEvent(request: Request, environment: Environment, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'POST') return failure(405);
  const credential = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') ?? '');
  if (!credential || !uuid(credential[1])) return failure(401);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) return failure(400);
  let event: Record<string, unknown>;
  try {
    event = record(JSON.parse(await boundedText(request, 1000)));
    if (Object.keys(event).length !== 4 || !identifier(event.eventId) || !identifier(event.subjectId)
      || (event.direction !== 'IN' && event.direction !== 'OUT') || !timestamp(event.occurredAt)) return failure(400);
  } catch { return failure(400); }
  try {
    const url = new URL(environment.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !environment.secretKey) return failure(503);
    const response = await fetcher(`${url.origin}/rest/v1/rpc/ingest_gate_attendance_event`, {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
      headers: { apikey: environment.secretKey, 'Content-Type': 'application/json',
        ...(!environment.secretKey.startsWith('sb_secret_') ? { Authorization: `Bearer ${environment.secretKey}` } : {}) },
      body: JSON.stringify({ p_device_id: credential[1], p_secret: credential[2], p_event_id: event.eventId,
        p_subject_id: event.subjectId, p_direction: event.direction, p_occurred_at: event.occurredAt }),
    });
    const data = record(JSON.parse(await boundedText(response, 1000)));
    if (!response.ok) return failure(data.code === '42501' ? 401 : ['22023', '22007', '22008', '22P02'].includes(String(data.code)) ? 400
      : data.code === 'PT409' ? 409 : data.code === 'PT429' ? 429 : 503);
    if (!uuid(data.receipt_id) || data.event_id !== event.eventId || (data.status !== 'accepted' && data.status !== 'held_review')
      || typeof data.reason !== 'string' || !reasons.has(data.reason) || typeof data.duplicate !== 'boolean'
      || !(data.attendance_id === null || uuid(data.attendance_id))
      || !(data.attendance_status === null || (typeof data.attendance_status === 'string' && statuses.has(data.attendance_status)))
      || (data.attendance_id === null) !== (data.attendance_status === null)) return failure(503);
    return Response.json({ receipt_id: data.receipt_id, event_id: data.event_id, status: data.status, reason: data.reason,
      attendance_id: data.attendance_id, attendance_status: data.attendance_status, duplicate: data.duplicate }, { headers });
  } catch { return failure(503); }
}

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): unknown };
if (typeof Deno !== 'undefined') {
  let secret = '';
  try { secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? ''; } catch { /* Hosted legacy keys remain supported. */ }
  Deno.serve(request => gateAttendanceEvent(request, { url: Deno.env.get('SUPABASE_URL') ?? '',
    secretKey: secret || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '' }));
}
