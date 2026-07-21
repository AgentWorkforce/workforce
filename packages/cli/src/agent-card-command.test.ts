import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAgentCardCommandArgs } from './agent-card-command.js';

test('parseAgentCardCommandArgs parses the shared card contract flags', () => {
  assert.deepEqual(
    parseAgentCardCommandArgs([
      'persona.ts',
      '--base-url',
      'https://agent.example.test',
      '--version=2.0.0',
      '--documentation-url',
      'https://docs.example.test/agent',
      '--input-mode',
      'application/json',
      '--input-mode=text/plain',
      '--output-mode=text/markdown',
      '--json'
    ]),
    {
      personaPath: 'persona.ts',
      json: true,
      options: {
        baseUrl: 'https://agent.example.test',
        version: '2.0.0',
        documentationUrl: 'https://docs.example.test/agent',
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['text/markdown']
      }
    }
  );
});

test('parseAgentCardCommandArgs defaults compile-time deployment values', () => {
  assert.deepEqual(parseAgentCardCommandArgs(['persona.json']), {
    personaPath: 'persona.json',
    json: false,
    options: { baseUrl: 'http://localhost:3000', version: '0.0.0' }
  });
});

test('parseAgentCardCommandArgs rejects missing and extra persona paths', () => {
  assert.throws(
    () => parseAgentCardCommandArgs([]),
    /missing <path\/to\/persona\.ts\|persona\.json>/
  );
  assert.throws(
    () => parseAgentCardCommandArgs(['one.json', 'two.json']),
    /unexpected argument "two\.json"/
  );
});
