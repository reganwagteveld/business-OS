import { useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/utils';

const control =
  'w-full rounded-lg border border-input bg-field px-3 text-sm text-foreground placeholder:text-muted-foreground ' +
  'transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/30';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-10', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, 'min-h-24 py-2.5 leading-relaxed', className)} {...props} />;
}

/** Native select: keyboard and screen-reader behaviour come from the platform. */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(control, 'h-10 pr-8', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}

/**
 * Label, control, hint and error wired together. `children` receives the ids to put on the control,
 * so the hint and error are announced with it and the invalid state is exposed.
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (control: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactElement;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true as const } : {}) })}
      {hint && <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} className="text-xs font-medium text-destructive">{error}</p>}
    </div>
  );
}
