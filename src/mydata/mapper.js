import { NO_VAT_CATEGORY, RATE_BY_VAT_CATEGORY, VAT_CATEGORY_BY_RATE, VAT_EXEMPT_CATEGORY } from './constants.js';
import { allocate, formatEuros, toEuros } from './money.js';
import {
  customerKind as kindOf,
  paymentMethodFor,
  region as regionOf,
  resolveDocTypeRule,
  resolveLineMapping,
  ruleForTypeCode,
} from './rules.js';

/**
 * Storeganise invoice + customer → Impact document (FRD Module 3).
 *
 * Returns { ok, errors, payload, meta }. `errors` are short, readable messages that
 * end up in the invoice's ei_error field (FR-ERR-03). The payload is built even
 * without a number so it can be validated before a number is reserved; numbers are
 * only consumed by documents that pass validation.
 *
 * Shape and casing follow Impact's official JSON samples (developers.s1ecos.com →
 * WIKI JSON Samples: 1.1, 2.1, 11.1, 11.4, 5.2), i.e. the EliseCoreDocument schema.
 */
export function buildDocument({ invoice, customer, config, job = {}, numbering = null }) {
  const { settings, issuer, branches, docTypeRules, lineMappings, paymentMethods } = config;
  const errors = [];

  if (!issuer) {
    return fail(['Issuer details are not configured (einvoice.issuer)']);
  }

  const customerKind = job.customer_kind || kindOf(customer);
  const region = regionOf(customer);

  // --- Lines: mapping and exclusion (FR-MAP-03) ---------------------------------
  const included = [];
  const excluded = [];

  for (const line of invoice.lines) {
    const mapping = resolveLineMapping(line, customerKind, lineMappings);
    if (!mapping) {
      errors.push(`No mapping for line "${line.description}" (type ${line.type || 'none'}, code ${line.accountingCode || 'none'})`);
      continue;
    }
    if (mapping.exclude) {
      excluded.push({ ...line, mapping });
      continue;
    }
    included.push({ ...line, mapping });
  }

  // Everything excluded (e.g. a deposit-only invoice): nothing to report
  if (!included.length && !errors.length) {
    return fail(['No reportable lines (all lines excluded by mapping)'], { noReportableLines: true, customerKind });
  }

  // --- Discounts (FR-MAP-04) ----------------------------------------------------
  const discounts = included.filter(l => l.isDiscount);
  let lines = included.filter(l => !l.isDiscount).map(l => ({ ...l }));

  if (discounts.length) {
    if (settings.discount_mode === 'reject') {
      errors.push('Invoice has discount lines and discount_mode is "reject"');
    } else {
      for (const discount of discounts) {
        const targets = lines.filter(l => l.vatRate === discount.vatRate && l.netCents > 0);
        if (!targets.length) {
          errors.push(`Discount "${discount.description}" has no line at ${discount.vatRate}% VAT to apply to`);
          continue;
        }
        const weights = targets.map(l => l.netCents);
        const netParts = allocate(discount.netCents, weights);
        const vatParts = allocate(discount.vatCents, weights);
        targets.forEach((line, i) => {
          line.netCents += netParts[i];
          line.vatCents += vatParts[i];
          line.discountCents = (line.discountCents || 0) - netParts[i];
        });
      }
    }
    for (const line of lines) {
      if (line.netCents < 0) errors.push(`Discounts exceed line "${line.description}"`);
    }
    // A line fully discounted to zero still has to appear (myDATA accepts 0 lines)
  }

  // --- VAT category per line ----------------------------------------------------
  for (const line of lines) {
    const category = line.mapping.vat_category_code ?? VAT_CATEGORY_BY_RATE[line.vatRate];
    if (!category) {
      errors.push(`Unsupported VAT rate ${line.vatRate}% on line "${line.description}"`);
      continue;
    }
    if ((category === VAT_EXEMPT_CATEGORY || category === NO_VAT_CATEGORY) && line.vatCents !== 0) {
      errors.push(`Line "${line.description}" is mapped as VAT-exempt but carries ${formatEuros(line.vatCents)} VAT in Storeganise`);
    }
    if (category !== VAT_EXEMPT_CATEGORY && category !== NO_VAT_CATEGORY && RATE_BY_VAT_CATEGORY[category] !== line.vatRate) {
      errors.push(`Line "${line.description}" is mapped to VAT category ${category} but has ${line.vatRate}% VAT`);
    }
    if (category === VAT_EXEMPT_CATEGORY && !line.mapping.vat_exemption_code) {
      errors.push(`VAT exemption reason missing in mapping for "${line.accountingCode || line.type || 'none'}" lines`);
    }
    line.vatCategory = category;
  }

  // --- Totals, with a cent-level VAT rounding reconciliation (FR-MAP-05) ---------
  const excludedGross = sum(excluded, 'grossCents');
  const excludedVat = sum(excluded, 'vatCents');
  const expectedGross = invoice.totalCents - excludedGross;
  const expectedVat = invoice.taxCents === null ? null : invoice.taxCents - excludedVat;

  // Storeganise may round VAT on the invoice total rather than per line. Absorb a
  // difference of at most half a cent per line into the largest line of that rate.
  if (expectedVat !== null && lines.length) {
    const diff = expectedVat - sum(lines, 'vatCents');
    const tolerance = Math.ceil(lines.length / 2) + 1;
    const rates = new Set(lines.filter(l => l.vatCents !== 0).map(l => l.vatRate));
    if (diff !== 0 && Math.abs(diff) <= tolerance && rates.size === 1) {
      const target = lines.filter(l => l.vatCents !== 0).sort((a, b) => b.netCents - a.netCents)[0];
      target.vatCents += diff;
    }
  }

  const totalNet = sum(lines, 'netCents');
  const totalVat = sum(lines, 'vatCents');
  const totalGross = totalNet + totalVat;

  if (Math.abs(totalGross - expectedGross) > 1) {
    errors.push(`Totals differ from Storeganise: document ${formatEuros(totalGross)} vs invoice ${formatEuros(expectedGross)}`);
  }
  if (expectedVat !== null && Math.abs(totalVat - expectedVat) > 1) {
    errors.push(`VAT differs from Storeganise: document ${formatEuros(totalVat)} vs invoice ${formatEuros(expectedVat)}`);
  }

  // --- Document type and series (FR-MAP-01, FR-CFG-04) ---------------------------
  const natures = new Set(lines.map(l => l.mapping.nature));
  const nature = natures.size === 1 ? [...natures][0] : 'mixed';

  let rule;
  if (job.invoice_type_code) {
    rule = ruleForTypeCode('invoice', job.invoice_type_code, docTypeRules);
  } else {
    rule = resolveDocTypeRule({ kind: 'invoice', customerKind, region, nature }, docTypeRules)
      || (nature === 'mixed'
        ? resolveDocTypeRule({ kind: 'invoice', customerKind, region, nature: settings.mixed_nature || 'services' }, docTypeRules)
        : null);
  }
  if (!rule) {
    errors.push(`No document-type rule for ${customerKind.toUpperCase()} customer in ${region} with ${nature} lines`);
  }

  const branch = branches[invoice.siteId] || null;
  const seriesCode = job.series_code || (rule ? `${rule.series_code}${branch?.series_suffix || ''}` : null);
  if (seriesCode && !job.series_code && !config.series[seriesCode]?.active) {
    errors.push(`Series "${seriesCode}" is not configured or not active`);
  }

  // --- Payment methods (FR-MAP-06) -------------------------------------------------
  const paymentLines = buildPaymentMethods(invoice, totalGross, paymentMethods);
  if (!paymentLines.length && totalGross > 0) errors.push('No payment method mapping (add a "*" row to einvoice.payment_methods)');

  // --- Approval gate: never transmit to production on placeholder mapping -------
  if (settings.impact_env === 'production' && settings.require_approved_mapping !== false) {
    const unapproved = [
      ...lines.map(l => l.mapping).filter(m => !m.approved).map(m => `line mapping #${m.id}`),
      ...(rule && !rule.approved ? [`document-type rule #${rule.id}`] : []),
      ...paymentLines.filter(p => !p.row.approved).map(p => `payment method "${p.row.sg_method}"`),
    ];
    if (unapproved.length) errors.push(`Mapping not approved by accountant: ${[...new Set(unapproved)].join(', ')}`);
  }

  if (errors.length) return fail(errors, { customerKind, nature, rule, seriesCode });

  // --- Payload -------------------------------------------------------------------------
  const details = lines.map((line, i) => detailLine(line, i + 1, customerKind));
  const distribute = settings.distribution_enabled === true && Boolean(customer?.email);

  const payload = {
    IAPRSignPolicy: Number(settings.impact_sign_policy ?? 2),
    CurrencyCode: 'EUR',
    InvoiceType: rule.invoice_type_name,
    InvoiceTypeCode: rule.invoice_type_code,
    DocumentType: rule.invoice_type_name,
    DocumentTypeCode: rule.document_type_code,
    Series: seriesCode,
    Number: numbering ? String(numbering.number) : '0',
    DateIssued: formatDate(numbering?.dateIssued || new Date()),
    Issuer: issuerBlock(issuer, branch),
    ...(customerKind === 'b2b' && { CounterParty: counterPartyBlock(customer) }),
    DistributionDetails: {
      InternalDocumentId: invoice.id,
    },
    PaymentDetails: {
      PaymentMethods: paymentLines.map(p => ({
        PaymentMethodType: p.row.mydata_name,
        PaymentMethodTypeCode: p.row.mydata_code,
        Amount: toEuros(p.amountCents),
      })),
    },
    // Archive only unless distribution is on: Impact emails by default otherwise
    AdditionalDetails: {
      TransmissionMethod: distribute ? 'E' : 'A',
      AvoidEmailGrouping: false,
      AccountingDepartmentEmails: distribute ? [customer.email] : [''],
    },
    Details: details,
    Summaries: summaries(totalNet, totalVat),
    VatAnalysis: vatAnalysis(details),
    IsDelayedCode: job.delayed_code || 0,
  };

  return {
    ok: true,
    errors: [],
    payload,
    meta: {
      customerKind,
      nature,
      rule,
      seriesCode,
      branch: branch?.branch ?? issuer.default_branch ?? 0,
      totals: { netCents: totalNet, vatCents: totalVat, grossCents: totalGross },
      excludedGrossCents: excludedGross,
      lineCount: lines.length,
    },
  };
}

