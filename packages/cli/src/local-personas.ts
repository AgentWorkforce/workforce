// Backwards-compatible source import for CLI internals and tests. The registry
// implementation is an SDK now so non-CLI callers resolve the exact same
// cwd → configured → built-in cascade without invoking `agentworkforce`.
export * from '@agentworkforce/persona-registry';
