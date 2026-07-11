import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const runtimeNames = new Set(['apps.txt', 'dncs.log', 'dncs.log.old', 'blocked.conf', 'blocked.conf.bak', 'debug.flag', 'boot-info.mark', '.dncs.lock', '.dncs.txn']);
const runtimePatterns = [/\.tmp$/, /\.new$/, /\.preserve\./, /^apps\.txt\..*\.tmp$/, /^ipt_(err|out)\./, /^user(s)?\.tmp/, /^package\.tmp/, /^config_uids\./, /^\.dncs\.txn\./, /^\.dncs\.lock\.(?:stale|release)\./];
const zip = new AdmZip();

async function addDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(moduleDir, abs).split(sep).join('/');
    if (entry.name === '.gitkeep' || runtimeNames.has(entry.name) || runtimePatterns.some((pattern) => pattern.test(entry.name))) continue;
    if (entry.isDirectory()) await addDir(abs);
    else zip.addLocalFile(abs, dirname(rel) === '.' ? '' : dirname(rel), basename(rel));
  }
}

await addDir(moduleDir);
const out = resolve(distDir, `dncs-${version}.zip`);
zip.writeZip(out);
const data = await readFile(out);
await writeFile(`${out}.sha256`, `${createHash('sha256').update(data).digest('hex')}  ${basename(out)}\n`, 'utf8');
console.log(relative(root, out));
