import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const includeExt = new Set(['.sh', '.js', '.mjs', '.ts', '.css', '.html', '.md', '.json', '.prop', '.svg']);
const skipDirs = new Set(['node_modules', '.git', 'dist']);
const bad = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) await walk(join(dir, entry.name));
      continue;
    }
    const dot = entry.name.lastIndexOf('.');
    const ext = dot >= 0 ? entry.name.slice(dot) : '';
    if (!includeExt.has(ext) && entry.name !== 'module.prop' && entry.name !== 'LICENSE') continue;
    const file = join(dir, entry.name);
    const data = await readFile(file);
    if (data.includes(13)) bad.push(relative(root, file));
  }
}

await walk(root);
if (bad.length) throw new Error(`CRLF found:\n${bad.join('\n')}`);
console.log('LF check passed');
