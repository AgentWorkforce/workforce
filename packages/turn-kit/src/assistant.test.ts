import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleAssistantTurnContext } from './assistant.js';

test('assistant bridge reuses canonical turn-context assembly and harness projection', async () => {
  const assembly = await assembleAssistantTurnContext({
    assistantId: 'life-agent',
    turnId: 'telegram-update-42',
    conversation: { transport: 'telegram', id: '8587:7' },
    identity: {
      assistantName: 'Life Agent',
      baseInstructions: {
        systemPrompt: 'You are a personal life assistant.'
      }
    },
    shaping: {
      mode: 'personal-assistance',
      responseStyle: { preferMarkdown: true }
    },
    history: [
      {
        content: 'User: Add the flight task\nAssistant: Added it.',
        createdAt: '2026-07-24T10:00:00.000Z'
      }
    ],
    context: [
      {
        id: 'open-tasks',
        label: 'Open tasks',
        content: '#5 Book the hotel',
        source: 'github',
        category: 'workspace'
      }
    ],
    guardrails: {
      overlays: [
        {
          id: 'confirmed-writes',
          source: 'workforce',
          rule: 'Only claim a write succeeded after its provider receipt.',
          kind: 'truthfulness_constraint',
          priority: 'high'
        }
      ]
    }
  });

  assert.equal(assembly.sessionId, 'turn:life-agent:telegram:8587%3A7');
  assert.deepEqual(assembly.provenance.usedMemoryIds, [
    'telegram-update-42:history:1'
  ]);
  assert.deepEqual(assembly.provenance.usedGuardrailIds, ['confirmed-writes']);
  assert.deepEqual(
    assembly.context.blocks.map((block) => block.id),
    ['memory-telegram-update-42:history:1', 'open-tasks']
  );
  assert.equal(
    assembly.harnessProjection.context.blocks.at(-1)?.content,
    '#5 Book the hotel'
  );
  assert.match(
    assembly.harnessProjection.instructions.developerPrompt ?? '',
    /provider receipt/
  );
});

test('assistant bridge rejects ids that collide with assembled memory blocks', async () => {
  await assert.rejects(
    () =>
      assembleAssistantTurnContext({
        assistantId: 'life-agent',
        turnId: 'turn-1',
        conversation: { transport: 'telegram', id: '8587' },
        identity: {
          baseInstructions: { systemPrompt: 'Be helpful.' }
        },
        history: [{ content: 'Earlier turn' }],
        context: [
          {
            id: 'memory-turn-1:history:1',
            label: 'Collision',
            content: 'This id is already used.'
          }
        ]
      }),
    /duplicate assembled turn context id/
  );
});
