import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side auth gate for protected pages and actions. Verifies the user
 * with the Supabase Auth server (not just the cookie), and redirects to /login
 * if there is no valid session. Memoised per render pass.
 */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return user;
});

/** Only allow same-origin relative paths, to prevent open redirects. */
export function safeNextPath(next: unknown, fallback = "/dashboard") {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return fallback;
  }
  return next;
}
