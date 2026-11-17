// The test fakes page with base64url cursors through Node's Buffer; enough of it for that.
const enc = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
(globalThis as Record<string, unknown>).Buffer = {
  from(value: string, encoding?: string) {
    const text = encoding === 'base64url' ? dec(value) : value;
    return { toString: (as?: string) => (as === 'base64url' ? enc(text) : text) };
  },
};
