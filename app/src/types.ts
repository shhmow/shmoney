export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  /** Comma-separated emails allowed through Cloudflare Access (defense in depth). */
  ALLOWED_EMAILS?: string;
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access application audience (AUD) tag, from Zero Trust -> Access -> Applications. */
  ACCESS_AUD?: string;
  /** Public URL of this deployment (Plaid redirect/webhook). Defaults to the request origin. */
  APP_URL?: string;
}

/** Cloudflare Access context attached to the ExecutionContext when the Worker is protected by Access. */
export interface AccessContext {
  aud: string;
  getIdentity(): Promise<{ email?: string; name?: string; groups?: string[] } | null | undefined>;
}
