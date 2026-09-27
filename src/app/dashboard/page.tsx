import type { Metadata } from "next";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../(auth)/actions";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  // Verified server-side on every render; the proxy redirect is only a fast path.
  const user = await requireUser();

  const supabase = await createClient();
  // RLS scopes this to the signed-in user's row.
  const { data: profile } = await supabase
    .from("business_profiles")
    .select("id")
    .maybeSingle();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <Logo href="/dashboard" />
        <div className="flex items-center gap-3">
          <span className="hidden text-[13px] text-muted sm:inline">{user.email}</span>
          <form action={signOut}>
            <Button type="submit" variant="ghost" className="h-8 px-2.5">
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1.5 text-muted">Content ideas for your store will live here.</p>

        <section className="mt-10 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-[15px] font-medium">Business profile</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {profile
              ? "Your business profile is set up."
              : "You haven't set up a business profile yet. Hookline uses it to tailor ideas to your products, customers and brand tone."}
          </p>
        </section>
      </main>
    </div>
  );
}
