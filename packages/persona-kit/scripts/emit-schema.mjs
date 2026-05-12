#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGenerator } = require('ts-json-schema-generator');

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(packageRoot, 'schemas/persona.schema.json');
const tsconfigPath = resolve(packageRoot, 'tsconfig.json');
const typesPath = resolve(packageRoot, 'src/types.ts');

const generator = createGenerator({
  path: typesPath,
  tsconfig: tsconfigPath,
  type: 'PersonaSpec',
  expose: 'export',
  topRef: true,
  jsDoc: 'extended',
  additionalProperties: true,
  sortProps: true,
  skipTypeCheck: true
});

const schema = generator.createSchema('PersonaSpec');
schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
schema.$id = 'https://agentworkforce.dev/schemas/persona.schema.json';
const personaSpecSchema = schema.definitions?.PersonaSpec;
if (personaSpecSchema) {
  personaSpecSchema.allOf = [
    ...(personaSpecSchema.allOf ?? []),
    {
      if: {
        type: 'object',
        properties: {
          cloud: { const: true }
        },
        required: ['cloud']
      },
      then: {
        required: ['onEvent']
      }
    }
  ];
}

const serialized = `${JSON.stringify(schema, null, 2)}\n`;
await mkdir(dirname(schemaPath), { recursive: true });

let existing = '';
try {
  existing = await readFile(schemaPath, 'utf8');
} catch {
  // First emission.
}

if (existing !== serialized) {
  await writeFile(schemaPath, serialized);
}
