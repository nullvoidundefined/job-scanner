import { env } from 'app/config/env.js';
import { logger } from 'app/utils/logger.js';
import { Resend } from 'resend';

export async function sendDigest(subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.DIGEST_TO_EMAIL) {
    logger.warn('resend not configured; digest not sent');
    return;
  }
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: env.DIGEST_TO_EMAIL,
    subject,
    html,
  });
  if (error) logger.error({ error }, 'digest send failed');
}
