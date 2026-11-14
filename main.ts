// Process lifecycle for the forge entry.
//
// The trial env lives at MAKEFUN_ENV_URL. This file starts the HTTP app from
// app.ts on a port the kernel picks, tells the env which port that was, and
// then stays alive until the env answers that the trial is finished. Nothing
// here binds a fixed port: 8080 belongs to the env, and the env dials the
// announced port from the moment registration lands.

import { createApp } from './app.ts';

function envOrigin(): string {
  const value = process.env.MAKEFUN_ENV_URL ?? '';
  return value.replace(/\/+$/, '');
}

const origin = envOrigin();
if (origin.length === 0) {
  console.error('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with');
  process.exit(1);
}

// One register or poll request gets this long before it counts as failed.
const REQUEST_LIMIT_MS = 30_000;
// Retry spacing starts here and doubles up to the cap below.
const FIRST_GAP_MS = 250;
const WIDEST_GAP_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function gapAfter(failures: number): number {
  const doubled = FIRST_GAP_MS * 2 ** Math.min(failures, 8);
  return doubled < WIDEST_GAP_MS ? doubled : WIDEST_GAP_MS;
}

// POST the bound port to the env and keep trying while it may still be
// starting. A 200 means the env took the registration; a 409 means another
// process registered first and this one simply waits like any other. A 400
// or 405 is a contract breach and stops the process outright.
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let verdict: 'ok' | 'retry' | 'fatal' = 'retry';
    try {
      const reply = await fetch(origin + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.status === 200 || reply.status === 409) {
        verdict = 'ok';
      } else if (reply.status === 400 || reply.status === 405) {
        const detail = await reply.text();
        throw new Error('register refused with HTTP ' + reply.status + ': ' + detail);
      }
    } catch (err) {
      if (err instanceof Error && err.message.indexOf('register refused') === 0) throw err;
      verdict = 'retry';
    }
    if (verdict === 'ok') return;
    await pause(gapAfter(failures));
    failures += 1;
  }
}

// Ask GET /done until the env's answer carries done set to true. Any failed
// or negative answer just schedules the next ask; returning early is never
// an option, because the export the scorer reads exists only after done.
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(origin + '/done', {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        finished = body.done === true;
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await pause(gapAfter(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const bound = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  await bound;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server bound something that is not a TCP port');
  }
  console.log('[entry] up on port ' + String(address.port));

  await announce(address.port);
  console.log('[entry] registered with the env; holding until it says done');

  await awaitDone();
  server.close();
  console.log('[entry] env said done; exiting');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const text = err instanceof Error ? err.message : String(err);
  console.error('[entry] failed: ' + text);
  process.exit(1);
}
