/**
 * Lightweight file logger for the AgentWorkforce CLI.
 *
 * Modeled on Agent Relay's logger (relay/packages/utils/src/logger.ts):
 * - Writes structured lines to a log file so diagnostics never pollute the
 *   terminal the user is staring at while a persona launches.
 * - Configurable via environment variables, read at call time for late binding.
 * - No external dependencies.
 *
 * Default log file: `<workforce home>/logs/cli.log`
 *   (i.e. `~/.agentworkforce/workforce/logs/cli.log`).
 * Overrides:
 *   AGENTWORKFORCE_LOG_FILE   absolute path to the log file ('' or '-' → stderr)
 *   AGENTWORKFORCE_LOG_LEVEL  DEBUG | INFO | WARN | ERROR (default INFO)
 *   AGENTWORKFORCE_LOG_JSON   '1' to emit JSON lines instead of text
 */

import fs from 'node:fs';
import path from 'node:path';

import { defaultWorkforceHomeDir } from './local-personas.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

function defaultLogFile(): string {
  return path.join(defaultWorkforceHomeDir(), 'logs', 'cli.log');
}

/**
 * Resolve the log destination. Returns `undefined` when the user has opted to
 * send logs to stderr (`AGENTWORKFORCE_LOG_FILE` set to '' or '-').
 */
function getLogFile(): string | undefined {
  const override = process.env.AGENTWORKFORCE_LOG_FILE;
  if (override === undefined) return defaultLogFile();
  const trimmed = override.trim();
  if (trimmed === '' || trimmed === '-') return undefined;
  return trimmed;
}

function getLogLevel(): LogLevel {
  return (process.env.AGENTWORKFORCE_LOG_LEVEL ?? 'INFO').toUpperCase() as LogLevel;
}

function isLogJson(): boolean {
  return process.env.AGENTWORKFORCE_LOG_JSON === '1';
}

// Track which log directories we've already created so we don't stat per write.
const createdLogDirs = new Set<string>();

function ensureLogDir(logFile: string): void {
  const logDir = path.dirname(logFile);
  if (!createdLogDirs.has(logDir) && !fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    createdLogDirs.add(logDir);
  }
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= (LEVEL_PRIORITY[getLogLevel()] ?? LEVEL_PRIORITY.INFO);
}

function formatMessage(entry: LogEntry): string {
  if (isLogJson()) {
    return JSON.stringify(entry);
  }
  const { ts, level, component, msg, ...extra } = entry;
  const extraStr =
    Object.keys(extra).length > 0
      ? ' ' +
        Object.entries(extra)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : '';
  return `${ts} [${level}] [${component}] ${msg}${extraStr}`;
}

function log(level: LogLevel, component: string, msg: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
    ...extra
  };

  const formatted = formatMessage(entry);

  const logFile = getLogFile();
  if (logFile) {
    try {
      ensureLogDir(logFile);
      fs.appendFileSync(logFile, formatted + '\n');
      return;
    } catch {
      // Fall through to stderr if the log file is unwritable — never throw
      // from a logging call.
    }
  }

  // No log file configured (or it failed): fall back to stderr so the
  // diagnostic isn't lost entirely. We never write to stdout.
  process.stderr.write(formatted + '\n');
}

/**
 * Create a logger for a specific component.
 * @param component - Component name (e.g. 'launch-metadata', 'persona-install').
 */
export function createLogger(component: string) {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log('DEBUG', component, msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log('INFO', component, msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log('WARN', component, msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log('ERROR', component, msg, extra)
  };
}

/** Absolute path of the active log file, or `undefined` when logging to stderr. */
export function activeLogFile(): string | undefined {
  return getLogFile();
}
