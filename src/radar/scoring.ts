// scoring.ts
// Stored warmth is recomputed whenever signals or connection_strength change.
// Recency and the intersection premium are added at read time (LIVE_SCORE_SQL) so they
// decay without a nightly rewrite.

import { CONNECTION_WEIGHTS } from 'app/radar/config.js';

// warmth_score = sum of stored signal weights + the network (connection) weight.
// Signals already carry their own weight in the DB, so pass the stored weights in.
export function warmthFromSignals(
  storedSignalWeights: number[],
  connectionStrength: string,
): number {
  const signalSum = storedSignalWeights.reduce((sum, w) => sum + w, 0);
  const connection = CONNECTION_WEIGHTS[connectionStrength] ?? 0;
  return signalSum + connection;
}

// The outreach-queue query. Recency takes the more recent of the Form D and ATS clocks,
// so ATS-only companies still get a freshness boost. The intersection premium (+5) fires
// when a company is recency-fresh AND carries the hiring_eng signal. The literals here
// mirror config.RECENCY_TIERS and config.INTERSECTION_BONUS; keep them in sync.
export const LIVE_SCORE_SQL = `
select c.*,
       c.warmth_score
       + r.recency_bonus
       + case when r.recency_bonus > 0
               and exists (select 1 from signals s
                           where s.company_id = c.id and s.type = 'hiring_eng')
              then 5 else 0 end as live_score
from companies c
cross join lateral (
  select case
    when greatest(c.latest_filing_date, c.latest_fresh_role_date) >= current_date - 7  then 10
    when greatest(c.latest_filing_date, c.latest_fresh_role_date) >= current_date - 30 then 6
    when greatest(c.latest_filing_date, c.latest_fresh_role_date) >= current_date - 45 then 3
    else 0 end as recency_bonus
) r
where c.status in ('discovered', 'researched')
order by live_score desc
limit $1;
`;
