/**
 * Customer notification (Impact: Customer Notifications). Impact's copy is the
 * legal document, and Impact sends it to the customer as set per company in
 * einvoice.companies.transmission_method:
 *
 *   E  email with a link to the document (AccountingDepartmentEmails)
 *   A  archive only, nothing sent
 *   M  SMS / Viber (CustomerCellNumbers, Greek mobiles only)
 *   C  email and SMS / Viber
 *
 * A customer without the contact a method needs gets the next best one
 * (C → E or M, M → E, E → A). A missing email or mobile never holds a document
 * back: it is still issued and archived at Impact.
 *
 * Outside production, real customers are never contacted: notifications go to
 * the uat_notification_emails / uat_notification_phones settings, or nowhere.
 */
export function additionalDetails({ method = 'E', customer, settings }) {
  const production = settings.impact_env === 'production';

  const emails = production
    ? [customer?.email].filter(isEmail)
    : list(settings.uat_notification_emails).filter(isEmail);
  const phones = production
    ? [greekMobile(customer?.phone)].filter(Boolean)
    : list(settings.uat_notification_phones).map(greekMobile).filter(Boolean);

  const effective = resolveMethod(method, emails.length > 0, phones.length > 0);
  const byEmail = effective === 'E' || effective === 'C';
  const byMobile = effective === 'M' || effective === 'C';

  return {
    TransmissionMethod: effective,
    AvoidEmailGrouping: false,
    // As in Impact's samples, [""] when nobody is emailed
    AccountingDepartmentEmails: byEmail ? emails : [''],
    ...(byMobile && { CustomerCellNumbers: phones }),
  };
}

export function resolveMethod(method, hasEmail, hasMobile) {
  switch (method) {
    case 'C':
      if (hasEmail && hasMobile) return 'C';
      if (hasEmail) return 'E';
      return hasMobile ? 'M' : 'A';
    case 'M':
      if (hasMobile) return 'M';
      return hasEmail ? 'E' : 'A';
    case 'E':
      return hasEmail ? 'E' : 'A';
    default:
      return 'A';
  }
}

/**
 * A Greek mobile in the format Impact accepts for SMS / Viber (+3069XXXXXXXX), or
 * null. Landlines and foreign numbers are not supported by Impact.
 */
export function greekMobile(value) {
  if (value === undefined || value === null) return null;
  let n = String(value).replace(/[\s\-().\/]/g, '');
  if (n.startsWith('00')) n = `+${n.slice(2)}`;
  if (/^69\d{8}$/.test(n)) return `+30${n}`;
  if (/^3069\d{8}$/.test(n)) return `+${n}`;
  if (/^\+3069\d{8}$/.test(n)) return n;
  return null;
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function list(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
