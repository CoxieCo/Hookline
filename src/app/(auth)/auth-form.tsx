"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, Input, Label } from "@/components/ui";
import {
  login,
  signup,
  signInWithGoogle,
  type AuthFormState,
} from "./actions";

type Mode = "login" | "signup";

const copy = {
  login: {
    title: "Log in to Hookline",
    submit: "Continue",
    pending: "Signing in…",
    alt: "Don't have an account?",
    altLink: "Sign up",
    altHref: "/signup",
    autoComplete: "current-password",
  },
  signup: {
    title: "Create your account",
    submit: "Create account",
    pending: "Creating account…",
    alt: "Already have an account?",
    altLink: "Log in",
    altHref: "/login",
    autoComplete: "new-password",
  },
} as const;

export function AuthForm({
  mode,
  next,
  initialError,
}: {
  mode: Mode;
  next?: string;
  initialError?: string;
}) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    mode === "login" ? login : signup,
    initialError ? { error: initialError } : undefined,
  );
  const c = copy[mode];

  if (state?.message) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="leading-relaxed text-muted">{state.message}</p>
        <Link href="/login" className="inline-block text-fg hover:underline">
          Back to log in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold tracking-tight">{c.title}</h1>

      <form action={signInWithGoogle}>
        {next && <input type="hidden" name="next" value={next} />}
        <Button type="submit" variant="secondary" className="w-full">
          <GoogleIcon />
          Continue with Google
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-subtle">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={action} className="space-y-4" noValidate>
        {next && <input type="hidden" name="next" value={next} />}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@store.com"
            defaultValue={state?.email}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={c.autoComplete}
            minLength={mode === "signup" ? 8 : undefined}
            required
          />
        </div>

        {state?.error && (
          <p role="alert" className="text-[13px] text-danger">
            {state.error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? c.pending : c.submit}
        </Button>
      </form>

      <p className="text-[13px] text-muted">
        {c.alt}{" "}
        <Link href={c.altHref} className="text-fg hover:underline">
          {c.altLink}
        </Link>
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
