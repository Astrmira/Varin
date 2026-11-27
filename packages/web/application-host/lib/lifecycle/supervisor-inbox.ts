import { watch } from 'node:fs';
import type { FollowupEventReceiveParams, FollowupEventReceiveReceipt, FollowupEventSourceIdentity } from '@varin/protocol';
import type { SupervisorJournal } from './supervisor-journal.js';

export function startSupervisorInbox(
  journal: SupervisorJournal,
  receiveDurably: (page: FollowupEventReceiveParams, signal?: AbortSignal) => Promise<FollowupEventReceiveReceipt>,
  onUnavailable: () => void,
  onReceiverAvailability: () => void = () => {},
) {
  const stop = new AbortController();
  let work: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let blocked = new Set<string>();
  const key = ({ principalId, source }: FollowupEventSourceIdentity) => JSON.stringify([
    principalId, source.extensionId, source.sourceId, source.connectionId, source.accountId, source.host ?? null,
  ]);
  const scheduleRetry = () => {
    if (timer || stop.signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; wake(); }, 2000);
    timer.unref();
  };
  const wake = () => {
    if (stop.signal.aborted) return;
    dirty = true;
    if (work) return;
    work = (async () => {
      while (dirty && !stop.signal.aborted) {
        dirty = false;
        try {
          const next = new Set<string>();
          const result = await journal.replay(receiveDurably, stop.signal, identity => next.add(key(identity)));
          if (next.size !== blocked.size || [...next].some(item => !blocked.has(item))) {
            blocked = next;
            onReceiverAvailability();
          }
          if (result.retained) scheduleRetry();
        } catch {
          if (!stop.signal.aborted) { onUnavailable(); scheduleRetry(); }
        }
      }
    })().finally(() => { work = undefined; if (dirty) wake(); });
  };
  // Arm before the initial scan; observe atomic final names, not temp contents.
  const watcher = watch(journal.directory, { persistent: false }, (_event, name) => {
    if (!name || /^[a-f0-9]{64}\.pending$/.test(name)) wake();
  });
  watcher.on('error', () => { onUnavailable(); scheduleRetry(); });
  // A separately supervised writer or a platform file watcher can lose a
  // notification. Only the opt-in inbox has this low-frequency recovery scan.
  const fallback = setInterval(wake, 5000);
  fallback.unref();
  wake();
  const initialReplay = work!;
  return {
    initialReplay,
    blocksReceiver: (identity: FollowupEventSourceIdentity) => blocked.has(key(identity)),
    async close() {
      stop.abort();
      watcher.close();
      clearInterval(fallback);
      if (timer) clearTimeout(timer);
      await work;
    },
  };
}
