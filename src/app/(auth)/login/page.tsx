import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Log in" };

const errors: Record<string, string> = {
  oauth: "Couldn't start Google sign-in. Please try again.",
  callback: "That sign-in link is invalid or has expired.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, error } = await searchParams;
  const nextPath = safeNextPath(next);

  return (
    <AuthForm
      mode="login"
      next={nextPath === "/dashboard" ? undefined : nextPath}
      initialError={typeof error === "string" ? errors[error] : undefined}
    />
  );
}