function fail(errors, meta = {}) {
  return { ok: false, errors: [...new Set(errors)], payload: null, meta };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function detailLine(line, lineNo, customerKind) {
  const net = toEuros(line.netCents);
  const quantity = line.quantity > 0 ? line.quantity : 1;
  const unitPrice = Math.round((line.netCents / quantity)) / 100;
  const m = line.mapping;
  const rate = RATE_BY_VAT_CATEGORY[line.vatCategory] ?? line.vatRate;

  return {
    LineNo: lineNo,
    // Mandatory on B2B lines
    Code: String(line.accountingCode || line.type || 'ITEM'),
    Descriptions: [line.description],
    // Required by AADE on goods lines; 1 = pieces (τεμάχια)
    MeasurementUnitCode: 1,
    Quantity: quantity,
    UnitPrice: unitPrice,
    NetTotal: net,
    VATTotal: toEuros(line.vatCents),
    Total: toEuros(line.netCents + line.vatCents),
    VatCategory: `${rate}%`,
    VatCategoryCode: line.vatCategory,
    ...(line.vatCategory === VAT_EXEMPT_CATEGORY && { VatExemptionCategoryCode: m.vat_exemption_code }),
    IsInformative: false,
    IsHidden: false,
    RecordTypeCode: 0,
    IncomeClassification: {
      ClassificationTypeCode: m.classification_type_code || (customerKind === 'b2b' ? 'E3_561_001' : 'E3_561_003'),
      ClassificationCategoryCode: m.classification_category_code,
      Amount: net,
    },
  };
}

export function vatAnalysis(details) {
  const byCategory = new Map();
  for (const d of details) {
    const entry = byCategory.get(d.VatCategoryCode) || { name: d.VatCategory, vat: 0, net: 0 };
    entry.vat += Math.round(d.VATTotal * 100);
    entry.net += Math.round(d.NetTotal * 100);
    byCategory.set(d.VatCategoryCode, entry);
  }
  return [...byCategory.values()].map(e => ({
    Name: e.name,
    Percentage: Number.parseFloat(e.name),
    VatAmount: toEuros(e.vat),
    UnderlyingValue: toEuros(e.net),
  }));
}

export function summaries(netCents, vatCents) {
  return {
    TotalNetAmount: toEuros(netCents),
    TotalVATAmount: toEuros(vatCents),
    TotalGrossValue: toEuros(netCents + vatCents),
    TotalWithheldAmount: 0,
    TotalFeesAmount: 0,
    TotalStampDutyAmount: 0,
    TotalOtherTaxesAmount: 0,
    TotalDeductionsAmount: 0,
    TotalPayableAmount: toEuros(netCents + vatCents),
  };
}

/**
 * Payments received against the invoice, mapped to myDATA codes and capped at the
 * document gross (deposits are excluded from the document but may be in the
 * payment). Whatever is unpaid is reported as "on credit" (the '*' row).
 */
export function buildPaymentMethods(invoice, grossCents, paymentMethods) {
  const out = new Map();
  let remaining = grossCents;

  for (const payment of invoice.payments) {
    if (payment.isRefund || payment.amountCents <= 0 || remaining <= 0) continue;
    const row = paymentMethodFor(payment.method, paymentMethods);
    if (!row) continue;
    const amount = Math.min(payment.amountCents, remaining);
    remaining -= amount;
    const entry = out.get(row.sg_method) || { row, amountCents: 0 };
    entry.amountCents += amount;
    out.set(row.sg_method, entry);
  }

  if (remaining > 0) {
    const row = paymentMethods['*'];
    if (row) {
      const entry = out.get(row.sg_method) || { row, amountCents: 0 };
      entry.amountCents += remaining;
      out.set(row.sg_method, entry);
    }
  }

  return [...out.values()];
}

export function issuerBlock(issuer, branch) {
  return {
    RegisteredName: issuer.registered_name,
    Vat: `EL${issuer.afm}`,
    ...(issuer.tax_office && { TaxOffice: issuer.tax_office }),
    Address: {
      CountryCode: issuer.country_code || 'GR',
      ...(issuer.city && { City: issuer.city }),
      ...(issuer.street && { Street: issuer.street }),
      ...(issuer.street_number && { Number: issuer.street_number }),
      ...(issuer.postal_code && { Postal: issuer.postal_code }),
    },
    // Part of the document UID: {vat}-{date}-{branchCode}-{type}-{series}-{number}
    BranchCode: Number(branch?.branch ?? issuer.default_branch ?? 0),
  };
}

export function counterPartyBlock(customer) {
  const country = customer.address.country || 'GR';
  return {
    RegisteredName: customer.companyName,
    Vat: country === 'GR' ? `EL${customer.afm}` : customer.afm,
    ...(customer.doy && { TaxOffice: customer.doy }),
    Address: {
      CountryCode: country,
      City: customer.address.city,
      ...(customer.address.street && { Street: customer.address.street }),
      Postal: customer.address.postcode,
    },
    ...(customer.id && { Code: String(customer.id) }),
  };
}

/** ISO 8601 local Greek time without offset, as in Impact's examples. */
export function formatDate(date) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Athens',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(d).replace(' ', 'T');
}
