"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { StatusResponse } from "@/app/api/ideas/[id]/route";
import type { GenerateResponse } from "@/app/api/ideas/generate/route";
import { Button } from "@/components/ui";
import { GENERATION_LIMIT, IDEAS_FAILURE_MESSAGES, type IdeasFailure } from "@/lib/ideas/errors";
import { IDEAS_PER_BATCH, type Idea, type IdeaStatus } from "@/lib/ideas/schema";

const NETWORK_FAILURE: IdeasFailure = {
  ok: false,
  reason: "server_error",
  message: "We couldn't reach Hookline. Check your connection and try again.",
};

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function IdeasBoard({
  initialIdeas,
  loadFailed,
  businessName,
}: {
  initialIdeas: Idea[];
  loadFailed: boolean;
  businessName: string;
}) {
  const [ideas, setIdeas] = useState(initialIdeas);
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<IdeasFailure | null>(null);
  const inFlight = useRef(false);

  async function generate() {
    if (inFlight.current) return;
    inFlight.current = true;
    setGenerating(true);
    setFailure(null);
    try {
      const res = await fetch("/api/ideas/generate", { method: "POST" });
      const data = await readJson<GenerateResponse>(res);
      if (data?.ok) {
        setIdeas((prev) => [...data.ideas, ...prev]);
      } else {
        setFailure(
          data ?? { ok: false, reason: "server_error", message: IDEAS_FAILURE_MESSAGES.server_error },
        );
      }
    } catch {
      setFailure(NETWORK_FAILURE);
    } finally {
      inFlight.current = false;
      setGenerating(false);
    }
  }

  function replaceIdea(id: string, next: Idea | null) {
    setIdeas((prev) => (next ? prev.map((i) => (i.id === id ? next : i)) : prev.filter((i) => i.id !== id)));
  }

  const batches = groupByBatch(ideas);

  return (
    <section className="mt-10" aria-labelledby="ideas-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="ideas-heading" className="text-lg font-semibold tracking-tight">
            Content ideas
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            {IDEAS_PER_BATCH} ideas per batch, up to {GENERATION_LIMIT} batches every 24 hours.
          </p>
        </div>
        <Button type="button" onClick={generate} disabled={generating} className="h-10 px-4">
          {generating ? "Generating…" : "Generate ideas"}
        </Button>
      </div>

      {failure && <GenerateError failure={failure} onRetry={generate} />}

      {loadFailed && (
        <p role="alert" className="mt-6 rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-[13px]">
          We couldn&apos;t load your earlier ideas. New ones will still appear here.
        </p>
      )}

      {generating && <GeneratingState businessName={businessName} />}

      {!generating && ideas.length === 0 && !loadFailed && (
        <div
          className="mt-6 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center"
          data-testid="ideas-empty"
        >
          <p className="text-[15px] font-medium">No ideas yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">
            Click <span className="text-fg">Generate ideas</span> and Hookline will write {IDEAS_PER_BATCH} short-form
            video ideas for {businessName}: a hook, the beats, how to film it and a caption.
          </p>
        </div>
      )}

      {batches.map((batch, index) => (
        <div key={batch.id} className="mt-8" data-testid="idea-batch">
          <h3 className="flex items-baseline gap-2 text-[13px] font-medium text-muted">
            {index === 0 ? "Latest batch" : "Earlier batch"}
            <time dateTime={batch.createdAt} className="text-subtle" suppressHydrationWarning>
              {formatWhen(batch.createdAt)}
            </time>
          </h3>
          <div className="mt-3 space-y-4">
            {batch.ideas.map((idea) => (
              <IdeaCard key={idea.id} idea={idea} onChange={replaceIdea} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function GeneratingState({ businessName }: { businessName: string }) {
  return (
    <div className="mt-6" aria-busy="true" data-testid="ideas-loading">
      <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
        <span className="size-3.5 animate-spin rounded-full border-2 border-border-strong border-t-fg" aria-hidden />
        Writing {IDEAS_PER_BATCH} ideas for <span className="text-fg">{businessName}</span>… this usually takes
        20–40 seconds.
      </p>
      <div className="mt-4 space-y-4" aria-hidden>
        {Array.from({ length: IDEAS_PER_BATCH }, (_, i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-5" data-testid="idea-skeleton">
            <div className="h-5 w-20 animate-pulse rounded-full bg-surface-2" />
            <div className="mt-4 h-4 w-11/12 animate-pulse rounded bg-surface-2" />
            <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="mt-5 space-y-2">
              <div className="h-3 w-3/4 animate-pulse rounded bg-surface-2" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-surface-2" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GenerateError({ failure, onRetry }: { failure: IdeasFailure; onRetry: () => void }) {
  const retryClock = failure.retry_at
    ? new Date(failure.retry_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div
      role="alert"
      data-testid="generate-error"
      data-reason={failure.reason}
      className="mt-6 rounded-md border border-border-strong bg-surface-2 px-4 py-3 text-[13px]"
    >
      <p className="font-medium text-fg">
        {failure.message}
        {retryClock && <span className="font-normal text-muted"> (around {retryClock})</span>}
      </p>
      {failure.reason === "no_profile" && (
        <Link href="/onboarding" className="mt-2 inline-block font-medium text-accent underline-offset-4 hover:underline">
          Set up your profile
        </Link>
      )}
      {failure.reason === "unauthorized" && (
        <Link href="/login" className="mt-2 inline-block font-medium text-accent underline-offset-4 hover:underline">
          Log in again
        </Link>
      )}
      {(failure.reason === "model_failed" || failure.reason === "server_error") && (
        <Button type="button" variant="secondary" className="mt-3 h-8" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function IdeaCard({ idea, onChange }: { idea: Idea; onChange: (id: string, next: Idea | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const saved = idea.status === "saved";

  async function setStatus(status: IdeaStatus) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await readJson<StatusResponse>(res);
      if (data?.ok) {
        onChange(idea.id, status === "dismissed" ? null : { ...idea, status });
        return;
      }
      setError(data?.message ?? IDEAS_FAILURE_MESSAGES.server_error);
    } catch {
      setError(NETWORK_FAILURE.message);
    }
    setBusy(false);
  }

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(idea.caption);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2000);
  }

  return (
    <article
      data-testid="idea-card"
      data-status={idea.status}
      className={`rounded-lg border p-5 transition-colors ${
        saved ? "border-accent/50 bg-accent/[0.06]" : "border-border bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border-strong bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-fg">
          {idea.format}
        </span>
        {idea.duration_seconds != null && <span className="text-xs text-subtle">~{idea.duration_seconds}s</span>}
        {saved && (
          <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">Saved</span>
        )}
      </div>

      <p className="mt-3 text-[17px] leading-snug font-medium text-fg" data-testid="idea-hook">
        {idea.hook}
      </p>

      <ol className="mt-4 space-y-1.5">
        {idea.script_beats.map((beat, i) => (
          <li key={i} className="flex gap-3 text-[13px] leading-relaxed">
            <span className="w-4 shrink-0 text-right font-mono text-subtle">{i + 1}</span>
            <span>{beat}</span>
          </li>
        ))}
      </ol>

      <div className="mt-5">
        <h4 className="text-xs font-medium uppercase tracking-wider text-subtle">How to film it</h4>
        <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-line text-muted">{idea.filming_instructions}</p>
      </div>

      {idea.caption && (
        <div className="mt-5">
          <h4 className="text-xs font-medium uppercase tracking-wider text-subtle">Caption</h4>
          <div className="mt-1.5 flex items-start gap-3 rounded-md border border-border bg-bg/40 px-3 py-2.5">
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed break-words">{idea.caption}</p>
            <Button type="button" variant="secondary" className="h-7 shrink-0 px-2.5 text-xs" onClick={copyCaption}>
              {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant={saved ? "primary" : "secondary"}
          aria-pressed={saved}
          disabled={busy}
          onClick={() => setStatus(saved ? "new" : "saved")}
          className="h-8"
        >
          {saved ? "Saved" : "Save"}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setStatus("dismissed")} className="h-8">
          Dismiss
        </Button>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}

type Batch = { id: string; createdAt: string; ideas: Idea[] };

/** Ideas arrive newest first; keep that order and group consecutive batch members. */
function groupByBatch(ideas: Idea[]): Batch[] {
  const batches: Batch[] = [];
  for (const idea of ideas) {
    const last = batches.at(-1);
    if (last?.id === idea.batch_id) last.ideas.push(idea);
    else batches.push({ id: idea.batch_id, createdAt: idea.created_at, ideas: [idea] });
  }
  return batches;
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
