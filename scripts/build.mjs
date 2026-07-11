import { mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const webroot = resolve(root, 'module/webroot');
const assets = resolve(webroot, 'assets');

await mkdir(assets, { recursive: true });
await rm(resolve(assets, 'main.js'), { force: true });
await rm(resolve(assets, 'main.js.map'), { force: true });

await copyFile(resolve(root, 'web-src/index.html'), resolve(webroot, 'index.html'));
await copyFile(resolve(root, 'web-src/style.css'), resolve(assets, 'style.css'));
await copyFile(resolve(root, 'web-src/insets.css'), resolve(assets, 'insets.css'));
await copyFile(resolve(root, 'web-src/icon.svg'), resolve(webroot, 'icon.svg'));

await esbuild.build({
  entryPoints: [resolve(root, 'web-src/main.ts')],
  outfile: resolve(assets, 'main.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome109'],
  minify: true,
  legalComments: 'none',
  sourcemap: false
});

console.log('built module/webroot');
