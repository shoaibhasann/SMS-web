/** Manual office channels. Online providers will confirm settlements on the server. */
export const manualPaymentMethods = [
  ["cash", "Cash"], ["upi", "UPI"], ["bank_transfer", "Bank transfer"],
  ["card", "Card"], ["cheque", "Cheque"],
] as const;
export type ManualPaymentMethod = (typeof manualPaymentMethods)[number][0];

export function isManualPaymentMethod(value: unknown): value is ManualPaymentMethod {
  return manualPaymentMethods.some(([method]) => method === value);
}

export function manualPaymentLabel(value: string | null): string {
  return manualPaymentMethods.find(([method]) => method === value)?.[1] ?? (value?.replaceAll("_", " ") || "—");
}
