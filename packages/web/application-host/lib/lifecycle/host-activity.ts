import type { Express, Request, RequestHandler } from 'express';
import type { AdmissionSummary } from '@varin/protocol';

export interface CalendarActivity {
  nextWakeAtMs: number | null;
  activeOccurrences: number;
  pendingDelivery: number;
  pendingPreparation: number;
  unresolvedSchedules: number;
  watchingAssets: boolean;
}

interface ActivityOwners {
  kernelEpoch(): string | null;
  draining(): boolean;
  observationStreams(): number;
  externalIngressActive(): boolean;
  admission(signal: AbortSignal): Promise<Pick<AdmissionSummary, 'localComputeActive' | 'queued'>>;
  calendar(signal: AbortSignal): Promise<CalendarActivity>;
}

export const HOST_ACTIVITY_PATH = '/api/system/lifecycle';

/** Incomplete coverage must never be mistaken for permission to stop. */
export const projectHostActivity = async (owners: ActivityOwners, signal: AbortSignal) => {
  const epoch = owners.kernelEpoch();
  const [admissionResult, calendarResult] = epoch !== null
    ? await Promise.allSettled([
        Promise.resolve().then(() => owners.admission(signal)),
        Promise.resolve().then(() => owners.calendar(signal)),
      ])
    : [null, null] as const;
  const sameEpoch = epoch !== null && owners.kernelEpoch() === epoch;
  const admission = sameEpoch && admissionResult?.status === 'fulfilled'
    ? { active: admissionResult.value.localComputeActive, queued: admissionResult.value.queued }
    : null;
  const calendar = sameEpoch && calendarResult?.status === 'fulfilled' ? calendarResult.value : null;
  const observations = owners.observationStreams();
  const ingress = owners.externalIngressActive();
  const draining = owners.draining();
  const retentionReasons = [
    ...(draining ? ['host-draining'] : []),
    ...(!admission ? ['catalog-admission-unavailable'] : []),
    ...(admission?.active ? ['catalog-local-compute'] : []),
    ...(admission?.queued ? ['catalog-queued-work'] : []),
    ...(!calendar ? ['calendar-unavailable'] : []),
    ...(calendar?.activeOccurrences ? ['calendar-active-occurrence'] : []),
    ...(calendar?.pendingDelivery ? ['calendar-pending-delivery'] : []),
    ...(calendar?.pendingPreparation || calendar?.unresolvedSchedules ? ['calendar-reconciliation'] : []),
    ...(calendar?.watchingAssets ? ['calendar-asset-watch'] : []),
    ...(calendar?.nextWakeAtMs != null ? ['calendar-wake-not-transferred'] : []),
    ...(observations ? ['http-observation-streams'] : []),
    ...(ingress ? ['external-ingress-active'] : []),
    'owner-coverage-incomplete',
    'durable-supervisor-handoff-unavailable',
  ];
  return {
    version: 1,
    lifecycle: draining ? 'draining' : 'running',
    catalog: admission,
    // Project every owner response explicitly; raw records may contain user content.
    calendar: calendar && {
      nextWakeAtMs: calendar.nextWakeAtMs,
      activeOccurrences: calendar.activeOccurrences,
      pendingDelivery: calendar.pendingDelivery,
      pendingPreparation: calendar.pendingPreparation,
      unresolvedSchedules: calendar.unresolvedSchedules,
      watchingAssets: calendar.watchingAssets,
    },
    retention: { observationStreams: observations, externalIngressActive: ingress, reasons: retentionReasons },
    parking: { supported: false, eligible: false },
  } as const;
};

export type HostActivity = Awaited<ReturnType<typeof projectHostActivity>>;

export const registerHostActivityRoute = (
  app: Express,
  requireAuth: RequestHandler,
  authorize: (request: Request) => Promise<boolean>,
  activity: (signal: AbortSignal) => Promise<HostActivity>,
): void => {
  app.get(HOST_ACTIVITY_PATH, (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }, requireAuth, async (request, response) => {
    try {
      if (!await authorize(request)) {
        response.status(403).json({ code: 'host-owner-required' });
        return;
      }
      response.json(await activity(AbortSignal.timeout(2000)));
    } catch {
      response.status(503).json({ code: 'host-activity-unavailable' });
    }
  });
};
