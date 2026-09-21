/**
 * Server-side Supabase client.
 *
 * Uses the secret key, which bypasses RLS. `extraction_jobs` has RLS enabled
 * with no policies, so this client is the only thing that can read or write
 * it — the browser never touches the table directly.
 *
 * Importing this file from anything that runs in the browser would leak the
 * key into the client bundle. It is only ever imported by route handlers and
 * the worker.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class MissingConfigError extends Error {
  constructor(name: string) {
    super(
      `${name} is not set. Copy .env.example to .env.local and fill it in — ` +
        `the extraction service cannot reach Supabase without it.`,
    );
    this.name = 'MissingConfigError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new MissingConfigError(name);
  return value;
}

export const BUCKET = process.env.SUPABASE_BUCKET ?? 'documents';

let cached: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SECRET_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  return cached;
}
