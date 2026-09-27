import type { ComponentProps } from "react";

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
};

export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return (
    <button
      className={cx(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-[13px] font-medium",
        "transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-fg text-bg hover:bg-white",
        variant === "secondary" &&
          "border border-border-strong bg-surface-2 text-fg hover:bg-[#1c1d20]",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-[13px] text-fg",
        "placeholder:text-subtle transition-colors",
        "focus:border-accent focus:ring-2 focus:ring-accent/20 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cx("text-[13px] font-medium text-muted", className)}
      {...props}
    />
  );
}
