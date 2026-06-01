import { query } from 'app/db/pool.js';
import { LIVE_SCORE_SQL } from 'app/radar/scoring.js';

export interface QueueRow {
  id: number;
  name: string;
  warmth_score: string;
  live_score: string;
  status: string;
}

export async function outreachQueue(limit = 15): Promise<QueueRow[]> {
  const { rows } = await query<QueueRow>(LIVE_SCORE_SQL, [limit]);
  return rows;
}

export interface RejectRow {
  reason: string;
  count: number;
}

export async function rejectDistribution(days: number): Promise<RejectRow[]> {
  const { rows } = await query<{ reason: string; count: string }>(
    `SELECT reject_reason AS reason, count(*) AS count
       FROM filings
      WHERE filter_verdict = 'rejected'
        AND fetched_at >= current_date - $1::int
      GROUP BY reject_reason
      ORDER BY count DESC`,
    [days],
  );
  return rows.map((r) => ({ reason: r.reason, count: Number(r.count) }));
}
