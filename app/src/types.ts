export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
}
