import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { IDEA_COLUMNS, type Idea } from "@/lib/ideas/schema";
import { PROFILE_FIELDS } from "@/lib/profile/schema";
import { createClient } from "@/lib/supabase/server";
import { IdeasBoard } from "./ideas-board";

export const metadata: Metadata = { title: "Dashboard" };

/** How many non-dismissed ideas the dashboard shows (newest first). */
const IDEAS_SHOWN = 60;

export default async function DashboardPage() {
  // Verified server-side on every render; the proxy redirect is only a fast path.
  const user = await requireUser();

  const supabase = await createClient();
  // RLS scopes this to the signed-in user's row. maybeSingle() returns
  // { data: null, error: null } when there is no row, so "no profile" and
  // "query failed" stay distinct: a real error is thrown, never treated as empty.
  const { data: profile, error } = await supabase
    .from("business_profiles")
    .select("business_name, industry, product_description, target_customer, brand_tone, source_type, source_url")
    .maybeSingle();
  if (error) throw new Error(`Failed to load business profile: ${error.message}`);

  // New users (including fresh signups) set up their profile first.
  // ONBOARDING_REDIRECT=off disables this so the empty-state card below can be tested.
  if (!profile && process.env.ONBOARDING_REDIRECT !== "off") redirect("/onboarding");

  let ideas: Idea[] = [];
  let ideasLoadFailed = false;
  if (profile) {
    // Dismissed ideas are hidden. created_at is shared within a batch, so id
    // keeps the order stable across reloads.
    const { data, error: ideasError } = await supabase
      .from("generated_ideas")
      .select(IDEA_COLUMNS)
      .neq("status", "dismissed")
      .order("created_at", { ascending: false })
      .order("id")
      .limit(IDEAS_SHOWN);
    // Not fatal: the profile and the Generate button still work without history.
    if (ideasError) {
      console.error("[dashboard] ideas load failed", ideasError.message);
      ideasLoadFailed = true;
    } else {
      ideas = data as Idea[];
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1.5 text-muted">Short-form video ideas written for your store.</p>

        {profile ? (
          <>
            <ProfileSummary profile={profile} />
            <IdeasBoard
              initialIdeas={ideas}
              loadFailed={ideasLoadFailed}
              businessName={profile.business_name || "your store"}
            />
          </>
        ) : (
          <ProfileEmptyState />
        )}
      </main>
    </div>
  );
}

function ProfileEmptyState() {
  return (
    <section className="mt-10 rounded-lg border border-border bg-surface px-6 py-8" data-testid="profile-empty">
      <p className="text-xs font-medium uppercase tracking-wider text-subtle">Business profile</p>
      <h2 className="mt-1 text-[15px] font-medium">You haven&apos;t set up a business profile yet</h2>
      <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted">
        Hookline uses it to tailor ideas to your products, customers and brand tone. It takes about a minute.
      </p>
      <Link
        href="/onboarding"
        className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-fg px-3.5 text-[13px] font-medium text-bg transition-colors hover:bg-white"
      >
        Set up your profile
      </Link>
    </section>
  );
}

type Profile = Record<(typeof PROFILE_FIELDS)[number] | "source_type" | "source_url", string | null>;

function ProfileSummary({ profile }: { profile: Profile }) {
  const meta = [profile.industry, profile.brand_tone].filter(Boolean).join(" · ");

  return (
    <section
      className="mt-8 flex items-start justify-between gap-4 rounded-lg border border-border bg-surface px-5 py-4"
      data-testid="profile-summary"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-subtle">Business profile</p>
        <h2 className="mt-1 truncate text-[15px] font-medium">{profile.business_name || "Untitled business"}</h2>
        {meta && <p className="mt-0.5 truncate text-[13px] text-muted">{meta}</p>}
        {profile.product_description && (
          <p className="mt-1.5 line-clamp-2 max-w-prose text-[13px] leading-relaxed text-muted">
            {profile.product_description}
          </p>
        )}
      </div>
      <Link
        href="/onboarding"
        className="shrink-0 rounded-md border border-border-strong bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-[#1c1d20]"
      >
        Edit profile
      </Link>
    </section>
  );
}
