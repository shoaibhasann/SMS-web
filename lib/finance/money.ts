/** INR is stored as decimal strings at API boundaries and integer paise in calculations. */
export type Money = string;

export function normalizeMoney(value: unknown): Money {
  const input = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof input !== "string" || !/^-?\d{1,24}(?:\.\d{1,2})?$/.test(input)) {
    throw new RangeError("Enter a finite INR amount with up to two decimal places.");
  }
  const negative = input.startsWith("-");
  const [whole, fraction = ""] = input.replace(/^-/, "").split(".");
  const paise = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return fromPaise(negative ? -paise : paise);
}

export function toPaise(value: Money | number): bigint {
  const canonical = normalizeMoney(value);
  return BigInt(canonical.replace(".", ""));
}

export function fromPaise(value: bigint): Money {
  const negative = value < BigInt(0), absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

const rupees = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
export function formatMoney(value: Money | number): string {
  const canonical = normalizeMoney(value), negative = canonical.startsWith("-");
  const [whole, fraction] = canonical.replace(/^-/, "").split(".");
  return `${negative ? "−" : ""}₹${rupees.format(BigInt(whole))}.${fraction}`;
}

export function positiveMoney(value: string): Money {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new RangeError("Enter a positive INR amount with up to two decimal places.");
  const amount = normalizeMoney(value);
  if (toPaise(amount) <= BigInt(0)) throw new RangeError("Enter an amount greater than zero.");
  return amount;
}
