import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { SOURCE_TYPES, type SourceType } from "@/lib/profile/schema";
import { createClient } from "@/lib/supabase/server";
import { OnboardingFlow, type SavedProfile } from "./onboarding-flow";

export const metadata: Metadata = { title: "Set up your profile" };

export default async function OnboardingPage() {
  const user = await requireUser();

  const supabase = await createClient();
  const { data: profile, error } = await supabase
    .from("business_profiles")
    .select("business_name, industry, product_description, target_customer, brand_tone, source_type, source_url")
    .maybeSingle();
  if (error) throw new Error(`Failed to load business profile: ${error.message}`);

  // Existing profile → skip step 1 and open the review form pre-filled.
  const saved: SavedProfile | null = profile
    ? {
        values: {
          business_name: profile.business_name ?? "",
          industry: profile.industry ?? "",
          product_description: profile.product_description ?? "",
          target_customer: profile.target_customer ?? "",
          brand_tone: profile.brand_tone ?? "",
        },
        sourceType: (SOURCE_TYPES as readonly string[]).includes(profile.source_type ?? "")
          ? (profile.source_type as SourceType)
          : "manual",
        sourceUrl: profile.source_url ?? null,
      }
    : null;

  return (
    <div className="flex flex-1 flex-col">
      <AppHeader email={user.email} />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 pt-14 pb-20">
        <OnboardingFlow saved={saved} />
      </main>
    </div>
  );
}
