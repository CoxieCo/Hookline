import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="px-6 py-5">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-6 pt-[12vh] pb-16">
        <div className="w-full max-w-[360px]">{children}</div>
      </main>
    </div>
  );
}
