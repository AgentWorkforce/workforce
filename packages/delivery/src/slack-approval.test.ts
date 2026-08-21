import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSlackApprovalCard,
  matchSlackApprovalReaction,
  readSlackApproval
} from './slack-approval.js';
import type { SlackReaction } from './slack.js';

const options = {
  namespace: 'github-inbox.archive',
  approverId: 'U12345678'
} as const;

test('buildSlackApprovalCard keeps exact ids out of rendered text and decodes them', () => {
  const card = buildSlackApprovalCard({
    ...options,
    text: 'React :white_check_mark: to archive these conversations.',
    actionIds: ['thread:one', 'thread,two', 'thread:one'],
    context: { batch: 2 }
  });

  const renderedText = card.blocks
    .filter((block) => block.type === 'section')
    .map((block) => JSON.stringify(block.text))
    .join('\n');
  assert.doesNotMatch(renderedText, /thread:one|thread,two/);
  assert.deepEqual(
    readSlackApproval({ ts: '1787300000.000100', ...card }, options),
    {
      namespace: 'github-inbox.archive',
      approverId: 'U12345678',
      actionIds: ['thread:one', 'thread,two'],
      context: { batch: 2 }
    }
  );
});

test('readSlackApproval recovers from Slack-redacted metadata through hidden block ids', () => {
  const card = buildSlackApprovalCard({
    ...options,
    text: 'Approve the batch.',
    actionIds: ['thread-1', 'thread-2']
  });

  assert.deepEqual(
    readSlackApproval({
      ts: '1787300000.000100',
      metadata: {
        event_type: card.metadata.event_type,
        event_payload: {}
      },
      blocks: card.blocks
    }, options),
    {
      namespace: 'github-inbox.archive',
      approverId: 'U12345678',
      actionIds: ['thread-1', 'thread-2']
    }
  );
});

test('matchSlackApprovalReaction binds actor, emoji, and exact message timestamp', () => {
  const card = buildSlackApprovalCard({
    ...options,
    text: 'Approve the batch.',
    actionIds: ['thread-1']
  });
  const reaction: SlackReaction = {
    action: 'added',
    channel: 'D12345678',
    messageTs: '1787300000.000100',
    actorId: 'U12345678',
    emoji: 'white_check_mark'
  };
  const message = { ts: reaction.messageTs, ...card };

  assert.deepEqual(matchSlackApprovalReaction(reaction, message, options)?.actionIds, ['thread-1']);
  assert.equal(
    matchSlackApprovalReaction({ ...reaction, actorId: 'U87654321' }, message, options),
    null
  );
  assert.equal(
    matchSlackApprovalReaction({ ...reaction, emoji: 'eyes' }, message, options),
    null
  );
  assert.equal(
    matchSlackApprovalReaction(reaction, { ...message, ts: '1787300002.000300' }, options),
    null
  );
  assert.equal(
    matchSlackApprovalReaction({ ...reaction, action: 'removed' }, message, options),
    null
  );
});

test('Slack approval cards enforce domain validators and fail closed on tampering', () => {
  const validateActionId = (id: string) => /^thread-[0-9]+$/.test(id);
  assert.throws(
    () => buildSlackApprovalCard({
      ...options,
      text: 'Approve.',
      actionIds: ['message-1'],
      validateActionId
    }),
    /Invalid Slack approval action id/
  );

  const card = buildSlackApprovalCard({
    ...options,
    text: 'Approve.',
    actionIds: ['thread-1'],
    validateActionId
  });
  const block = card.blocks.find((value) => typeof value.block_id === 'string');
  assert.ok(block);
  assert.equal(
    readSlackApproval({
      metadata: { event_type: card.metadata.event_type, event_payload: {} },
      blocks: [{ ...block, block_id: `${String(block.block_id).replace(/thread-1$/, '')}%E0%A4%A` }]
    }, { ...options, validateActionId }),
    null
  );
  assert.equal(
    readSlackApproval({ ...card }, { ...options, approverId: 'U87654321' }),
    null
  );

  const inconsistent = {
    ...card,
    metadata: {
      ...card.metadata,
      event_payload: {
        ...card.metadata.event_payload,
        action_ids: ['thread-2']
      }
    }
  };
  assert.equal(
    readSlackApproval(inconsistent, { ...options, validateActionId }),
    null
  );
});

test('Slack approval cards enforce metadata, block-id, and section limits', () => {
  assert.throws(
    () => buildSlackApprovalCard({
      ...options,
      text: 'Approve.',
      actionIds: ['thread-1'],
      context: { note: 'x'.repeat(4_000) }
    }),
    /event payload is too large/
  );
  assert.throws(
    () => buildSlackApprovalCard({
      ...options,
      text: 'Approve.',
      actionIds: ['x'.repeat(300)]
    }),
    /too large for a block id/
  );

  const card = buildSlackApprovalCard({
    ...options,
    text: 'x'.repeat(6_100),
    actionIds: ['thread-1']
  });
  const sections = card.blocks.filter((block) => block.type === 'section');
  assert.equal(sections.length, 3);
  for (const section of sections) {
    const text = section.text as { text: string };
    assert.ok(text.text.length <= 2_900);
  }

  const emojiText = '🙂'.repeat(3_000);
  const emojiCard = buildSlackApprovalCard({
    ...options,
    text: emojiText,
    actionIds: ['thread-1']
  });
  const emojiSections = emojiCard.blocks
    .filter((block) => block.type === 'section')
    .map((block) => (block.text as { text: string }).text);
  assert.equal(emojiSections.join(''), emojiText);
  assert.ok(emojiSections.every((text) => Array.from(text).length <= 2_900));
});
