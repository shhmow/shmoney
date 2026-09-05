import type { Env } from "../types";
import { batch, first, run, stmt } from "./db";
import { nowIso } from "./format";
import { syncItem } from "../sync";

const PLAID_BASE = "https://production.plaid.com";
const REDIRECT_URI = "https://shmoney.josephlove076.workers.dev/link/oauth";
const WEBHOOK_URL = "https://shmoney.josephlove076.workers.dev/api/webhooks/plaid";

export class PlaidError extends Error {
  error_code: string;
  error_message: string;

  constructor(errorCode: string, errorMessage: string) {
    super(`${errorCode}: ${errorMessage}`);
    this.name = "PlaidError";
    this.error_code = errorCode;
    this.error_message = errorMessage;
  }
}

export async function plaidPost<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${PLAID_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  });
  if (!res.ok) {
    let code = "UNKNOWN";
    let message = `Plaid ${path} failed with HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error_code?: string; error_message?: string };
      if (err.error_code) code = err.error_code;
      if (err.error_message) message = err.error_message;
    } catch {
      // non-JSON error body; keep the HTTP status message
    }
    throw new PlaidError(code, message);
  }
  return (await res.json()) as T;
}

// Minimal shape of a Plaid account as returned by /accounts/get,
// /transactions/sync and /investments/holdings/get.
export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}

export async function createLinkToken(env: Env, opts?: { accessToken?: string }): Promise<string> {
  const body: Record<string, unknown> = {
    client_name: "shmoney",
    user: { client_user_id: "shmoney" },
    language: "en",
    country_codes: ["US"],
    redirect_uri: REDIRECT_URI,
  };
  // Default history is ~90 days; request the maximum (2 years) on new links
  // and on update-mode relinks (which extends history for existing items).
  body.transactions = { days_requested: 730 };
  if (opts?.accessToken) {
    // Update mode: products must not be sent with an access_token.
    body.access_token = opts.accessToken;
  } else {
    // transactions is required everywhere; investments only where the
    // institution supports it — listing both as required makes Link reject
    // every bank that lacks investments (BofA, Amex, Discover).
    body.products = ["transactions"];
    body.required_if_supported_products = ["investments"];
    body.webhook = WEBHOOK_URL;
  }
  const res = await plaidPost<{ link_token: string }>(env, "/link/token/create", body);
  return res.link_token;
}

export async function exchangePublicToken(env: Env, publicToken: string): Promise<{ item_id: number }> {
  const ex = await plaidPost<{ access_token: string; item_id: string }>(env, "/item/public_token/exchange", {
    public_token: publicToken,
  });

  const itemRes = await plaidPost<{ item: { institution_id: string | null } }>(env, "/item/get", {
    access_token: ex.access_token,
  });
  const institutionId = itemRes.item.institution_id;
  let institutionName: string | null = null;
  if (institutionId) {
    try {
      const inst = await plaidPost<{ institution: { name: string } }>(env, "/institutions/get_by_id", {
        institution_id: institutionId,
        country_codes: ["US"],
      });
      institutionName = inst.institution.name;
    } catch {
      // Name is cosmetic; do not fail the link over it.
    }
  }

  await run(
    env,
    `INSERT INTO items (plaid_item_id, access_token, institution_id, institution_name)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(plaid_item_id) DO UPDATE SET
       access_token = excluded.access_token,
       institution_id = excluded.institution_id,
       institution_name = excluded.institution_name,
       status = 'active',
       last_error = NULL`,
    ex.item_id, ex.access_token, institutionId, institutionName,
  );
  const row = await first<{ id: number }>(env, "SELECT id FROM items WHERE plaid_item_id = ?", ex.item_id);
  if (!row) throw new Error("item row missing after insert");
  const itemId = row.id;

  const acct = await plaidPost<{ accounts: PlaidAccount[] }>(env, "/accounts/get", { access_token: ex.access_token });
  await upsertAccounts(env, itemId, acct.accounts);

  await syncItem(env, itemId);
  return { item_id: itemId };
}

// ON CONFLICT DO UPDATE (never INSERT OR REPLACE): a REPLACE would delete the
// existing row and cascade-delete its transactions, snapshots and holdings.
// Also preserves the user's `hidden` flag.
export async function upsertAccounts(env: Env, itemId: number, accounts: PlaidAccount[]): Promise<void> {
  const now = nowIso();
  const stmts = accounts.map((a) =>
    stmt(
      env,
      `INSERT INTO accounts (id, item_id, name, official_name, mask, type, subtype, currency,
                             current_balance, available_balance, credit_limit, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         official_name = excluded.official_name,
         mask = excluded.mask,
         type = excluded.type,
         subtype = excluded.subtype,
         currency = excluded.currency,
         current_balance = excluded.current_balance,
         available_balance = excluded.available_balance,
         credit_limit = excluded.credit_limit,
         updated_at = excluded.updated_at`,
      a.account_id, itemId, a.name, a.official_name, a.mask, a.type, a.subtype,
      a.balances.iso_currency_code ?? "USD",
      a.balances.current, a.balances.available, a.balances.limit, now,
    ),
  );
  await batch(env, stmts);
}
