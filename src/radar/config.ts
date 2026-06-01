// config.ts
// Single source of truth for tuning. Behavior changes live here, never in logic.

// --- Form D gates ---
export const SIZE_BAND_MIN = 250_000;
export const SIZE_BAND_MAX = 25_000_000;
export const STAGE_SEED_MAX = 5_000_000; // <= reads as seed, above (within band) as series A

export const INDUSTRY_ALLOWLIST = new Set<string>([
  'Computers',
  'Other Technology',
  'Business Services',
]);

export const YOUNG_COMPANY_MAX_AGE_YEARS = 3;

// --- Stored signal weights ---
// Read-time signals (recency, intersection premium) are NOT here; see scoring.ts.
export const SIGNAL_WEIGHTS = {
  hiring_eng: 10,
  ai_native: 8,
  first_raise: 6,
  seed: 5,
  round_grew: 3,
  series_a: 3,
  target_metro: 3,
  yc_batch: 3,
  young_company: 2,
} as const;

export type SignalType = keyof typeof SIGNAL_WEIGHTS;

// Network leverage, the heaviest input. Stored on companies.connection_strength.
export const CONNECTION_WEIGHTS: Record<string, number> = {
  none: 0,
  recruiter: 12,
  direct: 20,
};

// --- Read-time scoring (mirrored in scoring.ts LIVE_SCORE_SQL) ---
export const RECENCY_TIERS = [
  { maxDays: 7, weight: 10 },
  { maxDays: 30, weight: 6 },
  { maxDays: 45, weight: 3 },
] as const;
export const INTERSECTION_BONUS = 5; // fresh AND hiring_eng

// --- Geography (a signal, not a gate) ---
export interface Metro {
  name: string;
  state: string;
  cities: Set<string>; // lowercased; extend freely
}

export const TARGET_METROS: Metro[] = [
  {
    name: 'SF Bay',
    state: 'CA',
    cities: new Set([
      'san francisco',
      'oakland',
      'berkeley',
      'palo alto',
      'mountain view',
      'menlo park',
      'redwood city',
      'south san francisco',
      'san mateo',
      'sunnyvale',
      'santa clara',
      'san jose',
    ]),
  },
  {
    name: 'LA',
    state: 'CA',
    cities: new Set([
      'los angeles',
      'santa monica',
      'pasadena',
      'culver city',
      'el segundo',
      'venice',
      'burbank',
      'long beach',
    ]),
  },
  {
    name: 'Seattle',
    state: 'WA',
    cities: new Set(['seattle', 'bellevue', 'redmond', 'kirkland']),
  },
  {
    name: 'NYC',
    state: 'NY',
    cities: new Set(['new york', 'brooklyn', 'long island city', 'queens']),
  },
];

// --- ATS role filter ---
export const ROLE_SENIORITY =
  /\b(senior|sr\.?|staff|principal|founding|lead)\b/i;
export const ROLE_REMOTE = /\b(remote|distributed|anywhere)\b/i;
export const ROLE_STALE_DAYS = 90; // ghost-listing: roles not bumped in this window stop counting

// --- EDGAR fair-access ---
// User-Agent moved to env.SEC_USER_AGENT (read in edgar-client.ts).
export const MIN_REQUEST_SPACING_MS = 130; // ~7.7 req/s, under the 10/s ceiling
