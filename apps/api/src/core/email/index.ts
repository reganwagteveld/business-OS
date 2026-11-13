import 'server-only';
// Outbound email for authentication (verification, password reset). One small interface so the
// provider (decision pending; "resend" is implemented over HTTPS without an SDK) can change
// without touching the identity module.
import { getEnv } from '../config/env';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Messages captured by the "log" transport, newest last. For development and tests only. */
export const devOutbox: EmailMessage[] = [];

export async function sendEmail(message: EmailMessage): Promise<void> {
  const env = getEnv();
  if (env.EMAIL_TRANSPORT === 'log') {
    devOutbox.push(message);
    if (devOutbox.length > 100) devOutbox.shift();
    // Never log the body: it carries one-time links. The subject and recipient are enough to debug.
    console.info(`[email:log] to=${message.to} subject=${JSON.stringify(message.subject)}`);
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text }),
  });
  if (!response.ok) throw new Error(`Email provider rejected the message (HTTP ${response.status})`);
}
