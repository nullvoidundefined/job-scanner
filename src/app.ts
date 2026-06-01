import { query } from 'app/db/pool.js';
import { basicAuthGate } from 'app/middleware/basicAuthGate.js';
import { errorHandler } from 'app/middleware/errorHandler.js';
import express from 'express';
import helmet from 'helmet';

export const app = express();

app.set('trust proxy', 1);
app.use(helmet());

// Liveness: fast, no DB, no auth. Railway probes this path.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness: verifies DB connectivity. No auth.
app.get('/health/ready', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected' });
  }
});

// Everything past here requires the single-secret gate.
app.use(basicAuthGate);
app.use(express.json({ limit: '100kb' }));

// Radar routes mount here in Phase 3 (outreach queue, research form, pipeline).

app.use(errorHandler);
