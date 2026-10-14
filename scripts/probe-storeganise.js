// Read-only dry run of invoice fetching against a real Storeganise account.
//
//   SG_API_URL=https://<business>.storeganise.com/api SG_API_KEY=<admin key> \
//     npm run probe -- [--since 48h] [--invoice <id>] [--payload] [--max-pages 5] [--ignore-vat]
//
// Runs the add-on's own code (safety-net poll, webhook handler, worker eligibility
// checks) on a throwaway in-memory database with the real migrations. It:
//   - only makes GET requests to Storeganise; every write is blocked and listed
//   - never calls Impact (transmission is paused, and the Impact stand-in throws)
//   - never touches Supabase
//
// Use it to see what the add-on would do with real invoices, and to check the
// Storeganise API's real list response (fields, ordering, paging) before go-live.
//
// --ignore-vat: test accounts often use non-Greek VAT rates, which the add-on
// rightly refuses. This rewrites every fetched invoice line to 24% VAT (line,
// invoice and payment totals recomputed so they still agree) before the add-on
// sees it. Probe only: the add-on itself never does this (see scripts/lib/sandbox.js).

// --- Arguments -------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const sinceArg = opt('since') || '24h';
const invoiceId = opt('invoice');
const showPayload = Boolean(opt('payload'));
const maxPages = Number(opt('max-pages')) || 5;
const ignoreVat = Boolean(opt('ignore-vat'));

const apiUrl = process.env.SG_API_URL;
const apiKey = process.env.SG_API_KEY;
if (!apiUrl || !apiKey) {
  console.error('Set SG_API_URL (https://<business>.storeganise.com/api) and SG_API_KEY (admin API key).');
  process.exit(1);
}

