import type { SVGProps } from 'react';

/** Business OS four-tile mark. Clean vector recreation of the approved square logo. */
export function BusinessOsMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Business OS logo" {...props}>
      <rect width="64" height="64" rx="12" fill="#0B0B14" />
      <rect x="12" y="12" width="18" height="18" rx="4" fill="#8D7BFF" />
      <rect x="34" y="12" width="18" height="18" rx="4" fill="#FFD93B" />
      <rect x="12" y="34" width="18" height="18" rx="4" fill="#F0F1F6" />
      <rect x="34" y="34" width="18" height="18" rx="4" fill="#40404F" />
    </svg>
  );
}
