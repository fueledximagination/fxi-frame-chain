// Dependency-free lint: syntax-check every .js file and validate every .json file.
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'frame-chain-output']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

let failed = 0;
for (const file of await walk(root)) {
  const rel = path.relative(root, file);
  if (file.endsWith('.js')) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) {
      failed++;
      console.error(`FAIL ${rel}\n${r.stderr}`);
    }
  } else if (file.endsWith('.json')) {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      failed++;
      console.error(`FAIL ${rel}: ${err.message}`);
    }
  }
}
if (failed) {
  console.error(`${failed} file(s) failed lint`);
  process.exit(1);
}
console.log('lint ok');
