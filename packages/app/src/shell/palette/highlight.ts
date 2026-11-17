/**
 * Splits `text` into plain segments, marking those that match one of the query's words (case and
 * diacritic insensitive). Returns text only: the caller renders segments as React text nodes, so
 * nothing here can inject markup (GS2 §4.5 rule 4).
 */
export interface Segment { text: string; match: boolean }

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function highlight(text: string, query: string): Segment[] {
  const terms = [...new Set(fold(query).split(/\s+/u).filter((t) => t.length > 0))];
  if (terms.length === 0 || text.length === 0) return [{ text, match: false }];
  // Fold per code point so indices line up with the original string even when a diacritic is composed.
  const chars = [...text];
  const folded = chars.map((c) => fold(c));
  const marked = new Array<boolean>(chars.length).fill(false);
  const flat = folded.join('');
  const owner: number[] = [];
  folded.forEach((f, i) => { for (let k = 0; k < f.length; k++) owner.push(i); });
  for (const term of terms) {
    let at = flat.indexOf(term);
    while (at !== -1) {
      for (let k = at; k < at + term.length; k++) { const o = owner[k]; if (o !== undefined) marked[o] = true; }
      at = flat.indexOf(term, at + term.length);
    }
  }
  const out: Segment[] = [];
  chars.forEach((c, i) => {
    const last = out[out.length - 1];
    if (last && last.match === marked[i]) last.text += c;
    else out.push({ text: c, match: marked[i] ?? false });
  });
  return out;
}
