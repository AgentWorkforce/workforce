import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgDir = path.resolve(__dirname, '..');

// Spawn persona watcher (regenerates src/generated/personas.ts on JSON edits)
// and tsc --watch in parallel. tsc picks up the regenerated file and emits a
// fresh dist, so a single edit of a persona JSON flows all the way to built
// artifacts without a manual rebuild.
const children = [
  {
    name: 'personas',
    proc: spawn(process.execPath, ['./scripts/generate-personas.mjs', '--watch'], {
      cwd: pkgDir,
      stdio: 'inherit'
    })
  },
  {
    name: 'tsc',
    proc: spawn(
      process.execPath,
      [
        path.resolve(pkgDir, '../../node_modules/typescript/bin/tsc'),
        '-p',
        'tsconfig.json',
        '--watch',
        '--preserveWatchOutput'
      ],
      { cwd: pkgDir, stdio: 'inherit' }
    )
  }
];

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { proc } of children) {
    if (!proc.killed) proc.kill(signal ?? 'SIGTERM');
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const { name, proc } of children) {
  proc.on('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`[dev-watch] ${name} exited (code=${code}, signal=${signal}); tearing down siblings\n`);
      shutdown('SIGTERM');
      process.exitCode = code ?? 1;
    }
  });
}
