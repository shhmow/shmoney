// Brand marks: issuer/card-network tiles drawn as SVG (no emoji, no bitmaps
// shipped), Plaid institution logos when the item has one, merchant logos
// (Plaid logo_url, else a favicon proxied through the worker), and a
// monogram tile as the universal fallback.
import { esc, initials } from "./format.js";

/* ---------- issuer marks (viewBox 0 0 40 40, rounded tile) ---------- */
const T = (bg, inner) =>
  `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="9" fill="${bg}"/>${inner}</svg>`;
const txt = (s, { x = 20, y = 24, size = 11, fill = "#fff", weight = 800, italic = false, ls = 0 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="middle" font-family="Schibsted Grotesk, Helvetica, Arial, sans-serif" font-weight="${weight}" font-size="${size}" fill="${fill}"${italic ? ' font-style="italic"' : ""}${ls ? ` letter-spacing="${ls}"` : ""}>${s}</text>`;

export const BRANDS = {
  amex: { name: "American Express", color: "#016fd0",
    svg: T("#016fd0", `<rect x="6" y="6" width="28" height="28" rx="2" fill="none" stroke="#fff" stroke-width="1.6"/>${txt("AMEX", { size: 9.5, y: 23.5, ls: .3 })}`) },
  discover: { name: "Discover", color: "#ff6000",
    svg: T("#f4f1ec", `${txt("DISC", { size: 10, y: 24, x: 16, fill: "#231f20", ls: .2 })}<circle cx="30.5" cy="20.5" r="5" fill="#ff6000"/>`) },
  bofa: { name: "Bank of America", color: "#e31837",
    svg: T("#012169", `<path d="M9 27 L26 12 M13 30 L30 15 M17 32 L33 18" stroke="#e31837" stroke-width="3.2" stroke-linecap="round"/><path d="M9 27 L26 12" stroke="#fff" stroke-width="1" opacity=".55"/>`) },
  fidelity: { name: "Fidelity", color: "#4a8c2a",
    svg: T("#4a8c2a", `<path d="M11 28 L20 10 L29 28 Z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M15 28 L20 18 L25 28" fill="#fff" opacity=".85"/>`) },
  capitalone: { name: "Capital One", color: "#004977",
    svg: T("#004977", `${txt("C1", { size: 15, y: 25.5 })}<path d="M7 31 Q20 24 33 31" stroke="#d03027" stroke-width="2.4" fill="none" stroke-linecap="round"/>`) },
  chase: { name: "Chase", color: "#117aca",
    svg: T("#117aca", `<path d="M12 12 h11 v9 h-11 z M28 12 v11 h-9 v-11 z M28 28 h-11 v-9 h11 z M12 28 v-11 h9 v11 z" fill="#fff"/>`) },
  visa: { name: "Visa", color: "#1a1f71",
    svg: T("#ffffff", txt("VISA", { size: 13, y: 25, fill: "#1a1f71", weight: 900, italic: true, ls: -.5 })) },
  mastercard: { name: "Mastercard", color: "#eb001b",
    svg: T("#1b1f21", `<circle cx="16" cy="20" r="9" fill="#eb001b"/><circle cx="24" cy="20" r="9" fill="#f79e1b" opacity=".92"/>`) },
  venmo: { name: "Venmo", color: "#008cff", svg: T("#008cff", txt("V", { size: 20, y: 27 })) },
  zelle: { name: "Zelle", color: "#6d1ed4", svg: T("#6d1ed4", txt("Z", { size: 20, y: 27 })) },
  paypal: { name: "PayPal", color: "#003087", svg: T("#003087", txt("P", { size: 20, y: 27, fill: "#009cde" })) },
  applecash: { name: "Apple Cash", color: "#1b1f21", svg: T("#1b1f21", txt("A", { size: 20, y: 27 })) },
};

/** Card-network mark from an account name; null when unknown. */
export function networkOf(acct) {
  const n = `${acct?.name || ""} ${acct?.official_name || ""}`.toLowerCase();
  if (n.includes("visa")) return "visa";
  if (n.includes("mastercard") || n.includes("master card")) return "mastercard";
  return null;
}

/** Issuer brand key for an account (Discover-under-Capital One handled server-side). */
export function brandOf(acct) {
  if (acct?.brand && BRANDS[acct.brand]) return acct.brand;
  const n = `${acct?.institution_name || ""} ${acct?.name || ""}`.toLowerCase();
  for (const [k, b] of Object.entries(BRANDS)) if (n.includes(b.name.toLowerCase())) return k;
  return null;
}

/** Institution tile: Plaid logo image when stored, else drawn brand mark, else monogram. */
export function instTile(acct, { size = 30, cls = "" } = {}) {
  const brand = brandOf(acct);
  const style = `width:${size}px;height:${size}px`;
  const forceDrawn = brand === "discover"; // Discover syncs under Capital One's logo
  if (acct?.has_logo && acct.item_id != null && !forceDrawn) {
    return `<span class="brand-tile img ${cls}" style="${style}"><img src="/api/items/${acct.item_id}/logo" alt="" loading="lazy"></span>`;
  }
  if (brand) return `<span class="brand-tile ${cls}" style="${style}" title="${esc(BRANDS[brand].name)}">${BRANDS[brand].svg}</span>`;
  return monogram(acct?.institution_name || acct?.name || "?", { size, cls });
}

/** Small network badge (Visa/Mastercard) or empty string. */
export function networkBadge(acct, size = 22) {
  const k = networkOf(acct);
  if (!k) return "";
  return `<span class="brand-tile net" style="width:${size}px;height:${size}px" title="${esc(BRANDS[k].name)}">${BRANDS[k].svg}</span>`;
}

/* ---------- merchant logos ---------- */
// Common merchants -> domain for the favicon proxy (Plaid's logo_url wins when present).
const MERCHANT_DOMAINS = [
  ["uber eats", "ubereats.com"], ["uber", "uber.com"], ["lyft", "lyft.com"], ["doordash", "doordash.com"],
  ["amazon", "amazon.com"], ["target", "target.com"], ["walmart", "walmart.com"], ["costco", "costco.com"],
  ["kroger", "kroger.com"], ["meijer", "meijer.com"], ["aldi", "aldi.us"], ["lidl", "lidl.com"], ["trader joe", "traderjoes.com"],
  ["whole foods", "wholefoodsmarket.com"], ["cvs", "cvs.com"], ["walgreens", "walgreens.com"],
  ["spotify", "spotify.com"], ["netflix", "netflix.com"], ["hulu", "hulu.com"], ["disney", "disneyplus.com"], ["youtube", "youtube.com"],
  ["apple", "apple.com"], ["google", "google.com"], ["microsoft", "microsoft.com"], ["adobe", "adobe.com"],
  ["claude.ai", "claude.ai"], ["anthropic", "anthropic.com"], ["openai", "openai.com"], ["chatgpt", "openai.com"],
  ["cursor", "cursor.com"], ["github", "github.com"], ["cloudflare", "cloudflare.com"], ["vercel", "vercel.com"],
  ["twitterapi", "twitterapi.io"], ["transcriptapi", "transcriptapi.com"], ["goodnotes", "goodnotes.com"], ["notion", "notion.so"],
  ["starbucks", "starbucks.com"], ["dunkin", "dunkindonuts.com"], ["mcdonald", "mcdonalds.com"], ["chipotle", "chipotle.com"],
  ["chick-fil-a", "chick-fil-a.com"], ["taco bell", "tacobell.com"], ["wendy", "wendys.com"], ["panera", "panerabread.com"],
  ["raising cane", "raisingcanes.com"], ["tim hortons", "timhortons.com"], ["subway", "subway.com"], ["domino", "dominos.com"],
  ["shell", "shell.com"], ["bp ", "bp.com"], ["exxon", "exxon.com"], ["marathon", "marathonpetroleum.com"], ["speedway", "speedway.com"],
  ["love's", "loves.com"], ["loves travel", "loves.com"], ["maverik", "maverik.com"], ["circle k", "circlek.com"],
  ["delta", "delta.com"], ["united", "united.com"], ["american airlines", "aa.com"], ["southwest", "southwest.com"],
  ["airbnb", "airbnb.com"], ["hilton", "hilton.com"], ["marriott", "marriott.com"], ["meininger", "meininger-hotels.com"],
  ["public storage", "publicstorage.com"], ["etsy", "etsy.com"], ["ebay", "ebay.com"], ["steam", "steampowered.com"],
  ["draftkings", "draftkings.com"], ["fanduel", "fanduel.com"], ["planet fitness", "planetfitness.com"],
  ["purdue", "purdue.edu"], ["dept education", "ed.gov"], ["irs", "irs.gov"], ["usataxpymt", "irs.gov"],
  ["spacex", "spacex.com"], ["space explorat", "spacex.com"], ["fidelity", "fidelity.com"], ["venmo", "venmo.com"],
  ["paypal", "paypal.com"], ["zelle", "zellepay.com"], ["apple cash", "apple.com"], ["cash app", "cash.app"],
  ["t-mobile", "t-mobile.com"], ["verizon", "verizon.com"], ["at&t", "att.com"], ["xfinity", "xfinity.com"], ["comcast", "xfinity.com"],
  ["home depot", "homedepot.com"], ["lowe's", "lowes.com"], ["best buy", "bestbuy.com"], ["ikea", "ikea.com"],
  ["discover", "discover.com"], ["american express", "americanexpress.com"], ["bank of america", "bankofamerica.com"],
  ["capital one", "capitalone.com"], ["chase", "chase.com"], ["appfolio", "appfolio.com"],
];

const masked = (s) => !s || /^[\s*#\-_.0-9]*$/.test(s);

/** Display name: cleaned merchant unless it is masked/garbled, then a tidied raw name. */
export function merchantLabel(t) {
  const m = (t.merchant_name || "").trim();
  if (m && !masked(m)) return m;
  const raw = (t.name || "").trim();
  // Drop bank boilerplate ("DES:", "ID:", "INDN:", "CO ID:", confirmation numbers).
  const cut = raw.split(/\s+(?:DES|ID|INDN|CO ID|PMT INFO|CONF#|Conf#|Confirmation#|Confirmation)[:\s#]/i)[0];
  return (cut || raw || "Unknown").replace(/\s{2,}/g, " ").slice(0, 60);
}

export function merchantDomain(t) {
  if (t.website) return String(t.website).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const n = `${t.merchant_name || ""} ${t.name || ""}`.toLowerCase();
  for (const [k, d] of MERCHANT_DOMAINS) if (n.includes(k)) return d;
  return null;
}

function hue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function monogram(name, { size = 30, cls = "" } = {}) {
  const h = hue(name);
  return `<span class="brand-tile mono-tile ${cls}" style="width:${size}px;height:${size}px;background:hsl(${h} 22% 20%);color:hsl(${h} 60% 78%)">${esc(initials(name))}</span>`;
}

/** Merchant tile: Plaid logo, proxied favicon, or monogram (with image-error fallback to monogram). */
export function merchantTile(t, { size = 30 } = {}) {
  const label = merchantLabel(t);
  const n = `${t.merchant_name || ""} ${t.name || ""}`.toLowerCase();
  if (n.includes("venmo")) return `<span class="brand-tile" style="width:${size}px;height:${size}px">${BRANDS.venmo.svg}</span>`;
  if (n.includes("zelle")) return `<span class="brand-tile" style="width:${size}px;height:${size}px">${BRANDS.zelle.svg}</span>`;
  if (n.includes("apple cash")) return `<span class="brand-tile" style="width:${size}px;height:${size}px">${BRANDS.applecash.svg}</span>`;
  const src = t.logo_url || (merchantDomain(t) ? `/api/logo?domain=${encodeURIComponent(merchantDomain(t))}` : null);
  if (!src) return monogram(label, { size });
  const fallback = monogram(label, { size }).replace(/"/g, "&quot;");
  return `<span class="brand-tile img" style="width:${size}px;height:${size}px"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentNode.outerHTML='${fallback.replace(/'/g, "\\'")}'"></span>`;
}
