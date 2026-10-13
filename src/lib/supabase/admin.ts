import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. It BYPASSES RLS, so use it only on the server
 * for writes users aren't allowed to make themselves (inserting generated
 * ideas), always with a user_id taken from a verified getUser() — never from
 * the request. Never import it from client code.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
