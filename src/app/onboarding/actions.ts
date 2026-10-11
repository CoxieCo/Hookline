"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ProfileFormSchema, PROFILE_FIELDS, type ProfileField } from "@/lib/profile/schema";
import { createClient } from "@/lib/supabase/server";

export type SaveProfileState =
  | {
      error?: string;
      fieldErrors?: Partial<Record<ProfileField, string>>;
    }
  | undefined;

export async function saveProfile(_prev: SaveProfileState, formData: FormData): Promise<SaveProfileState> {
  const user = await requireUser();

  const raw = Object.fromEntries(
    [...PROFILE_FIELDS, "source_type", "source_url"].map((key) => {
      const value = formData.get(key);
      return [key, typeof value === "string" ? value : undefined];
    }),
  );

  const parsed = ProfileFormSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<ProfileField, string>> = {};
    let error = "Please fix the highlighted fields.";
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && (PROFILE_FIELDS as readonly string[]).includes(key)) {
        fieldErrors[key as ProfileField] ??= issue.message;
      } else {
        error = issue.message;
      }
    }
    return { error, fieldErrors };
  }

  const supabase = await createClient();
  // One profile per user: user_id is unique, so this inserts the first time
  // and updates afterwards. RLS independently enforces user_id = auth.uid().
  const { error } = await supabase
    .from("business_profiles")
    .upsert({ ...parsed.data, user_id: user.id }, { onConflict: "user_id" });

  if (error) {
    console.error("[onboarding] save failed", error.message);
    return { error: "We couldn't save your profile. Please try again." };
  }

  redirect("/dashboard");
}
