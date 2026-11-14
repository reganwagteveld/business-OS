import type { SVGProps } from 'react';

/**
 * Business OS four-tile mark, traced from the approved logo PNG.
 * Canonical file: docs/brand/business-os-logo.svg (keep the two in sync).
 */
export function BusinessOsMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Business OS logo" {...props}>
      <rect width="64" height="64" rx="8.1" fill="#080812" />
      <rect x="11.35" y="11.35" width="19" height="19" rx="3.7" fill="#8674FB" />
      <rect x="33.65" y="11.35" width="19" height="19" rx="3.7" fill="#FDD237" />
      <rect x="11.35" y="33.65" width="19" height="19" rx="3.7" fill="#EEEFF4" />
      <rect x="33.65" y="33.65" width="19" height="19" rx="3.7" fill="#3F4051" />
    </svg>
  );
}
