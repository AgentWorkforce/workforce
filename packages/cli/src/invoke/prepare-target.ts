import path from 'node:path';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import {
  compileAgentSource,
  extractAgentSpec
} from '@agentworkforce/deploy';
import type { CompiledAgentV1 } from '@agentworkforce/runtime';

export interface PreparedInvokeTarget {
  compiled: CompiledAgentV1;
  personaPath: string;
  warnings: string[];
}

export async function prepareInvokeTarget(inputPath: string): Promise<PreparedInvokeTarget> {
  const absPath = path.resolve(inputPath);
  try {
    const compiled = await compileAgentSource(absPath);
    return { compiled, personaPath: absPath, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/missing top-level "intent"/.test(message)) throw error;
  }

  const extracted = await extractAgentSpec(absPath);
  const persona = syntheticInvokePersona(absPath);
  const compiled: CompiledAgentV1 = {
    schemaVersion: 1,
    sourceKind: 'single-file',
    sourcePath: absPath,
    persona,
    agent: extracted.agent,
    handlerEntry: absPath,
    sourceDigest: `invoke:${path.basename(absPath)}`,
    compileWarnings: []
  };
  return {
    compiled,
    personaPath: absPath,
    warnings: [
      `invoke synthesized a minimal preview persona for bare Agent source ${absPath}`
    ]
  };
}

function syntheticInvokePersona(sourcePath: string): PersonaSpec {
  const id = path.basename(sourcePath).replace(/\.[^.]+$/u, '');
  return {
    id,
    intent: 'local-preview',
    tags: ['local-preview'],
    description: `Synthetic local preview persona for ${id}`,
    skills: [],
    harness: 'claude',
    model: 'local-preview-stub',
    systemPrompt: 'Local preview invocation scaffold',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    cloud: true,
    onEvent: `./${path.basename(sourcePath)}`
  };
}
