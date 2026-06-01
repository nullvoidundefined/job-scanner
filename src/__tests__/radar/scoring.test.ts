import { warmthFromSignals } from 'app/radar/scoring.js';
import { describe, expect, it } from 'vitest';

describe('warmthFromSignals', () => {
  it('sums stored signal weights plus the connection weight', () => {
    // hiring_eng(10) + ai_native(8) + direct(20) = 38
    expect(warmthFromSignals([10, 8], 'direct')).toBe(38);
  });

  it('treats an unknown connection strength as zero', () => {
    expect(warmthFromSignals([5], 'unknown')).toBe(5);
  });

  it('returns the connection weight alone when there are no signals', () => {
    expect(warmthFromSignals([], 'recruiter')).toBe(12);
  });
});
