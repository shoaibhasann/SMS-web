import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { admitRosterStudent, importRosterStudents } from '@/lib/students/roster';

const { bound } = vi.hoisted(() => ({ bound: vi.fn() }));
vi.mock('@/lib/auth/staff-mfa', () => ({ boundMfaSession: bound }));
const context = { schoolId: 'school-a', academicYearId: 'year-a', classId: 'class-a', sectionId: 'section-a' };
const fields = { admissionNumber: ' QA-ONE ', firstName: ' Asha ', lastName: ' Singh ' };
const savedId = '10000000-0000-4000-8000-000000000001';
const options = { userId: 'owner-a' };
function client(result: { data: unknown; error: { code: string; message?: string } | null }, settle?: () => void) {
  const query = { setHeader: vi.fn(), abortSignal: vi.fn(async () => { settle?.(); return result; }) };
  query.setHeader.mockReturnValue(query);
  const rpc = vi.fn(() => query);
  return { api: { rpc } as unknown as SupabaseClient, rpc, query };
}
beforeEach(() => { vi.resetAllMocks(); bound.mockResolvedValue({ access_token: 'captured-owner-a', user: { id: 'owner-a' } }); });

describe('owner-bound roster writes', () => {
  it('pins the verified owner token and sends normalized single-admission input', async () => {
    const c = client({ data: savedId, error: null });
    await expect(admitRosterStudent(c.api, context, fields, options)).resolves.toBe(savedId);
    expect(bound).toHaveBeenCalledWith(c.api, 'owner-a', undefined);
    expect(c.query.setHeader).toHaveBeenCalledWith('Authorization', 'Bearer captured-owner-a');
    expect(c.rpc).toHaveBeenCalledWith('admit_roster_student', {
      p_school_id: 'school-a', p_academic_year_id: 'year-a', p_class_id: 'class-a', p_section_id: 'section-a',
      p_admission_no: 'QA-ONE', p_first_name: 'Asha', p_last_name: 'Singh',
    });
  });
  it.each([null, 'different-owner'])('does not send a save without the captured verified session (%s)', async (identity) => {
    const c = client({ data: savedId, error: null });
    if (identity === null) bound.mockResolvedValueOnce(null);
    else bound.mockRejectedValueOnce(new Error('Your account changed.'));
    await expect(admitRosterStudent(c.api, context, fields, options)).rejects.toMatchObject({ code: 'access' });
    expect(c.rpc).not.toHaveBeenCalled();
  });
  it.each([['23505', 'duplicate'], ['42501', 'access'], ['22023', 'validation'], ['XX000', 'unconfirmed']])('classifies %s without treating it as success', async (code, expected) => {
    const c = client({ data: null, error: { code } });
    await expect(admitRosterStudent(c.api, context, fields, options)).rejects.toMatchObject({ code: expected });
  });
  it.each(['', 'not-a-uuid', 1, null])('treats malformed admission receipts as unconfirmed (%s)', async (data) => {
    const c = client({ data, error: null });
    await expect(admitRosterStudent(c.api, context, fields, options)).rejects.toMatchObject({ code: 'unconfirmed' });
  });
  it('does not accept a late success after cancellation', async () => {
    const controller = new AbortController(), c = client({ data: savedId, error: null }, () => controller.abort());
    await expect(admitRosterStudent(c.api, context, fields, { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.query.abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it('uses the same import request and payload across an unknown result retry', async () => {
    const students = [fields], requestId = crypto.randomUUID(), c = client({ data: null, error: { code: '' } });
    await expect(importRosterStudents(c.api, context, requestId, students, options)).rejects.toMatchObject({ code: 'unconfirmed' });
    c.query.abortSignal.mockResolvedValueOnce({ data: 1, error: null });
    await expect(importRosterStudents(c.api, context, requestId, students, options)).resolves.toBe(1);
    expect(c.rpc.mock.calls[0]).toEqual(c.rpc.mock.calls[1]);
    expect(c.query.setHeader).toHaveBeenCalledTimes(2);
  });
  it.each([0, 2, '1', null])('rejects an incomplete or malformed import receipt (%s)', async (data) => {
    const c = client({ data, error: null });
    await expect(importRosterStudents(c.api, context, crypto.randomUUID(), [fields], options)).rejects.toMatchObject({ code: 'unconfirmed' });
  });
  it('keeps a transport failure unconfirmed instead of implying rollback', async () => {
    const c = client({ data: null, error: null }); c.query.abortSignal.mockRejectedValueOnce(new TypeError('network unavailable'));
    await expect(admitRosterStudent(c.api, context, fields, options)).rejects.toMatchObject({ code: 'unconfirmed' });
  });
});
