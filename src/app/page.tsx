import Link from "next/link";

// Placeholder landing page — the marketing site will replace this.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Hookline</h1>
      <div className="flex gap-4 text-[13px] text-muted">
        <Link href="/login" className="hover:text-fg">Log in</Link>
        <Link href="/signup" className="hover:text-fg">Sign up</Link>
      </div>
    </main>
  );
}
