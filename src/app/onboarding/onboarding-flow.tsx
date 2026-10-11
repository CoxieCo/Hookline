"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import type { ExtractResponse } from "@/app/api/profile/extract/route";
import { Button, Input, Label, Textarea } from "@/components/ui";
import {
  EMPTY_PROFILE,
  FIELD_LABELS,
  FIELD_LIMITS,
  PROFILE_FIELDS,
  type Confidence,
  type ProfileField,
  type ProfileValues,
  type SourceType,
} from "@/lib/profile/schema";
import { saveProfile } from "./actions";

export type SavedProfile = {
  values: ProfileValues;
  sourceType: SourceType;
  sourceUrl: string | null;
};

type Draft = SavedProfile & {
  origin: "ai" | "manual" | "saved";
  confidence?: Confidence;
  failure?: string;
};

type Step =
  | { name: "input"; error?: string }
  | { name: "loading"; target: string }
  | { name: "review"; draft: Draft };

const MANUAL_DRAFT: Draft = { values: EMPTY_PROFILE, sourceType: "manual", sourceUrl: null, origin: "manual" };

function describeTarget(input: string) {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) return trimmed;
  try {
    return new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, "");
  } catch {
    return trimmed;
  }
}

export function OnboardingFlow({ saved }: { saved: SavedProfile | null }) {
  const [step, setStep] = useState<Step>(
    saved ? { name: "review", draft: { ...saved, origin: "saved" } } : { name: "input" },
  );
  const abortRef = useRef<AbortController | null>(null);
  const router = useRouter();

  async function build(input: string) {
    const controller = new AbortController();
    abortRef.current = controller;
    setStep({ name: "loading", target: describeTarget(input) });

    let data: ExtractResponse | null = null;
    try {
      const res = await fetch("/api/profile/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal: controller.signal,
      });
      data = await res.json().catch(() => null);
    } catch {
      if (controller.signal.aborted) return;
    }

    if (!data) {
      setStep({
        name: "review",
        draft: { ...MANUAL_DRAFT, failure: "We couldn't reach Hookline just now." },
      });
    } else if (data.ok) {
      setStep({
        name: "review",
        draft: {
          values: {
            business_name: data.profile.business_name,
            industry: data.profile.industry,
            product_description: data.profile.product_description,
            target_customer: data.profile.target_customer,
            brand_tone: data.profile.brand_tone,
          },
          sourceType: data.source.type,
          sourceUrl: data.source.url,
          origin: "ai",
          confidence: data.profile.confidence,
        },
      });
    } else if (data.reason === "invalid_input") {
      setStep({ name: "input", error: data.message });
    } else if (data.reason === "unauthorized") {
      router.push("/login?next=/onboarding");
    } else {
      setStep({ name: "review", draft: { ...MANUAL_DRAFT, failure: data.message } });
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setStep({ name: "input" });
  }

  switch (step.name) {
    case "input":
      return (
        <SourceStep
          error={step.error}
          onSubmit={build}
          onManual={() => setStep({ name: "review", draft: MANUAL_DRAFT })}
        />
      );
    case "loading":
      return <LoadingStep target={step.target} onCancel={cancel} />;
    case "review":
      return <ReviewStep draft={step.draft} onStartOver={() => setStep({ name: "input" })} />;
  }
}

// --- Step 1 -----------------------------------------------------------------

function SourceStep({
  error,
  onSubmit,
  onManual,
}: {
  error?: string;
  onSubmit: (input: string) => void;
  onManual: () => void;
}) {
  const [value, setValue] = useState("");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Tell us about your business</h1>
      <p className="mt-2 leading-relaxed text-muted">
        We&apos;ll read your store or profile and draft a business profile you can edit. Hookline uses it to tailor
        content ideas to what you sell and who you sell to.
      </p>

      <form
        className="mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <Label htmlFor="source">Paste your website or Instagram/TikTok handle</Label>
        <Input
          id="source"
          name="source"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="yourstore.com or @yourbrand"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={2048}
          autoFocus
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "source-error" : undefined}
        />
        {error && (
          <p id="source-error" role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-2">
          <Button type="submit" disabled={!value.trim()}>
            Build my profile
          </Button>
          <button
            type="button"
            onClick={onManual}
            className="text-[13px] text-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
          >
            I&apos;d rather type it myself
          </button>
        </div>
      </form>
    </div>
  );
}

// --- Step 2 -----------------------------------------------------------------

