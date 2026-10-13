/**
 * Money is handled in integer cents so VAT and totals reconcile exactly (FR-MAP-05).
 */

/** Euros → cents, rounding half away from zero. */
export function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // toFixed(6) strips binary noise such as 1.005 * 100 = 100.49999999999999
  const scaled = Number((n * 100).toFixed(6));
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

export function toEuros(cents) {
  return Math.round(cents) / 100;
}

/** Rounds a cents value that may have fractions (e.g. net × rate). */
export function roundCents(value) {
  const scaled = Number(value.toFixed(6));
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/**
 * Splits `totalCents` across `weights` in proportion, using largest remainder so
 * the parts always add up to the total exactly.
 */
export function allocate(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum === 0) {
    const parts = weights.map(() => 0);
    parts[0] = totalCents;
    return parts;
  }

  const sign = Math.sign(totalCents) || 1;
  const abs = Math.abs(totalCents);
  const exact = weights.map(w => (abs * w) / sum);
  const parts = exact.map(Math.floor);
  let remainder = abs - parts.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let i = 0; remainder > 0; i = (i + 1) % order.length, remainder--) {
    parts[order[i].index] += 1;
  }

  return parts.map(p => p * sign);
}

export function formatEuros(cents) {
  return `€${(cents / 100).toFixed(2)}`;
}
