import { expect, test, vi } from 'vitest';
import { createParkIngress, parkHost } from './host-parking.js';

test('a park seals new work before reserving Catalog and records exit only after all owners stop', async () => {
  const ingress = createParkIngress();
  const enter = ingress.enter()!;
  const operations: string[] = [];
  const credentialExpiry = Date.now() + 5_000;
  const options: Parameters<typeof parkHost>[0] = {
    ingress, launchId: 'abdc0000-0000-0001-0001-000000000001', pid: 10,
    journal: {
      hasPendingEvents: async () => false, currentWake: async () => ({ revision: 7, nextWakeAtMs: null }),
      publishWake: async publication => {
        expect(publication.revision).toBe(8);
        expect(publication.nextWakeAtMs).toBe(credentialExpiry);
        operations.push('wake');
        return { revision: publication.revision, digest: 'wake' };
      },
      recordPark: async receipt => {
        expect(receipt).toMatchObject({ pid: 10, revision: 8 });
        operations.push('park');
      },
    },
    activity: async () => ({ eligible: true, calendarWakeAtMs: null }),
    handoff: async () => {
      operations.push('freeze');
      return { nextWakeAtMs: credentialExpiry, commit: async () => { operations.push('transfer'); }, rollback: vi.fn() };
    },
    reserveNative: async () => {
      expect(ingress.enter()).toBeUndefined();
      operations.push('native');
      return { reserved: true, nextWakeAtMs: Date.now() + 10_000, eventCursor: 38 };
    },
    releaseNative: vi.fn(),
    stop: async cursor => { expect(cursor).toBe(38); operations.push('stopped'); },
  };
  await expect(parkHost(options)).resolves.toBeNull();
  expect(operations).toEqual([]);
  enter();
  await expect(parkHost(options)).resolves.toBe(8);
  expect(operations).toEqual(['freeze', 'native', 'wake', 'transfer', 'stopped', 'park']);
  expect(options.releaseNative).not.toHaveBeenCalled();
});