function parseSince(value) {
  const m = /^(\d+)([hd])$/.exec(value);
  if (m) return new Date(Date.now() - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000));
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--since: use e.g. 24h, 7d or an ISO date, not "${value}"`);
  return d;
}
const since = parseSince(sinceArg);
if (Date.now() - since.getTime() > 40 * 86400000) {
  console.error('--since: Storeganise only accepts updatedAfter up to 40 days back.');
  process.exit(1);
}

const { createSandbox } = await import('./lib/sandbox.js');
const { pg, cfg, company, sg, impact, stats, blockedWrites, listPages } = await createSandbox({ apiUrl, apiKey, ignoreVat, maxPages });

const { forCompany, setState } = await import('../src/settings.js');
const { runPoll } = await import('../src/jobs/poll.js');
const { runWorker } = await import('../src/jobs/worker.js');
const { default: invoiceEvent } = await import('../src/events/invoice-events.js');
const { evaluate } = await import('../src/jobs/process-invoice.js');
const { normalizeCustomer, normalizeInvoice } = await import('../src/mydata/normalize.js');
const { isFullyPaid } = await import('../src/mydata/rules.js');

const fmt = cents => (cents === null || cents === undefined ? '–' : (cents / 100).toFixed(2));
const line = (...cols) => console.log(cols.join('  '));

console.log(`\nStoreganise: ${apiUrl}`);
console.log(`Mode: read-only. Nothing is sent to Impact or written to Storeganise.`);
console.log(ignoreVat ? 'VAT: --ignore-vat, every line rewritten to 24% (probe only).\n' : '');

// --- 1. One invoice, the webhook way -------------------------------------------------
if (invoiceId) {
  console.log(`== Invoice ${invoiceId}, as a payment webhook would handle it`);
  const raw = await sg.getInvoice(String(invoiceId));
  if (!raw) {
    console.log('Not found in Storeganise (404).');
    process.exit(0);
  }
  const invoice = normalizeInvoice(raw, cfg.settings);
  const owner = raw.owner && typeof raw.owner === 'object' && raw.owner.customFields
    ? raw.owner
    : (raw.owner?.id || raw.ownerId) ? await sg.getUser(raw.owner?.id || raw.ownerId) : null;
  const customer = normalizeCustomer(owner);

  line('state:', invoice.state, ' total:', fmt(invoice.totalCents), ' balance:', fmt(invoice.balanceCents),
    ' fully paid:', isFullyPaid(invoice, cfg.settings) ? 'yes' : 'no');
  line('site:', invoice.siteId ?? '–', ' lines:', invoice.lines.length, ' payments:', invoice.payments.length,
    ' customer:', customer ? `${customer.name ?? '–'} (${customer.isBusiness ? 'business' : 'private'})` : 'none');
  if (customer?.isBusiness) line('  ΑΦΜ:', customer.afm ?? 'MISSING', ' company:', customer.companyName ?? 'MISSING', ' city:', customer.address.city ?? 'MISSING', ' postcode:', customer.address.postcode ?? 'MISSING');

  const event = await invoiceEvent({ event: 'invoice.payments.updated', data: { invoiceId }, sg, company, cfg });
  line('webhook result:', JSON.stringify(event));

  const decision = evaluate(invoice, customer, forCompany(cfg, company));
  line('worker decision:', decision.status, decision.reason ? `– ${decision.reason}` : '(would be sent)');
  if (showPayload && decision.build?.payload) {
    console.log('\nImpact document that would be sent (series/number assigned at send time):');
    console.log(JSON.stringify(decision.build.payload, null, 2));
  } else if (showPayload) {
    console.log('(no payload: the invoice would not be sent)');
  }
  console.log();
}

// --- 2. Safety-net poll + worker checks over a time window -----------------------------
if (!invoiceId || opt('since')) {
  console.log(`== Invoices updated since ${since.toISOString()} (safety-net poll)`);
  // The poll subtracts its overlap from the cursor; add it back so the window is exact
  const overlap = (Number(cfg.settings.poll_overlap_seconds) || 300) * 1000;
  await setState('poll_cursor:propco', new Date(since.getTime() + overlap).toISOString());

  const poll = await runPoll({ sg });
  for (let i = 0; i < 20; i++) {
    const out = await runWorker({ sg, impact });
    if (!out.claimed) break;
  }

  // What the list endpoint really returns (the open questions on paging and fields)
  const all = listPages.flatMap(p => p.items);
  const value = (i, field) => (field === 'owner.id' ? i.owner?.id ?? i.ownerId : i[field]);
  const has = field => all.filter(i => value(i, field) !== undefined && value(i, field) !== null).length;
  console.log(`\nList endpoint: ${all.length} invoices over ${listPages.length} page(s) of up to ${Number(cfg.settings.poll_page_size) || 100}`);
  for (const field of ['state', 'total', 'balance', 'updated', 'siteId', 'owner.id']) {
    // Valet invoices have no site; that only matters for site-mode routing
    const note = field === 'siteId' ? '  (valet invoices have none; matters only in site mode)' : '  ← missing on some: check';
    line(`  ${field.padEnd(8)}`, `${has(field)}/${all.length}`, has(field) < all.length ? note : '');
  }
  const ids = all.map(i => String(i.id));
  const dupes = ids.length - new Set(ids).size;
  line('  duplicates across pages:', dupes, dupes ? '  ← paging is not stable' : '');
  const order = key => {
    const v = all.map(i => i[key]).filter(Boolean);
    if (v.length < 2) return 'n/a';
    const asc = v.every((x, i) => i === 0 || v[i - 1] <= x);
    const desc = v.every((x, i) => i === 0 || v[i - 1] >= x);
    return asc ? 'ascending' : desc ? 'descending' : 'unordered';
  };
  line('  order by updated:', order('updated'), ' by created:', order('created'), ' by id:', order('id'));

  const { rows: jobs } = await pg.query(
    `select sg_invoice_id, status, coalesce(last_error, status_reason) as reason, customer_kind
       from einvoice.jobs order by status, sg_invoice_id`,
  );
  const unpaid = all.length - all.filter(i => isFullyPaid(normalizeInvoice(i, cfg.settings), cfg.settings)).length;
  console.log(`\nPoll: ${poll.seen} seen, ${unpaid} not fully paid (ignored, as pro formas), ${jobs.length} job(s) created`);

  const counts = jobs.reduce((acc, j) => ({ ...acc, [j.status]: (acc[j.status] || 0) + 1 }), {});
  line('Worker decisions:', Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(', ') || 'none');
  console.log('  pending = would be sent; held = customer data missing; skipped/failed_data = not sent (see reason)\n');
  for (const j of jobs) line(' ', j.sg_invoice_id.padEnd(26), j.status.padEnd(12), j.customer_kind ?? '   ', j.reason ?? '');
}

if (ignoreVat) console.log(`\nVAT rewritten to 24% on ${stats.vatRewritten} invoice read(s).`);
console.log(`\nStoreganise GET requests: ${stats.requests}. Writes blocked: ${blockedWrites.length}` +
  (blockedWrites.length ? ' (the ei_* custom fields the add-on would have written back).' : '.'));
