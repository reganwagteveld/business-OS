import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card, type CardVariant } from './card';
import type { GlassStrength } from './surface';

const TREND = { up: 'text-success', down: 'text-destructive', neutral: 'text-muted-foreground' } as const;

/**
 * A single figure with its label and an optional change. The change is text ("+12% vs last month"),
 * so the trend never relies on colour alone. Opaque by default; `variant="glass"` for summaries over an atmosphere.
 */
export function StatCard({ label, value, change, trend = 'neutral', variant, strength, className, ...props }: Omit<ComponentProps<'section'>, 'children'> & { label: ReactNode; value: ReactNode; change?: ReactNode; trend?: keyof typeof TREND; variant?: CardVariant; strength?: GlassStrength }) {
  return (
    <Card variant={variant} strength={strength} className={cn('p-5', className)} {...props}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {change && <p className={cn('mt-1 text-xs font-medium', TREND[trend])}>{change}</p>}
    </Card>
  );
}
