// main.ts — the forge's entrypoint: the one file that owns the process lifecycle.
//
//   1. Read and validate the environment (loadConfig). MAKEFUN_ENV_URL names the env's origin
//      (http://store:8080 in a trial container); without a usable one there is nothing to register
//      with, so the program refuses to start. The retry/timeout knobs may be overridden through
//      MAKEFUN_ENTRY_* variables, each validated the same way: a bad value is a startup error,
//      never a silent fallback.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env
//      owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came
//      from plus N as this entry's base URL and dials it from then on. The first register wins;
//      a 409 means another entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once
//      ({"done": false} while the suite runs), so this is a poll, not a long-held request. A failed
//      or slow poll is retried with a short exponential backoff; the process never exits before the
//      env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the
//      scorer reads.
//
// A SIGINT or SIGTERM short-circuits step 4: the entrypoint stops waiting, closes the server and
// exits 0, so a supervisor tearing the trial down never has to kill a process mid-poll.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

/** The entrypoint's validated configuration: the env's origin and the poll/retry timings. */
interface EntryConfig {
  /** The env's origin, with no trailing slash, e.g. http://store:8080. */
  envUrl: string;
  /** How long one register or done request may take before it is abandoned and retried. */
  requestTimeoutMs: number;
  /** The first wait between retries. */
  retryInitialMs: number;
  /** The longest wait between retries. */
  retryMaxMs: number;
}

/** Print a startup error and end the program: a misconfigured entrypoint must not limp on. */
function fatal(message: string): never {
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}

/**
 * Read one optional millisecond knob from the environment. An unset or blank variable keeps the
 * default; a set one must be a whole number inside [min, max], because a typo'd timing that was
 * silently ignored would surface later as a hang nobody could explain.
 */
function timingKnob(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fatal(`${name} must be a whole number of milliseconds between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Settle the whole configuration before anything is built or bound. MAKEFUN_ENV_URL is the one
 * required variable: it must be present and must parse as an http(s) URL, since every later step
 * is a fetch against it and a malformed origin would otherwise fail as an endless retry.
 */
function loadConfig(): EntryConfig {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  if (envUrl === '') fatal('MAKEFUN_ENV_URL is not set: there is no env to register with');
  let parsed: URL;
  try {
    parsed = new URL(envUrl);
  } catch {
    fatal(`MAKEFUN_ENV_URL is not a valid URL: ${JSON.stringify(envUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fatal(`MAKEFUN_ENV_URL must be an http(s) URL, got protocol ${JSON.stringify(parsed.protocol)}`);
  }
  const retryInitialMs = timingKnob('MAKEFUN_ENTRY_RETRY_INITIAL_MS', 250, 10, 60_000);
  const retryMaxMs = timingKnob('MAKEFUN_ENTRY_RETRY_MAX_MS', 2_000, 10, 300_000);
  if (retryMaxMs < retryInitialMs) {
    fatal(`MAKEFUN_ENTRY_RETRY_MAX_MS (${retryMaxMs}) must not be below MAKEFUN_ENTRY_RETRY_INITIAL_MS (${retryInitialMs})`);
  }
  return {
    envUrl,
    requestTimeoutMs: timingKnob('MAKEFUN_ENTRY_REQUEST_TIMEOUT_MS', 30_000, 100, 600_000),
    retryInitialMs,
    retryMaxMs,
  };
}

const config = loadConfig();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from the configured first wait, capped. */
function retryDelay(attempt: number): number {
  return Math.min(config.retryMaxMs, config.retryInitialMs * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${config.envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${config.envUrl}/done`, { signal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** The server's type, named without importing node:http: this file imports its own server only. */
type ForgeServer = ReturnType<typeof createApp>;

/** How long shutdown waits for in-flight requests to finish before dropping their connections. */
const SHUTDOWN_GRACE_MS = 1_000;

/**
 * The first termination signal the process receives, by name. A supervisor stopping the trial
 * (SIGTERM) or a developer interrupting a local run (SIGINT) both land here; the lifecycle races
 * its wait against this promise, so shutdown is prompt instead of whenever the current sleep or
 * fetch happens to end. A second signal needs no special case: the first one's shutdown is
 * already as fast as closing a server can be.
 */
const termination: Promise<string> = new Promise((resolve) => {
  process.once('SIGINT', () => resolve('SIGINT'));
  process.once('SIGTERM', () => resolve('SIGTERM'));
});

/**
 * Close the server and let in-flight requests finish, but not forever: after the grace period
 * the remaining connections are dropped, since a stuck socket must not hold the process open
 * past the point where its supervisor gives up and kills it anyway.
 */
async function closeServer(server: ForgeServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, SHUTDOWN_GRACE_MS);
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
  });
}

/**
 * Bind the port, register it, then wait for the env — or for a termination signal, whichever
 * comes first. Both endings close the server and report success: a signal means the trial is
 * being torn down from outside, which is not an entry failure.
 */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    const onBindError = (err: Error): void => reject(err);
    server.once('error', onBindError);
    server.listen(0, () => {
      server.removeListener('error', onBindError);
      resolve();
    });
  });
  // From here on a server 'error' is logged, never thrown: an 'error' event with no listener
  // would take the whole process down in the middle of the suite.
  server.on('error', (err: Error) => {
    process.stderr.write(`[entry] server error: ${err.message}\n`);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  const lifecycle = (async (): Promise<'done'> => {
    await register(address.port);
    process.stdout.write('[entry] registered; waiting for the env to say done\n');
    await waitForDone();
    return 'done';
  })();

  const outcome = await Promise.race([lifecycle, termination]);
  await closeServer(server);
  if (outcome === 'done') {
    process.stdout.write('[entry] done\n');
  } else {
    process.stdout.write(`[entry] ${outcome} received; shut down before the env said done\n`);
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
