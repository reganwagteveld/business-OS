import type { CSSProperties, ComponentProps } from 'react';
import { cn } from '../lib/utils';

/** How see-through a glass surface is. `strong` is near-opaque and is the one to use behind dense content. */
export type GlassStrength = 'subtle' | 'regular' | 'strong' | number;

const ALPHA = { subtle: 0.45, regular: 0.62, strong: 0.86 } as const;

/** Class and inline style for the glass treatment; a number is the tint's opacity from 0 to 1. */
export function glassClass(strength: GlassStrength = 'regular'): { className: string; style: CSSProperties } {
  const alpha = typeof strength === 'number' ? Math.min(1, Math.max(0, strength)) : ALPHA[strength];
  return { className: 'bos-glass', style: { '--glass-alpha': String(alpha) } as CSSProperties };
}

export type SurfaceVariant = 'opaque' | 'raised' | 'glass';

/**
 * A panel. `opaque` matches a card, `raised` sits above one, `glass` is frosted over the atmosphere.
 * Glass falls back to an opaque surface when blur is unavailable or reduced transparency is requested.
 */
export function Surface({ variant = 'opaque', strength, className, style, ...props }: ComponentProps<'div'> & { variant?: SurfaceVariant; strength?: GlassStrength }) {
  if (variant === 'glass') {
    const glass = glassClass(strength);
    return <div className={cn('rounded-xl text-foreground', glass.className, className)} style={{ ...glass.style, ...style }} {...props} />;
  }
  return <div className={cn('rounded-xl border text-card-foreground', variant === 'raised' ? 'bg-surface-raised shadow-card' : 'bg-card', className)} style={style} {...props} />;
}

export type AtmosphereVariant = 'aurora' | 'dusk' | 'horizon' | 'calm';

/**
 * Atmospheric background: midnight-to-indigo gradient with diffused violet, lavender and pink light.
 * Each screen picks its own variant; `calm` is the restrained one for dense operational screens.
 */
export function Atmosphere({ variant = 'aurora', className, ...props }: ComponentProps<'div'> & { variant?: AtmosphereVariant }) {
  return <div data-atmosphere={variant} className={cn('bos-atmosphere text-foreground', className)} {...props} />;
}
