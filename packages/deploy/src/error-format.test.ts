import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHttpErrorBody } from './error-format.js';

test('formatHttpErrorBody: empty body returns empty string', () => {
  assert.equal(formatHttpErrorBody(''), '');
  assert.equal(formatHttpErrorBody(null), '');
  assert.equal(formatHttpErrorBody(undefined), '');
  assert.equal(formatHttpErrorBody('   \n   '), '');
});

test('formatHttpErrorBody: short JSON body is returned untouched', () => {
  const body = '{"error":"workspace not found"}';
  assert.equal(formatHttpErrorBody(body), body);
});

test('formatHttpErrorBody: long body is truncated with a suffix', () => {
  const body = 'a'.repeat(1000);
  const formatted = formatHttpErrorBody(body, { maxLength: 100 });
  assert.equal(formatted.startsWith('a'.repeat(100)), true);
  assert.match(formatted, /more bytes truncated/);
});

test('formatHttpErrorBody: HTML body is replaced with a hint, body bytes suppressed', () => {
  const html = '<!DOCTYPE html><html><head><title>404</title></head><body>'
    + '<script src="/_next/static/chunks/main.js"></script>'.repeat(50)
    + '</body></html>';
  const formatted = formatHttpErrorBody(html);
  // Must not include the raw HTML.
  assert.equal(formatted.includes('<script'), false);
  assert.equal(formatted.includes('<!DOCTYPE'), false);
  // Must mention HTML and the size hint.
  assert.match(formatted, /HTML/);
  assert.match(formatted, /\d+ bytes/);
});

test('formatHttpErrorBody: HTML detection covers <html and Next.js 404 doctype variants', () => {
  assert.match(formatHttpErrorBody('<!doctype html><html>...'), /HTML/);
  assert.match(formatHttpErrorBody('<html lang="en">...'), /HTML/);
  assert.match(formatHttpErrorBody('<HTML><head><title>x</title>'), /HTML/);
});

test('formatHttpErrorBody: includes the offending URL when provided', () => {
  const html = '<!doctype html><html><head><title>404</title></head></html>';
  const formatted = formatHttpErrorBody(html, {
    url: 'https://agentrelay.com/api/v1/workspaces/abc/deployments'
  });
  assert.match(formatted, /https:\/\/agentrelay\.com\/api\/v1\/workspaces\/abc\/deployments/);
});

test('formatHttpErrorBody: a stray <h1> in plain text is NOT treated as HTML', () => {
  // Bare angle brackets in JSON error messages shouldn't trigger the
  // suppress path. The detector looks for the opening doctype / <html /
  // <head>+<title> trio.
  const body = '{"error":"got <h1> tag in input"}';
  assert.equal(formatHttpErrorBody(body), body);
});
