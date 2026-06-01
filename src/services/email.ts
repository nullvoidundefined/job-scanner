import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';
import { Resend } from 'resend';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Sends an email via Resend. No-op (with a warning) when email is unconfigured,
// so jobs run locally and in CI without secrets.
async function sendEmail(subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.DIGEST_TO_EMAIL) {
    logger.warn({ subject }, 'resend not configured; email not sent');
    return;
  }
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: env.DIGEST_TO_EMAIL,
    subject,
    html,
  });
  if (error) logger.error({ error }, 'email send failed');
}

export async function sendDigest(subject: string, html: string): Promise<void> {
  await sendEmail(subject, html);
}

// Heartbeat/ops alert delivered as email (the same channel as the digest).
export async function sendAlert(text: string): Promise<void> {
  await sendEmail('[job-scanner] alert', `<pre>${escapeHtml(text)}</pre>`);
}
