import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const script = resolve(root, 'tests/shell/core_stub_test.sh');
const core = resolve(root, 'module/scripts/core.sh');
const customize = resolve(root, 'module/customize.sh');
const service = resolve(root, 'module/service.sh');
const uninstall = resolve(root, 'module/uninstall.sh');

function runLocalShell() {
  return spawnSync('sh', [script], { cwd: root, stdio: 'inherit' });
}

function runAndroidShellFallback() {
  const adbVersion = spawnSync('adb', ['version'], { stdio: 'ignore' });
  if (adbVersion.error || adbVersion.status !== 0) return false;

  const devices = spawnSync('adb', ['devices'], { encoding: 'utf8' });
  if (devices.error || devices.status !== 0 || !/\tdevice\b/.test(devices.stdout)) return false;

  const remote = `/data/local/tmp/dncs-shell-test-${Date.now()}`;
  const setup = spawnSync('adb', ['shell', `rm -rf ${remote}; mkdir -p ${remote}/module/scripts ${remote}/tests/shell`], { stdio: 'inherit' });
  if (setup.status !== 0) return true;
  const pushCore = spawnSync('adb', ['push', core, `${remote}/module/scripts/core.sh`], { stdio: 'inherit' });
  const pushCustomize = spawnSync('adb', ['push', customize, `${remote}/module/customize.sh`], { stdio: 'inherit' });
  const pushService = spawnSync('adb', ['push', service, `${remote}/module/service.sh`], { stdio: 'inherit' });
  const pushUninstall = spawnSync('adb', ['push', uninstall, `${remote}/module/uninstall.sh`], { stdio: 'inherit' });
  const pushTest = spawnSync('adb', ['push', script, `${remote}/tests/shell/core_stub_test.sh`], { stdio: 'inherit' });
  if (pushCore.status !== 0 || pushCustomize.status !== 0 || pushService.status !== 0 || pushUninstall.status !== 0 || pushTest.status !== 0) return true;
  const chmod = spawnSync('adb', ['shell', 'chmod', '755', `${remote}/module/scripts/core.sh`, `${remote}/module/customize.sh`, `${remote}/tests/shell/core_stub_test.sh`], { stdio: 'inherit' });
  if (chmod.status !== 0) return true;
  const run = spawnSync('adb', ['shell', 'su', '0', 'env', 'TMPDIR=/data/local/tmp', 'sh', `${remote}/tests/shell/core_stub_test.sh`], { stdio: 'inherit' });
  spawnSync('adb', ['shell', 'rm', '-rf', remote], { stdio: 'ignore' });
  process.exit(run.status ?? 1);
}

const result = runLocalShell();

if (result.error && result.error.code === 'ENOENT') {
  if (!runAndroidShellFallback()) {
    console.error('shell stub tests failed to run: sh not found and no adb device available');
    process.exit(1);
  }
  process.exit(1);
}
if (result.error) throw result.error;
process.exit(result.status ?? 1);
