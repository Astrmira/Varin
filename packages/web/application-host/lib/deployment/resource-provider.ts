import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { ComputerPlatform, SourceResourceOwner } from '@varin/protocol';
import { waitWithSignal } from '../cancellation.js';

export interface ProviderResource {
  id: string;
  hostId: string;
  label: string;
  role: 'resources' | 'browser' | 'computer' | 'extensions';
  capabilities: string[];
  /** Browser identifier on the declared Browser Node, available before launch. */
  browserId?: string;
  /** Desktop identifier advertised by the Computer Node, available before launch. */
  desktopId?: string;
  /** A dedicated sandbox is bound to this extension for its entire generation. */
  extensionId?: string;
  platform?: ComputerPlatform;
}

export interface ProviderLeaseIdentity {
  resourceId: string;
  leaseId: string;
  generation: string;
}

export interface ProviderLease extends ProviderLeaseIdentity {
  endpoint: string;
  bearer: string;
  expiresAt: number;
}

export interface ProviderStatus {
  resourceId: string;
  state: 'cold' | 'preparing' | 'ready' | 'retiring' | 'unavailable';
  generation?: string;
}

export interface ProviderRetirement {
  resourceId: string;
  generation: string;
  processExited: true;
  volumeDetached: true;
}

/** The configured socket is the provider's operator boundary. A lease ending
 * is use accounting. Retirement also requires native writer/volume evidence. */
export interface ResourceProvider {
  id: string;
  describe(signal?: AbortSignal): Promise<ProviderResource[]>;
  acquire(input: Omit<ProviderLeaseIdentity, 'generation'>, signal?: AbortSignal): Promise<ProviderLease>;
  renew(input: ProviderLeaseIdentity, signal?: AbortSignal): Promise<ProviderLease>;
  release(input: ProviderLeaseIdentity): Promise<void>;
  status(resourceId: string, signal?: AbortSignal): Promise<ProviderStatus>;
  retire(resourceId: string, generation: string, signal?: AbortSignal): Promise<ProviderRetirement>;
}

export function providerResourceOwner(providerId: string, resource: Pick<ProviderResource, 'id' | 'hostId'>): Extract<SourceResourceOwner, {kind:'managed_host'}> {
  const identity = createHash('sha256').update(JSON.stringify([providerId, resource.id])).digest('hex');
  return { kind: 'managed_host', hostId: resource.hostId, connectionId: `provider:${identity}`, endpointIdentity: `sha256-${identity}` };
}

export function isProviderResourceOwner(owner: SourceResourceOwner): boolean {
  return owner.kind === 'managed_host' && owner.connectionId.startsWith('provider:');
}

/** An HTTP lease also covers the response body, including open observations. */
export function retainProviderResponse(response: Response, release: () => void): Response {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    reader.releaseLock();
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resource provider response');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw new Error('Invalid resource provider identity');
  return value;
};
const roles = ['resources', 'browser', 'computer', 'extensions'] as const;

export function parseProviderResources(value: unknown): ProviderResource[] {
  if (!Array.isArray(value)) throw new Error('Invalid resource provider directory');
  const resources: ProviderResource[] = value.map(raw => {
    const entry = record(raw);
    const role = roles.find(candidate => candidate === entry.role);
    if (!role || !Array.isArray(entry.capabilities)) throw new Error('Invalid resource provider role or capabilities');
    const platform = (['linux', 'windows', 'macos'] as const).find(candidate => candidate === entry.platform);
    if (role === 'computer' && entry.platform !== undefined && !platform) throw new Error('Invalid Computer Node platform');
    return { id: text(entry.id), hostId: text(entry.hostId), label: text(entry.label), role, capabilities: entry.capabilities.map(text),
      ...(role === 'browser' && entry.browserId !== undefined && { browserId: text(entry.browserId) }),
      ...(role === 'computer' && entry.desktopId !== undefined && { desktopId: text(entry.desktopId) }),
      ...(role === 'extensions' && { extensionId: text(entry.extensionId) }),
      ...(role === 'computer' && platform && { platform }) };
  });
  if (new Set(resources.map(resource => resource.id)).size !== resources.length) throw new Error('Duplicate logical resource in provider directory');
  return resources;
}

function parseLease(value: unknown, expected: Omit<ProviderLeaseIdentity, 'generation'> & { generation?: string }): ProviderLease {
  const entry = record(value);
  if (entry.resourceId !== expected.resourceId || entry.leaseId !== expected.leaseId
    || expected.generation !== undefined && entry.generation !== expected.generation) throw new Error('Resource provider returned a different allocation');
  let endpoint: URL;
  try { endpoint = new URL(text(entry.endpoint)); } catch { throw new Error('Invalid resource provider endpoint'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid resource provider endpoint');
  }
  if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
    throw new Error('Resource provider lease has already expired');
  }
  return { resourceId: expected.resourceId, leaseId: expected.leaseId, generation: text(entry.generation),
    endpoint: endpoint.href, bearer: text(entry.bearer), expiresAt: entry.expiresAt };
}

