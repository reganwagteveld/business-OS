import { useEffect, useRef, type ReactNode } from 'react';
import { BusinessOsMark } from './business-os-mark';

export const inputClass = 'w-full rounded-xl border border-input bg-background px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const actionClass = 'rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
export const secondaryClass = 'rounded-xl border border-border px-4 py-3 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Card layout used by every full-window state: brand on top, one message, optional actions. */
export function Frame({ children, title, subtitle, alert }: { children?: ReactNode; title: string; subtitle: string; alert?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to the new heading so keyboard and screen-reader users land on the change.
  useEffect(() => heading.current?.focus(), [title]);
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12 text-foreground">
      <div className="w-full max-w-xl">
        <div className="mb-10 flex items-center gap-3">
          <BusinessOsMark className="h-12 w-12 shrink-0" />
          <div>
            <p className="text-sm font-extrabold tracking-tight">BUSINESS OS</p>
            <p className="text-[10px] tracking-[.18em] text-muted-foreground">POWERED BY PIXAKOVA</p>
          </div>
        </div>
        <div role={alert ? 'alert' : undefined} className="rounded-3xl border border-border bg-card p-7 shadow-sm sm:p-10">
          <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold tracking-tight outline-none">{title}</h1>
          <p className="mt-3 mb-8 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          {children}
        </div>
      </div>
    </main>
  );
}

/** Shown from the first frame until the session and workspace are resolved: never blank. Motion stops for reduced-motion users. */
export function Startup({ label = 'Starting Business OS…' }: { label?: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-foreground" role="status" aria-live="polite" aria-busy="true">
      <BusinessOsMark className="mb-6 h-20 w-20" />
      <h1 className="text-3xl font-semibold tracking-tight">Business OS</h1>
      <p className="mt-2 text-xs font-medium uppercase tracking-[.22em] text-muted-foreground">Powered by Pixakova</p>
      <div className="mt-12 h-1 w-20 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/2 animate-pulse rounded-full bg-foreground motion-reduce:animate-none" /></div>
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
    </main>
  );
}
