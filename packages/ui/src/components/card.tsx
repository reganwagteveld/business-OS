import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';
import { glassClass, type GlassStrength } from './surface';

export type CardVariant = 'opaque' | 'glass';

/**
 * Card. Opaque by default, which is what dense content (forms, tables) should use; `glass` is for
 * summary or hero content placed over an atmospheric background. Presentational only.
 */
export function Card({ className, variant = 'opaque', strength, style, ...props }: ComponentProps<'section'> & { variant?: CardVariant; strength?: GlassStrength }) {
  if (variant === 'glass') {
    const glass = glassClass(strength);
    return <section className={cn('rounded-xl text-card-foreground', glass.className, className)} style={{ ...glass.style, ...style }} {...props} />;
  }
  return <section className={cn('rounded-xl border bg-card text-card-foreground shadow-card', className)} style={style} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-6', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('font-semibold leading-none tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-3 p-6 pt-0', className)} {...props} />;
}
