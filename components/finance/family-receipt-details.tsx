import { formatFeeMoney } from "@/lib/finance/fee-batches";
import type { FamilyFeeReceipt } from "@/lib/finance/fee-changes";
import { manualPaymentLabel } from "@/lib/finance/payment-methods";

type Receipt = Pick<FamilyFeeReceipt, "receipt_no" | "paid_at" | "payment_method" | "amount" | "status"
  | "reversed_at" | "net_amount" | "reversal_reference">;
const paidDate = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export function FamilyReceiptDetails({ receipt }: { receipt: Receipt }) {
  return (
    <>
      <dl className="grid grid-cols-2 items-start gap-3 text-sm sm:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr] sm:gap-4">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <dt className="mb-1 text-xs muted">Receipt number</dt>
          <dd className="font-mono text-xs font-semibold [overflow-wrap:anywhere]">{receipt.receipt_no}</dd>
        </div>
        <div>
          <dt className="mb-1 text-xs muted">Paid date</dt>
          <dd>{receipt.paid_at ? <time dateTime={receipt.paid_at}>{paidDate.format(new Date(receipt.paid_at))}</time> : "—"}</dd>
        </div>
        <div>
          <dt className="mb-1 text-xs muted">Method</dt>
          <dd>{manualPaymentLabel(receipt.payment_method)}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1 sm:text-right">
          <dt className="mb-1 text-xs muted">Receipt amount</dt>
          <dd className="text-base font-semibold tabular-nums sm:text-sm">{formatFeeMoney(receipt.amount)}</dd>
        </div>
      </dl>
      {receipt.status === "reversed" && <div className="mt-3 space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
        <p className="font-semibold">Payment entry reversed{receipt.reversed_at ? <> · <time dateTime={receipt.reversed_at}>{paidDate.format(new Date(receipt.reversed_at))} IST</time></> : ""}</p>
        <p className="muted">The original receipt is retained. Effective recorded amount: {receipt.net_amount === null ? "Needs review" : formatFeeMoney(receipt.net_amount)}.</p>
        {receipt.reversal_reference && <p className="break-all text-xs muted">Correction reference · {receipt.reversal_reference}</p>}
        <p className="text-xs muted">This is a correction of the school’s payment record. Refunds are handled separately by the school.</p>
      </div>}
    </>
  );
}
