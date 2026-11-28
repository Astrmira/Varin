import React from 'react';
import { botGroupRequest, type GroupPostInput, type ThreadModelInfo } from '@varin/application-client';
import { ThinkingControl } from '@/components/thread/ThinkingSlider';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { groupLabel } from './botGroupChatModel';

export function GroupThinkingControl({ groupId, membership, revision, choice, onChange, busy, name }: {
  groupId: string; membership: string; revision?: number; choice: GroupPostInput['thinking'];
  onChange(choice: GroupPostInput['thinking']): void; busy: boolean; name: string;
}) {
  const { t } = useI18n();
  const [model, setModel] = React.useState<ThreadModelInfo | null>();
  const refreshModel = React.useRef<() => void>(null);
  React.useEffect(() => {
    let active: AbortController;
    function refresh() {
      active?.abort();
      const controller = active = new AbortController();
      void botGroupRequest<ThreadModelInfo | null>('/' + encodeURIComponent(groupId) + '/members/' + encodeURIComponent(membership) + '/model', undefined, controller.signal)
        .then(result => { if (!controller.signal.aborted) setModel(result); }, () => { if (!controller.signal.aborted) setModel(undefined); });
    }
    refreshModel.current = refresh;
    refresh();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready' || event.type === 'settings-changed' && event.owner === 'agent-settings') refresh();
    });
    return () => { active.abort(); unsubscribe(); refreshModel.current = null; };
  }, [groupId, membership, revision]);
  const levels = model?.thinkingLevels;
  const matches = choice && model?.modelId === choice.modelId && model.providerId === choice.providerId && levels?.includes(choice.level);
  // Keep an obsolete explicit choice recoverable, including after the Host lost a submit acknowledgement.
  if (choice && (!matches || levels?.length === 1)) return <button type="button" disabled={busy} className="thinking-control" onClick={() => onChange(undefined)}>
    {t(`settings.agents.thinking.${choice.level}`)} · {groupLabel('inheritThinking')}</button>;
  if (!model || !levels?.length) return null;
  const current = model.thinkingLevel ?? levels[0];
  const label = t('chat.modelControls.thinking');
  return <ThinkingControl key={JSON.stringify([model.providerId, model.modelId])} onOpen={() => refreshModel.current?.()}
    label={label + ' · ' + name} disabled={busy} stops={levels.map(id => ({ id, name: t(`settings.agents.thinking.${id}`) }))}
    value={choice?.level ?? current} budgetTokens={model.thinkingBudgetTokens}
    onSelect={level => onChange({ membership, modelId: model.modelId, providerId: model.providerId, level })}>
    {choice && <button type="button" className="thinking-slider-reset" disabled={busy} onClick={() => onChange(undefined)}>
      {groupLabel('inheritThinking')}{current && ' · ' + t(`settings.agents.thinking.${current}`)}</button>}
  </ThinkingControl>;
}
