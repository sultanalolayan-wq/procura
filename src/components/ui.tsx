import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-surface p-5 shadow-sm ${className}`}
    >
      {title ? (
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

const badgeStyles: Record<string, string> = {
  pending: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  approved: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  ordered: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  issued: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  received: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-300",
  active: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  inactive: "bg-zinc-500/12 text-zinc-600 dark:text-zinc-300",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
        badgeStyles[status] ?? badgeStyles.cancelled
      }`}
    >
      {status}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line px-5 py-10 text-center text-sm text-muted">
      {children}
    </p>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-sm">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            {head.map((cell) => (
              <th key={cell} className="px-4 py-3 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
}: {
  href: ComponentProps<typeof Link>["href"];
  children: ReactNode;
  variant?: "primary" | "ghost";
}) {
  const styles =
    variant === "primary"
      ? "bg-accent text-white hover:opacity-90"
      : "border border-line text-foreground hover:bg-accent/5";
  return (
    <Link
      href={href}
      className={`inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium transition ${styles}`}
    >
      {children}
    </Link>
  );
}

export const fieldClass =
  "w-full rounded-lg border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
