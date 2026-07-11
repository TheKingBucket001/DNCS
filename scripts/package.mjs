import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASE_FILES } from './release-files.mjs';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const moduleDir = resolve(root, 'module');
const distDir = resolve(root, 'dist');

await import(pathToFileURL(resolve(root, 'scripts/build.mjs')).href);
await mkdir(distDir, { recursive: true });

const prop = await readFile(resolve(moduleDir, 'module.prop'), 'utf8');
const version = prop.match(/^version=(.+)$/m)?.[1]?.trim();
if (!version) throw new Error('module.prop missing version');

const zip = new AdmZip();

for (const file of RELEASE_FILES) {
  const archiveDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  zip.addLocalFile(resolve(moduleDir, file), archiveDir, basename(file));
}

const out = resolve(distDir, `dncs-${version}.zip`);
zip.writeZip(out);
const data = await readFile(out);
await writeFile(`${out}.sha256`, `${createHash('sha256').update(data).digest('hex')}  ${basename(out)}\n`, 'utf8');
console.log(relative(root, out));