function LoadingStep({ target, onCancel }: { target: string; onCancel: () => void }) {
  return (
    <div aria-busy="true">
      <h1 className="text-2xl font-semibold tracking-tight">Building your profile</h1>
      <p role="status" className="mt-2 flex items-center gap-2 text-muted">
        <span className="size-3.5 animate-spin rounded-full border-2 border-border-strong border-t-fg" aria-hidden />
        Reading <span className="text-fg">{target}</span> and drafting your profile…
      </p>

      <div className="mt-8 space-y-5 rounded-lg border border-border bg-surface p-6" aria-hidden>
        {PROFILE_FIELDS.map((field) => (
          <div key={field} className="space-y-2">
            <div className="h-3 w-28 animate-pulse rounded bg-surface-2" />
            <div
              className={`animate-pulse rounded-md bg-surface-2 ${
                field === "business_name" || field === "industry" ? "h-9" : "h-16"
              }`}
            />
          </div>
        ))}
      </div>

      <Button type="button" variant="ghost" className="mt-4 -ml-2.5" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

// --- Step 3 -----------------------------------------------------------------

const MULTILINE: ProfileField[] = ["product_description", "target_customer"];

function listFields(fields: ProfileField[]) {
  const names = fields.map((f) => FIELD_LABELS[f]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function ReviewStep({ draft, onStartOver }: { draft: Draft; onStartOver: () => void }) {
  const [values, setValues] = useState<ProfileValues>(draft.values);
  const [state, action, pending] = useActionState(saveProfile, undefined);

  const emptyFields = PROFILE_FIELDS.filter((f) => !values[f].trim());
  const showAttention = draft.origin === "ai" && (draft.confidence === "low" || emptyFields.length > 0);

  const subtitle =
    draft.origin === "ai"
      ? "We drafted this from what we could read. Check each field and edit anything that's off."
      : draft.origin === "saved"
        ? "Update anything that's changed. Hookline uses this to tailor your content ideas."
        : "Describe your business in your own words. Hookline uses this to tailor your content ideas.";

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Review your profile</h1>
      <p className="mt-2 leading-relaxed text-muted">{subtitle}</p>
      {draft.sourceUrl && draft.origin !== "manual" && (
        <p className="mt-1 truncate text-[13px] text-subtle">Source: {draft.sourceUrl}</p>
      )}

      {draft.failure && (
        <div role="alert" className="mt-6 rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-[13px]">
          <p className="font-medium text-fg">{draft.failure}</p>
          <p className="mt-0.5 text-muted">Fill in the details below instead — it only takes a minute.</p>
        </div>
      )}

      {showAttention && (
        <div
          role="status"
          className="mt-6 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] leading-relaxed"
        >
          {draft.confidence === "low" && (
            <p className="text-fg">We had limited information to go on, so please double-check every field.</p>
          )}
          {emptyFields.length > 0 && (
            <p className="text-fg">
              Needs your attention: <span className="font-medium">{listFields(emptyFields)}</span>{" "}
              {emptyFields.length === 1 ? "is" : "are"} empty — we couldn&apos;t find {emptyFields.length === 1 ? "it" : "them"} on
              the page.
            </p>
          )}
        </div>
      )}

      <form action={action} className="mt-8 space-y-5">
        <input type="hidden" name="source_type" value={draft.sourceType} />
        <input type="hidden" name="source_url" value={draft.sourceUrl ?? ""} />

        {PROFILE_FIELDS.map((field) => {
          const error = state?.fieldErrors?.[field];
          const common = {
            id: field,
            name: field,
            value: values[field],
            maxLength: FIELD_LIMITS[field],
            required: true,
            "aria-invalid": Boolean(error),
            "aria-describedby": error ? `${field}-error` : undefined,
            className: error ? "border-danger" : undefined,
            onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setValues((v) => ({ ...v, [field]: e.target.value })),
          };
          return (
            <div key={field} className="space-y-1.5">
              <Label htmlFor={field}>{FIELD_LABELS[field]}</Label>
              {MULTILINE.includes(field) ? (
                <Textarea rows={field === "product_description" ? 4 : 3} {...common} />
              ) : field === "brand_tone" ? (
                <Textarea rows={2} placeholder="e.g. playful, confident, casual" {...common} />
              ) : (
                <Input {...common} />
              )}
              {error && (
                <p id={`${field}-error`} className="text-[13px] text-danger">
                  {error}
                </p>
              )}
            </div>
          );
        })}

        {state?.error && (
          <p role="alert" className="text-[13px] text-danger">
            {state.error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save and continue"}
          </Button>
          <Button type="button" variant="secondary" onClick={onStartOver} disabled={pending}>
            Start over
          </Button>
        </div>
      </form>
    </div>
  );
}
