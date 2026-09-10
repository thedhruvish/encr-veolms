import { neon } from "@neondatabase/serverless";

export const DEFAULT_DATABASE_URL =
  "postgresql://neondb_owner:npg_Q9f1jeSMVwFJ@ep-nameless-glitter-ayzqhmzw-pooler.c-5.us-east-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require";

/**
 * Creates a Neon serverless SQL client.
 *
 * Uses @neondatabase/serverless which works natively in Cloudflare Workers
 * via Neon's HTTP transport.
 *
 * Priority for connection string:
 * 1. env.DATABASE_URL (Worker binding / secret)
 * 2. process.env.DATABASE_URL (local Bun/Node scripts)
 * 3. DEFAULT_DATABASE_URL (failsafe fallback for production Worker)
 *
 * No ORM — raw tagged-template SQL only (MVP).
 */
export function createDb(env?: CloudflareBindings) {
  const connectionString =
    env?.DATABASE_URL ||
    (typeof process !== "undefined" ? process.env.DATABASE_URL : undefined) ||
    DEFAULT_DATABASE_URL;

  return neon(connectionString);
}

export type Db = ReturnType<typeof createDb>;
