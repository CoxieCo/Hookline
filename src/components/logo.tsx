import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-fg"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
        <rect width="18" height="18" rx="5" className="fill-accent" />
        <path
          d="M6 4.5v6a2.5 2.5 0 0 0 5 0V9"
          stroke="#0b0b12"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
      Hookline
    </Link>
  );
}
