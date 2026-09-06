export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  /** Comma-separated emails allowed through Cloudflare Access (defense in depth). */
  ALLOWED_EMAILS?: string;
}

/** Cloudflare Access context attached to the ExecutionContext when the Worker is protected by Access. */
export interface AccessContext {
  aud: string;
  getIdentity(): Promise<{ email?: string; name?: string; groups?: string[] } | null | undefined>;
}
