import type { ThreadModel, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';

/** The picker and keyboard shortcuts change the same conversation setting. */
export async function setThreadComposerModel(api: ThreadsAPI, draftKey: string, snapshot: ThreadSnapshot | null | undefined, model: ThreadModel): Promise<void> {
  const activeRunId = snapshot?.thread.branches.find(branch => branch.branch_id === snapshot.identity.branchId)?.active_run_id;
  if (snapshot?.thread.bot_id && !snapshot.thread.parent_thread_id) {
    await api.update({ runtime: 'agent', threadId: snapshot.thread.thread_id,
      key: crypto.randomUUID(), expectedRevision: snapshot.thread.revision, model });
  } else if (snapshot && activeRunId) {
    await api.selectModel({ ...snapshot.identity, runId: activeRunId, key: crypto.randomUUID(), model });
  } else {
    useThreadDraftStore.getState().patch(draftKey, draft => ({ model, ...(!snapshot && draft.botId ? { botModelOverride: true } : {}) }));
  }
}
