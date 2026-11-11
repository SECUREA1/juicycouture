export function parseAmount(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Unsupported token precision.");
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text) || text.length > 40) throw new Error("Enter a positive amount using numbers and a decimal point.");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount > 18446744073709551615n) throw new Error("Enter an amount greater than zero and within the token limit.");
  return amount;
}

export function formatAmount(value, decimals) {
  const amount = BigInt(value);
  const factor = 10n ** BigInt(decimals);
  const fraction = (amount % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${amount / factor}${fraction ? `.${fraction}` : ""}`;
}
