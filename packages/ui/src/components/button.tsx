import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

const VARIANTS = {
  primary: 'bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-primary-hover',
  secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-secondary-hover',
  ghost: 'text-foreground hover:bg-accent',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
} as const;

const SIZES = {
  sm: 'h-8 gap-1.5 rounded-md px-3 text-xs',
  md: 'h-10 gap-2 rounded-lg px-4 text-sm',
  lg: 'h-12 gap-2 rounded-xl px-5 text-sm',
  icon: 'size-10 rounded-lg',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

/** Class list for a button, for elements that must look like one (a link styled as an action). */
export function buttonClass({ variant = 'primary', size = 'md', className }: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(
    'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

/** Button. Defaults to type="button" so it never submits a form by accident. */
export function Button({ variant, size, className, type = 'button', ...props }: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}
