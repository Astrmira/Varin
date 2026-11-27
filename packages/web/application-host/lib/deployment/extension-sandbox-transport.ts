import { Readable } from 'node:stream';
import { create as archive } from 'tar';
import WebSocket from 'ws';
import { BrokeredHostRpcTransport, BrokeredHostUnavailableError, type BrokeredHostChannel, type BrokeredHostTransportFactory } from '@varin/extension-host';
import { brokerFrame, extensionBrokerPath, extensionNodeBase, extensionSandboxProtocolVersion } from './extension-sandbox-protocol.js';
import { createProviderLeaseOwner, type ResourceProvider } from './resource-provider.js';

/** The allocation and bidirectional capability channel belong to one verified extension owner. */
export function extensionSandboxTransport(provider: ResourceProvider, leases = createProviderLeaseOwner(provider)): BrokeredHostTransportFactory {
  return options => {
    const opening = new AbortController();
    let stream: WebSocket | undefined;
    let ready = false;
    let receivedExit = false;
    const channel: BrokeredHostChannel = {
      connected: () => ready && stream?.readyState === WebSocket.OPEN,
      send(message, callback) {
        if (brokerFrame(message) && message.kind === 'request' && brokerFrame(message.params)) {
          const { method, params } = message;
          if (method === 'activate') message = { ...message, params: { storage: params.storage, dependencies: params.dependencies } };
          else if (method === 'migrate') message = { ...message, params: { input: params.input } };
        }
        stream!.send(JSON.stringify(message), error => callback?.(error ?? null));
      },
      stop(force) {
        if (channel.connected()) stream!.send(JSON.stringify({ kind: 'stop', force }));
        else if (!ready) opening.abort(new BrokeredHostUnavailableError('Extension sandbox preparation stopped'));
      },
      observe(events) {
        void (async () => {
          const signal = opening.signal;
          let release: (() => void) | undefined;
          let opened = false;
          try {
            const resources = (await provider.describe(signal)).filter(resource =>
              resource.role === 'extensions' && resource.extensionId === options.owner.extensionId);
            if (resources.length !== 1) throw new BrokeredHostUnavailableError('An isolated execution target is required for this extension');
            const resource = resources[0]!;
            const allocation = await leases.acquire(resource.id, signal);
            release = allocation.release;
            const url = (route: string) => allocation.lease.endpoint.replace(/\/$/u, '') + route;
            const headers = { Authorization: 'Bearer ' + allocation.lease.bearer, 'X-Varin-Managed-Target': resource.hostId };
            const identity = await fetch(url(extensionNodeBase + '/identity'), { headers, redirect: 'error', signal });
            if (!identity.ok || identity.headers.get('x-varin-managed-host') !== resource.hostId) {
              await identity.body?.cancel();
              throw new BrokeredHostUnavailableError('Extension sandbox identity changed');
            }
            const body: unknown = await identity.json();
            if (!brokerFrame(body) || body.protocolVersion !== extensionSandboxProtocolVersion || body.role !== 'extensions' || body.extensionId !== resource.extensionId) {
              throw new BrokeredHostUnavailableError('Incompatible extension sandbox identity');
            }
            const { root, files } = await options.artifact.open(signal);
            const source = Readable.from(archive({ cwd: root, portable: true, noDirRecurse: true, strict: true }, files));
            const route = extensionBrokerPath + options.artifact.integrity;
            const response = await fetch(url(route), { method: 'PUT', headers, body: Readable.toWeb(source), duplex: 'half',
              redirect: 'error', signal } as RequestInit & { duplex: 'half' }).finally(() => source.destroy());
            await response.body?.cancel();
            if (!response.ok) throw new BrokeredHostUnavailableError('Extension sandbox rejected the verified artifact');
            signal.throwIfAborted();
            const address = new URL(url(route));
            address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
            stream = new WebSocket(address, { headers, followRedirects: false, signal });
            await new Promise<void>(resolve => {
              stream!.once('open', () => { opened = true; ready = true; });
              stream!.on('error', error => { if (opened) events.failed(error); });
              stream!.on('message', (data, binary) => {
                try {
                  const message: unknown = binary ? null : JSON.parse(data.toString());
                  if (!brokerFrame(message)) throw new Error('Invalid extension sandbox response');
                  if (message.kind === 'exited') receivedExit = true;
                  else events.received(message);
                } catch (error) { events.failed(error as Error); }
              });
              stream!.once('close', () => resolve());
            });
            events.stopped(new BrokeredHostUnavailableError('Extension sandbox stream closed'), receivedExit || !opened);
          } catch (error) {
            events.stopped(error instanceof Error ? error : new Error(String(error)), !opened || receivedExit);
          } finally {
            release?.();
          }
        })();
      },
    };
    return new BrokeredHostRpcTransport({ channel, onCrash: options.onCrash, requestFromChild: options.requestFromExtension });
  };
}
