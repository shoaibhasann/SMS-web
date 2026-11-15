import type { SupabaseClient } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentRosterImport } from '@/components/admin/student-roster-import';
import { RosterWriteError } from '@/lib/students/roster';
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/lib/students/roster', async original => ({ ...await original<typeof import('@/lib/students/roster')>(), importRosterStudents: save }));
const context = { schoolId: 'school-a', academicYearId: 'year-a', classId: 'class-a', sectionId: 'section-a' };
const csv = 'admission_number,first_name,last_name\nQA-ONE,Asha,Singh\n';
let authChanged: (event: string, session: { user: { id: string } } | null) => void;
const unsubscribe = vi.fn();
const client = { auth: { onAuthStateChange: (callback: typeof authChanged) => { authChanged = callback; return { data: { subscription: { unsubscribe } } }; } } } as unknown as SupabaseClient;
function file(bytes: Promise<ArrayBuffer> = Promise.resolve(new TextEncoder().encode(csv).buffer)) {
  const selected = new File([csv], 'students.csv', { type: 'text/csv' });
  Object.defineProperty(selected, 'arrayBuffer', { value: () => bytes }); return selected;
}
async function preview() {
  fireEvent.change(screen.getByLabelText('Student CSV file'), { target: { files: [file()] } });
  await screen.findByText('students.csv · 1 student');
}
beforeEach(() => { vi.clearAllMocks(); });

describe('roster CSV ownership and exact retry', () => {
  it('holds the reviewed preview and school lock across an unknown result, then retries that request', async () => {
    const busy = vi.fn(), imported = vi.fn(), props = { client, context, ownerUserId: 'owner-a', onBusyChange: busy, onImported: imported };
    save.mockRejectedValueOnce(new RosterWriteError('Retry the same preview.')).mockResolvedValueOnce(1);
    const page = render(<StudentRosterImport {...props} disabled={false} />); await preview();
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 student' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry the same preview.');
    expect(screen.getByLabelText('Student CSV file')).toBeDisabled();
    expect(busy.mock.calls).toEqual([[true]]); expect(imported).not.toHaveBeenCalled();
    page.rerender(<StudentRosterImport {...props} disabled />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry same import' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 student imported and enrolled.');
    expect(save.mock.calls[0].slice(0, 4)).toEqual(save.mock.calls[1].slice(0, 4));
    expect(save.mock.calls[0][4]).toMatchObject({ userId: 'owner-a', signal: expect.any(AbortSignal) });
    expect(imported).toHaveBeenCalledOnce(); expect(busy).toHaveBeenLastCalledWith(false);
  });
  it('discards a previous account preview and aborts its late save without notifying the new owner', async () => {
    let finish!: (value: number) => void; save.mockReturnValueOnce(new Promise<number>(resolve => { finish = resolve; }));
    const imported = vi.fn(), busy = vi.fn();
    render(<StudentRosterImport client={client} ownerUserId="owner-a" context={context} disabled={false} onBusyChange={busy} onImported={imported} />); await preview();
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 student' }));
    const signal = save.mock.calls[0][4].signal as AbortSignal;
    act(() => authChanged('SIGNED_IN', { user: { id: 'owner-b' } }));
    expect(signal.aborted).toBe(true); expect(screen.getByRole('alert')).toHaveTextContent('Your account changed');
    expect(screen.queryByText('students.csv · 1 student')).not.toBeInTheDocument();
    await act(async () => finish(1)); expect(imported).not.toHaveBeenCalled();
    expect(screen.queryByText('1 student imported and enrolled.')).not.toBeInTheDocument();
  });
  it('keeps a file read from entering a different class context', async () => {
    let finish!: (value: ArrayBuffer) => void; const pending = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    const props = { client, ownerUserId: 'owner-a', disabled: false, onBusyChange: vi.fn(), onImported: vi.fn() };
    const page = render(<StudentRosterImport {...props} context={context} />);
    fireEvent.change(screen.getByLabelText('Student CSV file'), { target: { files: [file(pending)] } });
    page.rerender(<StudentRosterImport {...props} context={{ ...context, sectionId: 'section-b' }} />);
    await act(async () => finish(new TextEncoder().encode(csv).buffer));
    expect(screen.queryByText('students.csv · 1 student')).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it('allows correcting a confirmed duplicate without reporting an import success', async () => {
    save.mockRejectedValueOnce(new RosterWriteError('Existing admission number.', 'duplicate'));
    const imported = vi.fn(), busy = vi.fn();
    render(<StudentRosterImport client={client} ownerUserId="owner-a" context={context} disabled={false} onBusyChange={busy} onImported={imported} />); await preview();
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 student' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing admission number.');
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText('Student CSV file')).toBeEnabled(); expect(imported).not.toHaveBeenCalled();
  });
});
