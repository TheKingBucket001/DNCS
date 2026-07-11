import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { RELEASE_FILES } from './release-files.mjs';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const prop = await readFile(resolve(root, 'module/module.prop'), 'utf8');
const version = prop.match(/^version=(.+)$/m)?.[1]?.trim();
if (!version) throw new Error('module.prop missing version');

const zipPath = resolve(root, 'dist', `dncs-${version}.zip`);
const zip = new AdmZip(zipPath);
const entries = zip.getEntries();
const names = entries.map((entry) => entry.entryName).sort();
if (new Set(names).size !== names.length) throw new Error('zip contains duplicate entries');
for (const name of names) {
  const segments = name.split('/');
  if (!name || name.startsWith('/') || name.includes('\\') || segments.includes('..')) {
    throw new Error(`zip contains unsafe path ${name}`);
  }
}
const expectedNames = [...RELEASE_FILES].sort();
if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
  throw new Error(`zip file list differs from release allowlist: ${names.join(', ')}`);
}

for (const file of RELEASE_FILES) {
  const local = await readFile(resolve(root, 'module', file));
  const archived = zip.readFile(file);
  if (!archived || !local.equals(archived)) throw new Error(`zip content differs from module/${file}`);
}

const copiedWebFiles = [
  ['web-src/index.html', 'module/webroot/index.html'],
  ['web-src/style.css', 'module/webroot/assets/style.css'],
  ['web-src/insets.css', 'module/webroot/assets/insets.css'],
  ['web-src/icon.svg', 'module/webroot/icon.svg']
];
for (const [source, built] of copiedWebFiles) {
  const sourceBytes = await readFile(resolve(root, source));
  const builtBytes = await readFile(resolve(root, built));
  if (!sourceBytes.equals(builtBytes)) throw new Error(`${built} is stale relative to ${source}`);
}

const bundle = await esbuild.build({
  entryPoints: [resolve(root, 'web-src/main.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  write: false
});
const expectedMain = bundle.outputFiles[0]?.contents;
const builtMain = await readFile(resolve(root, 'module/webroot/assets/main.js'));
if (!expectedMain || !builtMain.equals(expectedMain)) {
  throw new Error('module/webroot/assets/main.js is stale relative to web-src/main.ts');
}

const zipBytes = await readFile(zipPath);
const expectedHash = createHash('sha256').update(zipBytes).digest('hex');
const hashFile = await readFile(`${zipPath}.sha256`, 'utf8');
if (hashFile.trim() !== `${expectedHash}  ${basename(zipPath)}`) {
  throw new Error('dist sha256 file does not match the package');
}
console.log(`verified ${zipPath}`);
