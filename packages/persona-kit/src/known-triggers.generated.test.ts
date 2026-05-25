import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS_WITHOUT_KNOWN_TRIGGERS as ADAPTER_CORE_WITHOUT_KNOWN_TRIGGERS,
  KNOWN_TRIGGER_CATALOG as ADAPTER_CORE_TRIGGER_CATALOG
} from '@relayfile/adapter-core';

import {
  ADAPTERS_WITHOUT_KNOWN_TRIGGERS,
  KNOWN_TRIGGER_CATALOG
} from './known-triggers.generated.js';

test('vendored trigger catalog stays in sync with @relayfile/adapter-core', () => {
  assert.deepEqual(KNOWN_TRIGGER_CATALOG, ADAPTER_CORE_TRIGGER_CATALOG);
  assert.deepEqual(
    ADAPTERS_WITHOUT_KNOWN_TRIGGERS,
    ADAPTER_CORE_WITHOUT_KNOWN_TRIGGERS
  );
});
