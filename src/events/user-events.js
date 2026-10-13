import { accountCompanies } from '../companies.js';
import * as repo from '../jobs/repo.js';

/**
 * user.updated → { userId }
 *
 * A business invoice is held while its customer's tax data (ΑΦΜ, company name,
 * city, postcode) is missing or invalid (FR-CUS-02). Fixing the customer in
 * Storeganise fires user.updated, not an invoice event, so this flags that
 * customer's held invoices for the worker, which re-reads them and sends any that
 * are now complete. Nothing is read from Storeganise here.
 */
export default async function userEvent({ data, company, cfg }) {
  const { userId } = data || {};
  if (!userId) return { skipped: 'no userId' };

  const account = accountCompanies(cfg, company).map(c => c.id);
  const flagged = await repo.recheckCustomer(account, userId);
  return { userId: String(userId), recheck: flagged, queued: flagged > 0 };
}
