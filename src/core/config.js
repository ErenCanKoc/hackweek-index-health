import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();

export async function readJson(relativePath) {
  const text = await fs.readFile(path.join(rootDir, relativePath), 'utf8');
  return JSON.parse(text);
}

export async function writeJson(relativePath, value) {
  await fs.writeFile(path.join(rootDir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadConfig() {
  const [policy, propertyMappings, sources] = await Promise.all([
    readJson('config/policy.json'),
    readJson('config/property-mappings.json'),
    readJson('config/sources.json')
  ]);

  return { policy, propertyMappings, sources };
}

export function resolvePath(relativePath) {
  return path.join(rootDir, relativePath);
}
