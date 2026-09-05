// GET /api/export/csv?table=transactions|holdings — CSV download.
import { Hono } from "hono";
import type { Env } from "../types";
import { q, bad } from "./util";

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const exportcsv = new Hono<{ Bindings: Env }>();

exportcsv.get("/csv", async (c) => {
  const table = c.req.query("table") ?? "transactions";

  if (table === "transactions") {
    const rows = await q<{
      id: string;
      date: string;
      name: string;
      merchant_name: string | null;
      amount: number;
      pending: number;
      category: string | null;
      account: string;
      mask: string | null;
      is_transfer: number;
      excluded: number;
      notes: string | null;
    }>(
      c.env,
      `SELECT t.id, t.date, t.name, t.merchant_name, t.amount, t.pending,
              c.name AS category, a.name AS account, a.mask AS mask,
              t.is_transfer, t.excluded, t.notes
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       JOIN accounts a ON a.id = t.account_id
       ORDER BY t.date DESC, t.id DESC`,
    );
    const csv = toCsv(
      ["id", "date", "name", "merchant", "amount", "pending", "category", "account", "mask", "is_transfer", "excluded", "notes"],
      rows.map((r) => [r.id, r.date, r.name, r.merchant_name, r.amount, r.pending, r.category, r.account, r.mask, r.is_transfer, r.excluded, r.notes]),
    );
    return csvResponse(csv, "transactions.csv");
  }

  if (table === "holdings") {
    const rows = await q<{
      account: string;
      ticker: string | null;
      security: string | null;
      type: string | null;
      quantity: number;
      cost_basis: number | null;
      value: number | null;
      as_of: string | null;
    }>(
      c.env,
      `SELECT a.name AS account, s.ticker AS ticker, s.name AS security, s.type AS type,
              h.quantity, h.cost_basis, h.value, h.as_of
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       LEFT JOIN securities s ON s.id = h.security_id
       ORDER BY a.name, s.ticker`,
    );
    const csv = toCsv(
      ["account", "ticker", "security", "type", "quantity", "cost_basis", "value", "as_of"],
      rows.map((r) => [r.account, r.ticker, r.security, r.type, r.quantity, r.cost_basis, r.value, r.as_of]),
    );
    return csvResponse(csv, "holdings.csv");
  }

  return bad(c, "table must be transactions or holdings");
});
