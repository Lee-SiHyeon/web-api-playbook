import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | undefined;

export function getSupabaseAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase server credentials are not configured.');
  adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return adminClient;
}

/**
 * Public HTTP pages use the server credential only to read the bounded
 * published catalog projections. Never add raw-table queries to this path.
 */
export function getSupabaseCatalogReadClient(): SupabaseClient {
  return getSupabaseAdminClient();
}
