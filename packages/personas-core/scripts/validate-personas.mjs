import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(__filename), '..');
const packageJsonPath = join(packageRoot, 'package.json');
const errors = [];
const packageJson = readJson(packageJsonPath);
const personaRelDir = packageJson.agentworkforce?.personas;
const requiredTiers = ['best', 'best-value', 'minimum'];

if (personaRelDir !== 'personas') {
  errors.push('package.json must declare agentworkforce.personas as "personas"');
}

if (!Array.isArray(packageJson.files) || !packageJson.files.includes('personas')) {
  errors.push('package.json files must include "personas"');
}

const personasDir = join(packageRoot, 'personas');
if (!existsSync(personasDir) || !statSync(personasDir).isDirectory()) {
  errors.push('personas directory is missing');
}

const personaFiles = existsSync(personasDir) ? collectJsonFiles(personasDir) : [];
if (personaFiles.length === 0) {
  errors.push('personas directory must contain at least one JSON file');
}

const seenIds = new Map();
const seenBasenames = new Map();

for (const file of personaFiles) {
  const persona = readJson(file);
  const rel = relative(packageRoot, file);
  if (!isObject(persona)) {
    errors.push(`${rel} must be a JSON object`);
    continue;
  }

  if (typeof persona.id !== 'string' || persona.id.trim() === '') {
    errors.push(`${rel} must declare a non-empty string id`);
  } else {
    const expectedId = basename(file, '.json');
    if (persona.id !== expectedId) {
      errors.push(`${rel} id "${persona.id}" must match file name "${expectedId}"`);
    }
    const existing = seenIds.get(persona.id);
    if (existing) {
      errors.push(`${rel} duplicates persona id "${persona.id}" from ${existing}`);
    }
    seenIds.set(persona.id, rel);
  }

  const fileName = basename(file);
  const existingFile = seenBasenames.get(fileName);
  if (existingFile) {
    errors.push(`${rel} duplicates install target file name ${fileName} from ${existingFile}`);
  }
  seenBasenames.set(fileName, rel);

  if (typeof persona.intent !== 'string' || persona.intent.trim() === '') {
    errors.push(`${rel} must declare a non-empty string intent`);
  }
  if (!Array.isArray(persona.tags) || persona.tags.some((tag) => typeof tag !== 'string')) {
    errors.push(`${rel} tags must be an array of strings`);
  }
  if (typeof persona.description !== 'string' || persona.description.trim() === '') {
    errors.push(`${rel} must declare a non-empty string description`);
  }
  if (persona.skills !== undefined && !Array.isArray(persona.skills)) {
    errors.push(`${rel} skills must be an array when present`);
  }
  if (!isObject(persona.tiers)) {
    errors.push(`${rel} must declare tiers`);
    continue;
  }

  for (const tier of requiredTiers) {
    const runtime = persona.tiers[tier];
    if (!isObject(runtime)) {
      errors.push(`${rel} tiers.${tier} must be an object`);
      continue;
    }
    for (const field of ['harness', 'model', 'systemPrompt']) {
      if (typeof runtime[field] !== 'string' || runtime[field].trim() === '') {
        errors.push(`${rel} tiers.${tier}.${field} must be a non-empty string`);
      }
    }
    if (!isObject(runtime.harnessSettings)) {
      errors.push(`${rel} tiers.${tier}.harnessSettings must be an object`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`validate-personas: ${error}`);
  process.exit(1);
}

console.log(`validate-personas: ${personaFiles.length} personas ok`);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    errors?.push(`${relative(packageRoot, path)} could not be parsed: ${err.message}`);
    return {};
  }
}

function collectJsonFiles(dir) {
  const out = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