export function createSocketResourceProvider(options: { id: string; socketPath: string; bearer: string }): ResourceProvider {
  const exchange = (action: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request({ socketPath: options.socketPath, path: `/v1/resources/${action}`, method: 'POST', signal,
      headers: { Authorization: `Bearer ${options.bearer}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const parts: Buffer[] = [];
      res.on('data', part => parts.push(Buffer.from(part)));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode !== 200 && res.statusCode !== 204) {
          reject(new Error(`Resource provider ${options.id} rejected ${action} (${res.statusCode})`));
          return;
        }
        try { resolve(res.statusCode === 204 ? null : JSON.parse(Buffer.concat(parts).toString())); }
        catch { reject(new Error(`Resource provider ${options.id} returned invalid JSON`)); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  return {
    id: options.id,
    async describe(signal) { return parseProviderResources(await exchange('describe', {}, signal)); },
    async acquire(input, signal) { return parseLease(await exchange('acquire', input, signal), input); },
    async renew(input, signal) { return parseLease(await exchange('renew', input, signal), input); },
    async release(input) { await exchange('release', input); },
    async status(resourceId, signal) {
      const result = record(await exchange('status', { resourceId }, signal));
      const state = (['cold', 'preparing', 'ready', 'retiring', 'unavailable'] as const).find(candidate => candidate === result.state);
      if (!state || result.resourceId !== resourceId) throw new Error('Invalid resource provider status');
      return { resourceId, state, ...(result.generation !== undefined && { generation: text(result.generation) }) };
    },
    async retire(resourceId, generation, signal) {
      const result = record(await exchange('retire', { resourceId, generation }, signal));
      if (result.resourceId !== resourceId || result.generation !== generation || result.processExited !== true || result.volumeDetached !== true) {
        throw new Error('Resource provider has not confirmed retirement');
      }
      return { resourceId, generation, processExited: true, volumeDetached: true };
    },
  };
}

interface Allocation {
  users: number;
  pending: Promise<ProviderLease>;
  lease?: ProviderLease;
  retiring?: Promise<void>;
  renewing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

const leaseIdentity = ({ resourceId, leaseId, generation }: ProviderLease): ProviderLeaseIdentity => ({ resourceId, leaseId, generation });

/** Uses share preparation and a lease. Independent cancellation forgets only
 * that use. A late acquire is released after the last waiter has gone. */
export function createProviderLeaseOwner(provider: ResourceProvider, onError: (error: unknown) => void = () => {}) {
  const allocations = new Map<string, Allocation>();
  const renewal = (allocation: Allocation) => {
    const lease = allocation.lease;
    if (!lease || !allocation.users) return;
    // Renew midway through the provider's actual lease window.
    allocation.timer = setTimeout(() => {
      allocation.renewing = provider.renew(leaseIdentity(lease)).then(next => {
        allocation.lease = next;
        renewal(allocation);
      }).catch(onError);
    }, Math.max(1, (lease.expiresAt - Date.now()) / 2));
    allocation.timer.unref?.();
  };
  const leave = (resourceId: string, allocation: Allocation) => {
    if (--allocation.users !== 0) return;
    clearTimeout(allocation.timer);
    allocation.retiring = allocation.pending.then(async () => {
      await allocation.renewing;
      await provider.release(leaseIdentity(allocation.lease!));
    }, () => undefined).catch(onError).finally(() => {
      if (allocations.get(resourceId) === allocation) allocations.delete(resourceId);
    });
  };
  const acquire = async (resourceId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    let allocation = allocations.get(resourceId);
    while (allocation?.retiring) {
      await waitWithSignal(allocation.retiring, signal);
      allocation = allocations.get(resourceId);
    }
    if (!allocation) {
      const next: Allocation = { users: 0, pending: provider.acquire({ resourceId, leaseId: randomUUID() }) };
      next.pending = next.pending.then(lease => { next.lease = lease; renewal(next); return lease; });
      allocations.set(resourceId, next);
      allocation = next;
    }
    const current = allocation;
    current.users++;
    let released = false;
    const release = () => { if (!released) { released = true; leave(resourceId, current); } };
    try {
      await waitWithSignal(current.pending, signal);
      signal?.throwIfAborted();
      if (!current.lease || current.lease.expiresAt <= Date.now()) throw new Error('Resource provider lease expired');
      return { lease: current.lease, release };
    } catch (error) { release(); throw error; }
  };
  return {
    acquire,
    activity() {
      const counts = { preparing: 0, active: 0, releasing: 0 };
      for (const allocation of allocations.values()) {
        if (allocation.retiring) counts.releasing++;
        else if (allocation.lease) counts.active++;
        else counts.preparing++;
      }
      return counts;
    },
  };
}
