import type { SupabaseClient } from '@supabase/supabase-js';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentRosterImport } from '@/components/admin/student-roster-import';
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/lib/students/roster', async original => ({ ...await original<typeof import('@/lib/students/roster')>(), importRosterStudents: save }));
const context = { schoolId: 'school-a', academicYearId: 'year-a', classId: 'class-a', sectionId: 'section-a' };
const csv = 'admission_number,first_name,last_name\nQA-ONE,Asha,Singh\n';
const rpc = vi.fn();
const client = {
  rpc, auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
} as unknown as SupabaseClient;
const props = { client, context, ownerUserId: 'owner-a', disabled: false, onBusyChange: vi.fn(), onImported: vi.fn() };
const row = (request_id: string, student_count: number, imported_by_name: string | null, imported_at: string | null) =>
  ({ request_id, student_count, imported_by_name, imported_at });
beforeEach(() => { vi.clearAllMocks(); });

describe('student CSV import history', () => {
  it('lists recent imports with actor and IST time, and marks legacy receipts honestly', async () => {
    rpc.mockResolvedValue({ data: [row('r-1', 12, 'Asha Admin', '2026-11-05T04:30:00Z'), row('r-0', 3, null, null)], error: null });
    render(<StudentRosterImport {...props} />);
    const section = await screen.findByRole('region', { name: 'Recent CSV imports' });
    expect(rpc).toHaveBeenCalledWith('list_roster_imports', { p_school_id: 'school-a' });
    const items = await within(section).findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('12 students');
    expect(items[0]).toHaveTextContent('Asha Admin · 5 Nov 2026, 10:00 am');
    expect(items[1]).toHaveTextContent('3 students');
    expect(items[1]).toHaveTextContent('Unknown · Before import history');
  });

  it('reloads the history after a successful import', async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [row('r-2', 1, 'Asha Admin', '2026-11-05T05:00:00Z')], error: null });
    save.mockResolvedValueOnce(1);
    render(<StudentRosterImport {...props} />);
    expect(await screen.findByText('No student CSV imports for this school.')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Import students from CSV'));
    const file = new File([csv], 'students.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new TextEncoder().encode(csv).buffer) });
    fireEvent.change(screen.getByLabelText('Student CSV file'), { target: { files: [file] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Import 1 student' }));
    expect(await screen.findByText('1 student')).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('shows a non-blocking note when the history cannot be loaded', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    render(<StudentRosterImport {...props} />);
    expect(await screen.findByText('Import history could not be loaded. Reopen this page to retry.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
