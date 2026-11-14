import type { ReactNode } from 'react';

/** Small outline icons in the app's own style: 16px, currentColor, decorative (the caller labels them). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const NoteIcon = () => <Icon><path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3" /></Icon>;
export const CallIcon = () => <Icon><path d="M4.2 2.5h2l1 2.8-1.3.9a7 7 0 0 0 3.9 3.9l.9-1.3 2.8 1v2a1.5 1.5 0 0 1-1.6 1.5A10.5 10.5 0 0 1 2.7 4.1 1.5 1.5 0 0 1 4.2 2.5z" /></Icon>;
export const MeetingIcon = () => <Icon><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></Icon>;
export const EmailIcon = () => <Icon><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="m2.5 4.5 5.5 4.5 5.5-4.5" /></Icon>;
