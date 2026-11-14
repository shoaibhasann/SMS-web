export type AttendanceClassOption = { id: string; label: string; coverage: boolean };

const duty = (coverage: boolean) => coverage ? "Temporary cover" : "Class teacher";

/** The section whose register is open, named with the teacher's duty for it. */
export function AttendanceClassBadge({ label, coverage }: { label: string; coverage: boolean }) {
  return (
    <p className="inline-flex flex-wrap items-center gap-x-2 rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-sm">
      <span className="font-semibold text-blue-700 dark:text-blue-300">{duty(coverage)}</span>
      <span aria-hidden="true" className="muted">·</span>
      <span className="font-bold">{label}</span>
    </p>
  );
}

/** Tap targets for switching registers when a teacher has more than one (own class plus temporary cover). */
export function AttendanceClassPicker({ options, value, disabled = false, onChange }: {
  options: AttendanceClassOption[]; value: string; disabled?: boolean; onChange: (id: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Attendance class" className="flex flex-wrap gap-2">
      {options.map((option) => {
        const checked = option.id === value;
        return (
          <label key={option.id} className={`inline-flex min-h-11 cursor-pointer flex-col justify-center rounded-xl border px-4 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue-600 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${checked
            ? "gradient border-transparent" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]"}`}>
            <input type="radio" name="attendance-class" value={option.id} checked={checked} disabled={disabled}
              onChange={() => onChange(option.id)} className="sr-only" />
            <span className="font-bold">{option.label}</span>
            <span className={`text-xs ${checked ? "text-white/85" : "muted"}`}>{duty(option.coverage)}</span>
          </label>
        );
      })}
    </div>
  );
}
