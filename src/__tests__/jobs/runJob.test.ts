import { runJob } from 'app/jobs/runJob.js';
import * as telegram from 'app/services/telegram.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('runJob', () => {
  it('alerts and sets a non-zero exit code when the job throws', async () => {
    const alert = vi.spyOn(telegram, 'sendAlert').mockResolvedValue();
    await runJob('edgar-ingest', async () => {
      throw new Error('boom');
    });
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toContain('edgar-ingest');
    expect(process.exitCode).toBe(1);
  });

  it('does not alert and leaves exit code 0 on success', async () => {
    const alert = vi.spyOn(telegram, 'sendAlert').mockResolvedValue();
    await runJob('edgar-ingest', async () => {});
    expect(alert).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });
});
