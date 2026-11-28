import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadsAPI } from '@varin/application-client';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { sendThreadDraft } from './sendThreadDraft';
import { setThreadComposerModel } from './threadComposerModel';

afterEach(() => {
  vi.restoreAllMocks();
  useThreadDraftStore.setState({ drafts: {} });
});

it.each([false, true])('creates the Bot conversation on first send with the expected model override (explicit: %s)', async explicit => {
  const draftKey = 'bot-draft';
  const model = { providerId: 'provider', modelId: 'model', thinkingLevel: 'high' as const };
  const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'main' };
  const create = vi.spyOn(useThreadStore.getState(), 'materializeDraft').mockResolvedValue(identity);
  const submit = vi.fn(async () => ({ run_id: 'run', input_id: 'input' }));
  const api = { submit, attachments: {} } as unknown as ThreadsAPI;
  useThreadDraftStore.getState().patch(draftKey, { botId: 'bot', model, text: 'Hello' });

  if (explicit) await setThreadComposerModel(api, draftKey, null, model);
  expect(create).not.toHaveBeenCalled();
  expect(useThreadDraftStore.getState().drafts[draftKey]?.model).toEqual(model);

  await sendThreadDraft(api, draftKey, { key: 'first', status: 'sending', text: 'Hello', editorText: 'Hello', model,
    images: [], files: [], editorContext: [], inlineContext: [] });
  expect(create).toHaveBeenCalledExactlyOnceWith(draftKey, { waitForCatalog: false, ...(explicit ? { model } : {}) });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ ...identity, text: 'Hello', model }));
});
