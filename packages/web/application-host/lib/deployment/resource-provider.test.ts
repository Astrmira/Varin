import { expect, it, vi } from 'vitest';
import { createProviderLeaseOwner, type ProviderLease, type ResourceProvider } from './resource-provider.js';

it('shares a pending allocation and releases a late lease after every waiter cancels', async () => {
  let ready!: (value: ProviderLease) => void;
  const pending = new Promise<ProviderLease>(resolve => { ready = resolve; });
  const provider: ResourceProvider = {
    id: 'test',
    acquire: vi.fn(() => pending),
    release: vi.fn(async () => {}),
    describe: vi.fn(), renew: vi.fn(), status: vi.fn(), retire: vi.fn(),
  };
  const { acquire, activity } = createProviderLeaseOwner(provider);
  const one = new AbortController(), two = new AbortController();
  const first = acquire('workspace', one.signal), second = acquire('workspace', two.signal);
  expect(activity()).toEqual({ preparing: 1, active: 0, releasing: 0 });
  one.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(provider.acquire).toHaveBeenCalledTimes(1);
  expect(provider.release).not.toHaveBeenCalled();
  two.abort();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(activity()).toEqual({ preparing: 0, active: 0, releasing: 1 });
  const identity = { resourceId: 'workspace', leaseId: vi.mocked(provider.acquire).mock.calls[0]![0].leaseId, generation: 'one' };
  ready({ ...identity, bearer: 'token', expiresAt: Date.now() + 60_000, endpoint: 'http://127.0.0.1' });
  await expect.poll(() => vi.mocked(provider.release).mock.calls).toEqual([[identity]]);
  await expect.poll(activity).toEqual({ preparing: 0, active: 0, releasing: 0 });
});
