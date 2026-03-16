import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWorkload } from './index.js';

test('routes cheap QA tasks to qa-cheap lane', () => {
  assert.equal(routeWorkload('lint').id, 'qa-cheap');
});

test('routes architecture tasks to high lane', () => {
  assert.equal(routeWorkload('architecture').id, 'architecture-high');
});

test('routes unknown low-risk tasks to impl-mid', () => {
  assert.equal(routeWorkload('feature').id, 'impl-mid');
});
