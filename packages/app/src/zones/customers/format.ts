import type { Activity, Customer } from '@business-os/contracts';

// ISO 3166-1 alpha-2 officially assigned codes (the API rejects user-assigned codes such as ZZ).
const CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');

export function countryName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function countryOptions(locale?: string): { code: string; name: string }[] {
  return CODES.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** "Perth WA 6000, Australia" from whatever parts exist. */
export function addressLines(c: Customer, locale?: string): string[] {
  const place = [c.city, c.region, c.postalCode].filter(Boolean).join(' ');
  return [c.addressLine1, c.addressLine2, place, c.countryCode ? countryName(c.countryCode, locale) : null].filter((v): v is string => Boolean(v));
}

export function locationOf(c: Customer, locale?: string): string {
  return [c.city, c.countryCode ? countryName(c.countryCode, locale) : null].filter(Boolean).join(', ');
}

export function formatWhen(iso: string, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

const FIELD_LABEL: Record<string, string> = {
  displayName: 'name', legalName: 'legal name', email: 'email', phone: 'phone', website: 'website', kind: 'type', notes: 'notes', ownerUserId: 'owner',
  addressLine1: 'address', addressLine2: 'address', city: 'address', region: 'address', postalCode: 'address', countryCode: 'address',
  taxNumber: 'tax number', taxNumberType: 'tax number',
};

const SYSTEM_LABEL: Record<string, string> = {
  'customer.created': 'Customer created',
  'customer.archived': 'Customer archived',
  'customer.restored': 'Customer restored',
  'customer.primary_contact_changed': 'Primary contact changed',
  'contact.created': 'Contact added',
  'contact.updated': 'Contact details updated',
  'contact.archived': 'Contact archived',
  'contact.restored': 'Contact restored',
  'contact.customer_changed': 'Contact moved between customers',
  'contact.customer_removed': 'Contact unlinked from this customer',
};
const USER_LABEL: Record<string, string> = { note: 'Note', call: 'Call', meeting: 'Meeting', email: 'Email' };

/** A readable headline for an activity. Updates list which fields changed (never their values). */
export function activityTitle(a: Activity): string {
  if (a.type === 'customer.updated') {
    const fields = Array.isArray(a.data.fields) ? (a.data.fields as unknown[]).map((f) => FIELD_LABEL[String(f)] ?? String(f)) : [];
    const unique = [...new Set(fields)];
    return unique.length ? `Customer updated: ${unique.join(', ')}` : 'Customer updated';
  }
  return a.subject ?? SYSTEM_LABEL[a.type] ?? USER_LABEL[a.type] ?? a.type;
}

export const isSystemActivity = (a: Activity) => a.type.includes('.');
export const activityKind = (a: Activity) => USER_LABEL[a.type] ?? 'Update';
