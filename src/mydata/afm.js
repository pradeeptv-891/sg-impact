/**
 * Greek ΑΦΜ (tax id) handling (FR-MAP-07).
 *
 * An ΑΦΜ is 9 digits. The last digit is a check digit:
 *   sum(d[i] × 2^(8−i)) for i = 0..7, then mod 11, then mod 10.
 */

/** Strips spaces, dots and an EL/GR prefix. Returns '' for empty input. */
export function cleanAfm(value) {
  if (value === null || value === undefined) return '';
  return String(value).toUpperCase().replace(/[\s.\-]/g, '').replace(/^(EL|GR)/, '');
}

export function isValidAfm(value) {
  const afm = cleanAfm(value);
  if (!/^\d{9}$/.test(afm) || afm === '000000000') return false;

  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += Number(afm[i]) * 2 ** (8 - i);
  }
  return (sum % 11) % 10 === Number(afm[8]);
}
