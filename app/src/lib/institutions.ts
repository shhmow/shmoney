// Where to send the user for "open this at my bank" / "dispute this charge".
// No issuer offers a public deep link to a specific transaction: every dispute
// flow starts from the logged-in activity page, so we link there plus the
// issuer's own how-to page and phone line. Keyed by Plaid institution_id with a
// name-substring fallback for institutions linked under a different id.

export interface InstitutionLinks {
  key: string;            // stable short key used for settings overrides
  label: string;          // short brand label ("Amex")
  activity: string;       // logged-in activity / accounts page
  dispute: string;        // issuer's dispute how-to (or dispute center)
  phone: string | null;   // customer service line printed on cards
  brand: string;          // card-network / brand mark hint for the UI
}

const LINKS: InstitutionLinks[] = [
  {
    key: "amex", label: "Amex", brand: "amex",
    activity: "https://global.americanexpress.com/activity/recent",
    dispute: "https://www.americanexpress.com/us/customer-service/faq.dispute-a-charge.html",
    phone: "1-800-528-4800",
  },
  {
    key: "discover", label: "Discover", brand: "discover",
    activity: "https://card.discover.com/cardmembersvcs/achome/homepage",
    dispute: "https://www.discover.com/credit-cards/card-smarts/how-to-dispute-a-credit-card-charge/",
    phone: "1-800-347-2683",
  },
  {
    key: "capitalone", label: "Capital One", brand: "capitalone",
    activity: "https://myaccounts.capitalone.com/",
    dispute: "https://www.capitalone.com/help-center/credit-cards/dispute-charge/",
    phone: "1-800-227-4825",
  },
  {
    key: "bofa", label: "Bank of America", brand: "bofa",
    activity: "https://secure.bankofamerica.com/myaccounts/",
    dispute: "https://www.bankofamerica.com/help/how-to-dispute-a-charge/",
    phone: "1-866-266-0212",
  },
  {
    key: "fidelity", label: "Fidelity", brand: "fidelity",
    activity: "https://digital.fidelity.com/ftgw/digital/portfolio/summary",
    dispute: "https://www.fidelity.com/customer-service/contact-us",
    phone: "1-800-343-3548",
  },
  {
    key: "chase", label: "Chase", brand: "chase",
    activity: "https://secure.chase.com/web/auth/dashboard",
    dispute: "https://www.chase.com/personal/credit-cards/education/basics/how-to-dispute-a-credit-card-charge",
    phone: "1-800-432-3117",
  },
];

const BY_PLAID_ID: Record<string, string> = {
  ins_10: "amex",
  ins_33: "discover",
  ins_128026: "capitalone",
  ins_127989: "bofa",
  ins_12: "fidelity",
  ins_56: "chase",
  ins_3: "chase",
};

function byKey(key: string): InstitutionLinks | null {
  return LINKS.find((l) => l.key === key) ?? null;
}

/** Best-effort links for an institution; null when unknown. */
export function institutionLinks(institutionId: string | null, institutionName: string | null): InstitutionLinks | null {
  if (institutionId && BY_PLAID_ID[institutionId]) return byKey(BY_PLAID_ID[institutionId]);
  const n = (institutionName ?? "").toLowerCase();
  if (n.includes("american express") || n.includes("amex")) return byKey("amex");
  if (n.includes("discover")) return byKey("discover");
  if (n.includes("capital one")) return byKey("capitalone");
  if (n.includes("bank of america")) return byKey("bofa");
  if (n.includes("fidelity")) return byKey("fidelity");
  if (n.includes("chase")) return byKey("chase");
  return null;
}

/**
 * Links follow the institution that services the account (Discover cards
 * have synced and been paid through Capital One since the 2025 acquisition,
 * so disputes go there too). Only the visual brand mark follows the card.
 */
export function accountLinks(
  _accountName: string | null,
  institutionId: string | null,
  institutionName: string | null,
): InstitutionLinks | null {
  return institutionLinks(institutionId, institutionName);
}

/** Brand mark for an account: the card's own brand when recognizable, else the institution's. */
export function accountBrand(
  accountName: string | null,
  institutionId: string | null,
  institutionName: string | null,
): string | null {
  const n = (accountName ?? "").toLowerCase();
  if (n.includes("discover")) return "discover";
  return institutionLinks(institutionId, institutionName)?.brand ?? null;
}
