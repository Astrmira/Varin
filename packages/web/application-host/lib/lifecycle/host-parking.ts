import type { RequestHandler } from 'express';
import type { RuntimeParkReservation } from '@varin/protocol';
import type { SupervisorJournal } from './supervisor-journal.js';

export const SUPERVISOR_LAUNCH = 'VARIN_LOCAL_SUPERVISOR_LAUNCH_ID';
export const SUPERVISOR_PARKING = 'VARIN_LOCAL_SUPERVISOR_PARKING';
export const PARK_EXIT_CODE = 75;
export const validSupervisorLaunch = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

/** A synchronous lease across the private HTTP ingress. Shutdown still owns
 * the actual completion and cleanup of each application operation. */
interface ParkIngress {
  middleware: RequestHandler;
  enter(): (() => void) | undefined;
  count(): number;
  seal(): boolean;
  reopen(): void;
}

export function createParkIngress(): ParkIngress {
  let active = 0;
  let sealed = false;
  const enter = () => {
    if (sealed) return undefined;
    active++;
    let held = true;
    return () => {
      if (held) { held = false; active--; }
    };
  };
  const middleware: RequestHandler = (request, response, next) => {
    response.setHeader('X-Varin-Host-Parking', 'enabled');
    if (request.method === 'GET' && (request.path === '/health' || request.path === '/live')) { next(); return; }
    const release = enter();
    if (!release) {
      response.status(503).set('Cache-Control', 'no-store').json({ code: 'host-parking', admission: 'not_started' });
      return;
    }
    response.once('finish', release);
    response.once('close', release);
    next();
  };
  return { middleware, enter, count: () => active,
    seal() {
      if (active || sealed) return false;
      sealed = true;
      return true;
    },
    reopen() { sealed = false; },
  };
}

export async function parkHost(options: {
  ingress: ReturnType<typeof createParkIngress>;
  journal: Pick<SupervisorJournal, 'hasPendingEvents' | 'currentWake' | 'publishWake' | 'recordPark'>;
  launchId: string;
  pid: number;
  activity(): Promise<{ eligible: boolean; calendarWakeAtMs: number | null }>;
  reserveNative(): Promise<RuntimeParkReservation>;
  releaseNative(): Promise<unknown>;
  stop(cursor: number): Promise<void>;
}): Promise<number | null> {
  if (!options.ingress.seal()) return null;
  let reserved = false;
  let committed = false;
  try {
    const activity = await options.activity();
    if (!activity.eligible || await options.journal.hasPendingEvents()) return null;
    const native = await options.reserveNative();
    if (!native.reserved) return null;
    reserved = true;
    if (native.eventCursor === null) throw new Error('Native park reservation lacks a Catalog checkpoint');
    // Calendar owns filesystem observations and other Host preparation. Native
    // continuation reservations supply the latest durable Catalog deadline.
    const deadlines = [native.nextWakeAtMs, activity.calendarWakeAtMs].filter((at): at is number => at !== null);
    const nextWakeAtMs = deadlines.length ? Math.min(...deadlines) : null;
    if (nextWakeAtMs !== null && nextWakeAtMs <= Date.now()) return null;
    const { revision } = await options.journal.publishWake({
      revision: ((await options.journal.currentWake())?.revision ?? 0) + 1, nextWakeAtMs,
    });
    committed = true;
    await options.stop(native.eventCursor);
    await options.journal.recordPark({ launchId: options.launchId, pid: options.pid, revision });
    return revision;
  } finally {
    if (!committed) {
      if (reserved) await options.releaseNative();
      options.ingress.reopen();
    }
  }
}
