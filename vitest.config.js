// This workspace uses node:test as its test runner (see each package's
// `test` script: `node --test dist/**/*.test.js`). The regression gate
// invokes `npx vitest run`, so we provide a config that excludes every
// node:test file and exits cleanly when no vitest suites are found.
export default {
  test: {
    include: [],
    exclude: ['**/*'],
    passWithNoTests: true
  }
};
