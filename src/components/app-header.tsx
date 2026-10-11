import { Logo } from "@/components/logo";
import { Button } from "@/components/ui";
import { signOut } from "@/app/(auth)/actions";

export function AppHeader({ email }: { email?: string }) {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <Logo href="/dashboard" />
      <div className="flex items-center gap-3">
        {email && <span className="hidden text-[13px] text-muted sm:inline">{email}</span>}
        <form action={signOut}>
          <Button type="submit" variant="ghost" className="h-8 px-2.5">
            Sign out
          </Button>
        </form>
      </div>
    </header>
  );
}
