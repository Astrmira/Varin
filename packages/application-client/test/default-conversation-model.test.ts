import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConversationModel } from '../src/default-conversation-model.js';
import { remapThinkingLevel } from '../src/model-capabilities.js';
import type { ThreadModelInfo } from '../src/threads.js';

const models: ThreadModelInfo[] = [
  { providerId: 'first', modelId: 'fast', thinkingLevels: ['off', 'low'] },
  { providerId: 'preferred', modelId: 'strong', thinkingLevels: ['low', 'high'] },
];

test('switching models preserves an exact effort or its rank among thinking stops', () => {
  const previous = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.equal(remapThinkingLevel('off', previous, ['off','on']), 'off');
  assert.equal(remapThinkingLevel('low', previous, ['low','high']), 'low');
  assert.equal(remapThinkingLevel('xhigh', previous, ['off','quick','balanced','deep']), 'deep');
  assert.equal(remapThinkingLevel('minimal', previous, ['off','on']), 'on');
  assert.equal(remapThinkingLevel('on', ['off','on'], ['off','low','high']), 'high');
});

test('inherits the configured conversation model and its supported thinking level', () => {
  assert.deepEqual(defaultConversationModel({ defaultProvider: 'preferred', defaultModel: 'strong', defaultThinkingLevel: 'high' }, models),
    { providerId: 'preferred', modelId: 'strong', thinkingLevel: 'high' });
});

test('chooses the first available chat model without inventing a selection for an empty catalog', () => {
  assert.deepEqual(defaultConversationModel({ defaultThinkingLevel: 'low' }, models),
    { providerId: 'first', modelId: 'fast', thinkingLevel: 'low' });
  assert.equal(defaultConversationModel({}, []), null);
});

test('keeps the configured provider when possible and adapts thinking to the chosen model', () => {
  assert.deepEqual(defaultConversationModel({ defaultProvider: 'preferred', defaultModel: 'removed', defaultThinkingLevel: 'off' }, models),
    { providerId: 'preferred', modelId: 'strong', thinkingLevel: 'low' });
});
