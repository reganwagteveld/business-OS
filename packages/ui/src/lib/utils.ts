import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The V2 type scale (styles.css `--text-*`) adds font-size utilities tailwind-merge does not know. Without this,
// `text-small` and a colour such as `text-fg-muted` look like two text colours and one of them is dropped.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['caption', 'small', 'body', 'lead', 'section', 'title', 'display'] }] } },
});

/** Merges conditional class names and resolves conflicting Tailwind utilities (shadcn/ui convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
