import crypto from 'crypto';

import config from '../../config.js';
import { audit } from '../audit.js';
import { getSecret } from '../secrets.js';
import { runPoll } from './poll.js';
import { runReconciliation } from './reconcile.js';
import { defaultContext, runWorker } from './worker.js';

/**
 * Recurring jobs. In production pg_cron calls POST /jobs/<name> through pg_net
 * (see einvoice.schedule_jobs); the call is acknowledged immediately and the run
 * continues in the background. Each job runs at most once at a time per process;
 * across processes the job table's SKIP LOCKED claims keep work from overlapping.
 */
const JOBS = {
  worker: ctx => runWorker(ctx),
  poll: ctx => runPoll(ctx),
  reconcile: ctx => runReconciliation(ctx),
};

const running = new Map();

export function runJob(name) {
  if (running.has(name)) return { started: false, alreadyRunning: true };

  const started = Date.now();
  const promise = JOBS[name](defaultContext())
    .then(result => {
      if (config.debug || name !== 'worker' || result?.claimed) {
        console.log(`Job ${name} finished in ${Date.now() - started}ms`, JSON.stringify(result));
      }
      return result;
    })
    .catch(async err => {
      console.error(`Job ${name} failed`, err.message);
      await audit({ kind: 'system', method: `job:${name}`, error: err.stack || err.message });
    })
    .finally(() => running.delete(name));

  running.set(name, promise);
  return { started: true };
}

/** A webhook just queued something: run the worker soon rather than wait for cron. */
let nudgeTimer = null;
export function nudgeWorker() {
  if (nudgeTimer || process.env.NODE_ENV === 'test') return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    runJob('worker');
  }, 2000);
  nudgeTimer.unref?.();
}

async function isCronCaller(req) {
  const received = req.headers['x-cron-secret'];
  if (!received) return false;
  const expected = await getSecret('cron_secret');
  const a = Buffer.from(String(received));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function mountJobRoutes(app) {
  app.post('/jobs/:name', async (req, res) => {
    const { name } = req.params;
    if (!JOBS[name]) return res.status(404).json({ message: 'Unknown job' });

    try {
      if (!await isCronCaller(req)) return res.status(401).json({ message: 'Unauthorized' });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }

    return res.status(202).json({ job: name, ...runJob(name) });
  });
}

/** Timers instead of pg_cron, for local development (INPROCESS_SCHEDULER=true). */
export function startInProcessScheduler() {
  console.log('In-process scheduler on: worker every minute, poll every 10 minutes, reconcile daily at 02:30 UTC');
  setInterval(() => runJob('worker'), 60 * 1000);
  setInterval(() => runJob('poll'), 10 * 60 * 1000);

  let lastReconcileDay = null;
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 2 && now.getUTCMinutes() >= 30 && lastReconcileDay !== day) {
      lastReconcileDay = day;
      runJob('reconcile');
    }
  }, 60 * 1000);

  runJob('worker');
}
