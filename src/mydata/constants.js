/**
 * myDATA code lists that are fixed by AADE rather than chosen by the accountant.
 */

// VAT rate (%) → myDATA vatCategory code
export const VAT_CATEGORY_BY_RATE = {
  24: 1,
  13: 2,
  6: 3,
  17: 4,
  9: 5,
  4: 6,
  3: 9,
};

// Category 7 = 0% (needs an exemption reason); 8 = entries without VAT
export const VAT_EXEMPT_CATEGORY = 7;
export const NO_VAT_CATEGORY = 8;

export const RATE_BY_VAT_CATEGORY = {
  1: 24, 2: 13, 3: 6, 4: 17, 5: 9, 6: 4, 7: 0, 8: 0, 9: 3,
};

export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

// Storeganise sometimes stores country names rather than ISO codes
export const COUNTRY_ALIASES = {
  GREECE: 'GR', 'ΕΛΛΑΔΑ': 'GR', 'ΕΛΛΑΣ': 'GR', HELLAS: 'GR', EL: 'GR',
  CYPRUS: 'CY', GERMANY: 'DE', FRANCE: 'FR', ITALY: 'IT', SPAIN: 'ES', BULGARIA: 'BG',
  'UNITED KINGDOM': 'GB', UK: 'GB',
};
