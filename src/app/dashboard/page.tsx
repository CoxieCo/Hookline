import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { FIELD_LABELS, PROFILE_FIELDS } from "@/lib/profile/schema";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  // Verified server-side on every render; the proxy redirect is only a fast path.
  const user = await requireUser();

  const supabase = await createClient();
  // RLS scopes this to the signed-in user's row.
  const { data: profile, error } = await supabase
    .from("business_profiles")
    .select("business_name, industry, product_description, target_customer, brand_tone, source_type, source_url")
    .maybeSingle();
  if (error) throw new Error(`Failed to load business profile: ${error.message}`);

  // New users (including fresh signups) set up their profile first.
  if (!profile) redirect("/onboarding");

  const summary = PROFILE_FIELDS.filter((f) => f !== "business_name");

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1.5 text-muted">Content ideas for your store will live here.</p>

        <section className="mt-10 rounded-lg border border-border bg-surface">
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-subtle">Business profile</p>
              <h2 className="mt-1 truncate text-[15px] font-medium">{profile.business_name || "Untitled business"}</h2>
              {profile.source_url && (
                <p className="mt-0.5 truncate text-[13px] text-muted">{profile.source_url}</p>
              )}
            </div>
            <Link
              href="/onboarding"
              className="shrink-0 rounded-md border border-border-strong bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-[#1c1d20]"
            >
              Edit profile
            </Link>
          </div>
          <dl className="grid gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-2">
            {summary.map((field) => (
              <div key={field} className={field === "product_description" ? "sm:col-span-2" : undefined}>
                <dt className="text-[13px] text-muted">{FIELD_LABELS[field]}</dt>
                <dd className="mt-1 whitespace-pre-line leading-relaxed">{profile[field] || "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
    </div>
  );
}
