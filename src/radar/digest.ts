import type { QueueRow } from 'app/radar/queries.js';
import type { RejectRow } from 'app/radar/queries.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildDigestHtml(
  queue: QueueRow[],
  rejects: RejectRow[],
): string {
  if (queue.length === 0) {
    return '<p>No companies in the outreach queue this week.</p>';
  }
  const rows = queue
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.live_score)}</td></tr>`,
    )
    .join('');
  const rejectLines = rejects
    .map((r) => `${escapeHtml(r.reason)}: ${r.count}`)
    .join('<br/>');
  return `
    <h2>Outreach queue</h2>
    <table border="1" cellpadding="6"><tr><th>Company</th><th>Status</th><th>Score</th></tr>${rows}</table>
    <h3>Rejects this week</h3>
    <p>${rejectLines || 'none'}</p>
  `;
}
