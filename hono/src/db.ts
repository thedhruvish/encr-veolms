import { neon } from "@neondatabase/serverless";

/**
 * Creates a Neon serverless SQL client.
 *
 * Uses @neondatabase/serverless which works natively in Cloudflare Workers
 * via Neon's HTTP transport — no Hyperdrive, no TCP, no connection pooling config.
 *
 * The connection string is read from DATABASE_URL:
 *   - Local dev:    set in .dev.vars  (loaded by `wrangler dev` automatically)
 *   - Production:   set as a Worker secret via `wrangler secret put DATABASE_URL`
 *
 * No ORM — raw tagged-template SQL only (MVP).
 *
 * Usage:
 *   const sql = createDb(c.env);
 *   const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
 */
export function createDb(env?: CloudflareBindings) {
  const connectionString =
    env?.DATABASE_URL ||
    (typeof process !== "undefined" ? process.env.DATABASE_URL : undefined);

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .dev.vars (local) or run: wrangler secret put DATABASE_URL"
    );
  }

  return neon(connectionString);
}

export type Db = ReturnType<typeof createDb>;
