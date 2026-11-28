import { MODEL_THINKING_EFFORTS, type ThinkingLevel } from '@varin/protocol';
import type { ChannelModel, ModelThinkingConfiguration } from './model-connections.js';
export { MODEL_THINKING_EFFORTS } from '@varin/protocol';

/** Preserve a named stop first, then its relative rank among active thinking levels. */
export function remapThinkingLevel<T extends string>(value: string, previous: readonly string[], next: readonly T[]): T | undefined {
  const exact = next.find(level => level === value);
  if (exact !== undefined || !next.length) return exact;
  if (value === 'off') return next[0];
  const from = previous.filter(level => level !== 'off');
  const to = next.filter(level => level !== 'off');
  const prior = from.indexOf(value);
  const rank = prior < 0 ? 0 : from.length === 1 ? 1 : prior / (from.length - 1);
  return to[Math.round(rank * (to.length - 1))] ?? next[0];
}

export function modelThinkingConfiguration(model: Pick<ChannelModel, 'thinking' | 'thinkingLevelMap'>): ModelThinkingConfiguration {
  if (model.thinking) return model.thinking;
  const levels = MODEL_THINKING_EFFORTS.filter(level => typeof model.thinkingLevelMap?.[level] === 'string');
  return levels.length ? { mode: 'levels', levels, allowOff: typeof model.thinkingLevelMap?.off === 'string' } : { mode: 'fixed' };
}

/** The settings preview and execution picker expose the same declared choices. */
export function modelThinkingLevels(model: Pick<ChannelModel, 'reasoning' | 'thinking' | 'thinkingLevelMap'>): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  const control = modelThinkingConfiguration(model);
  if (control?.mode === 'fixed') return ['on'];
  if (control?.mode === 'switch') return ['off', 'on'];
  if (control?.mode === 'budget') return [...(control.allowOff ? ['off' as const] : []), 'budget'];
  if (control?.mode === 'levels') return [...(control.allowOff ? ['off' as const] : []), ...control.levels];
  return ['on'];
}
