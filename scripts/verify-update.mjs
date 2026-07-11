import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'TheKingBucket001/DNCS';
const expectedUpdateUrl = `https://raw.githubusercontent.com/${repository}/main/update.json`;

function parseProperties(text) {
  return Object.fromEntries(
    text
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator <= 0) throw new Error(`invalid module.prop line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function requireHttps(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
}

const [moduleText, packageText, updateText, indexText] = await Promise.all([
  readFile(resolve(root, 'module/module.prop'), 'utf8'),
  readFile(resolve(root, 'package.json'), 'utf8'),
  readFile(resolve(root, 'update.json'), 'utf8'),
  readFile(resolve(root, 'web-src/index.html'), 'utf8')
]);

const moduleProperties = parseProperties(moduleText);
const packageJson = JSON.parse(packageText);
const update = JSON.parse(updateText);
const versionCode = Number(moduleProperties.versionCode);

if (moduleProperties.id !== 'dncs') throw new Error('module id must remain dncs');
if (!moduleProperties.version) throw new Error('module.prop missing version');
if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
  throw new Error('module.prop versionCode must be a positive integer');
}
if (packageJson.version !== moduleProperties.version) {
  throw new Error('package.json version differs from module.prop');
}
if (!indexText.includes(`<strong>${moduleProperties.version}</strong>`)) {
  throw new Error('About page version differs from module.prop');
}
if (moduleProperties.updateJson !== expectedUpdateUrl) {
  throw new Error('module.prop updateJson differs from the canonical manifest URL');
}
if (update.version !== moduleProperties.version || update.versionCode !== versionCode) {
  throw new Error('update.json version metadata differs from module.prop');
}

const expectedZipUrl = `https://github.com/${repository}/releases/download/v${update.version}/dncs-${update.version}.zip`;
if (update.zipUrl !== expectedZipUrl) {
  throw new Error('update.json zipUrl differs from the canonical release asset URL');
}
if (typeof update.changelog !== 'string' || !update.changelog.trim()) {
  throw new Error('update.json changelog must be a non-empty string');
}

requireHttps(moduleProperties.updateJson, 'updateJson');
requireHttps(update.zipUrl, 'zipUrl');
console.log(`verified update metadata for DNCS ${update.version} (${update.versionCode})`);
