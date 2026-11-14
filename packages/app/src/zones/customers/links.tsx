// Small presentation helpers shared by the customer page and its contacts panel.

/** A tel: link only for something that is plainly a phone number. */
export const telHref = (phone: string) => {
  const digits = phone.replace(/[^\d+]/g, '');
  return /^\+?\d{3,}$/.test(digits) ? `tel:${digits}` : null;
};

/** Lets a long email break after the @ (a clean place) before it would ever break mid-word. */
export function Breakable({ text }: { text: string }) {
  const at = text.indexOf('@');
  return at < 0 ? <>{text}</> : <>{text.slice(0, at + 1)}<wbr />{text.slice(at + 1)}</>;
}

export const linkClass = 'underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring';

export const safeHref = (site: string) => {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`;
  return /^https?:\/\//i.test(url) ? url : null;
};
