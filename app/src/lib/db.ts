import type { Env } from "../types";

// Minimal structural view of D1 so this module type-checks with or without
// @cloudflare/workers-types in scope.
export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<RunResult>;
}

export interface RunResult {
  meta: { changes: number; last_row_id: number };
}

interface Db {
  prepare(sql: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<unknown[]>;
}

function db(env: Env): Db {
  return env.DB as unknown as Db;
}

/** All rows. */
export async function q<T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await db(env).prepare(sql).bind(...binds).all<T>();
  return res.results ?? [];
}

/** First row or null. */
export async function first<T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  return db(env).prepare(sql).bind(...binds).first<T>();
}

/** Execute a write statement. */
export async function run(env: Env, sql: string, ...binds: unknown[]): Promise<RunResult> {
  return db(env).prepare(sql).bind(...binds).run();
}

/** Build a prepared statement for use with batch(). */
export function stmt(env: Env, sql: string, ...binds: unknown[]): PreparedStatement {
  return db(env).prepare(sql).bind(...binds);
}

/** Run statements in chunked batches (each batch is a single D1 round trip). */
export async function batch(env: Env, statements: PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += 100) {
    await db(env).batch(statements.slice(i, i + 100));
  }
}
