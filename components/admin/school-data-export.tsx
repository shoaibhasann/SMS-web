import Link from "next/link";
import { Download, ShieldCheck } from "lucide-react";
import { mfaPath } from "@/lib/auth/staff-mfa";

const action = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-semibold transition hover:bg-[var(--surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2";

export function SchoolDataExport({ school }: { school: { id: string; name: string } }) {
  return (
    <details className="card min-w-0" aria-labelledby="school-data-export-heading">
      <summary className="cursor-pointer px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-2">
        <span id="school-data-export-heading" className="inline-flex items-center gap-2 align-middle font-semibold">
          <Download size={18} aria-hidden="true" />Export school data
        </span>
      </summary>
      <div className="space-y-3 border-t border-[var(--border)] p-5">
        <p className="break-words text-sm leading-6 muted">
          Download the records and available attachments for <strong>{school.name}</strong> as a compressed archive.
          School Admin access and an authenticator-verified session are required.
        </p>
        <div className="flex flex-wrap gap-2">
          <a className={action} href={`/api/school-data/export?school=${encodeURIComponent(school.id)}`} target="_blank" rel="noopener noreferrer">
            <Download size={16} aria-hidden="true" />Download archive
          </a>
          <Link href={`${mfaPath("/modules/settings")}&stepup=1`} className={action} prefetch={false}>
            <ShieldCheck size={16} aria-hidden="true" />Verify authenticator
          </Link>
        </div>
        <p className="text-xs leading-5 muted">
          This download contains sensitive school records. Open the archive and check manifest.json for counts and unavailable files.
          For an exit handover, pause edits while exporting and confirm the archive before closing the school account.
        </p>
      </div>
    </details>
  );
}
