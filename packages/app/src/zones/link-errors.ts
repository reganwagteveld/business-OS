/**
 * LC-2: plain words for the three cross-Zone link rules the server enforces (W1 invariant I1,
 * docs/cross-zone-workflows-wf1.md §5.3 and §6.9). `undefined` means "not one of these", so each screen
 * keeps its own wording for everything else. No message names a record the person might not be allowed to read.
 */
const MESSAGES: Record<string, string> = {
  project_customer_mismatch: "This project belongs to a different customer. Choose one of this customer's projects, or clear the project.",
  project_customer_locked: "This project's customer can't change because records for that customer are linked to it.",
  opportunity_customer_mismatch: "This opportunity is for a different customer. Choose one of this customer's opportunities, or clear it.",
};

export function linkErrorMessage(code: string | undefined): string | undefined {
  return code ? MESSAGES[code] : undefined;
}
