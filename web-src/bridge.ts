export interface BridgeExecResult {
  errno?: number | string;
  stdout?: string;
  stderr?: string;
}

interface RootBridge {
  exec?: (command: string, options?: string, callbackName?: string) => unknown;
  spawn?: (command: string, args?: string, options?: string, callbackName?: string) => unknown;
  toast?: (message: string) => unknown;
  enableEdgeToEdge?: (enabled: boolean) => unknown;
  enableInsets?: (enabled: boolean) => unknown;
}

declare global {
  interface Window {
    ksud?: RootBridge;
    apatch?: RootBridge;
    ksu?: RootBridge;
    KSU?: RootBridge;
  }
}

type ExecCallback = (errno?: number | string, stdout?: string, stderr?: string) => void;
type SpawnStream = { emit: (event: string, data?: string) => void };
type SpawnCallback = {
  stdout: SpawnStream;
  stderr: SpawnStream;
  emit: (event: string, value?: unknown) => void;
};

let execCallbackSeq = 0;

export class BridgeTimeoutError extends Error {
  constructor() {
    super('Root 桥接执行超时，命令结果未知');
    this.name = 'BridgeTimeoutError';
  }
}

function createCallbackName(): string {
  execCallbackSeq = (execCallbackSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `__dncsExecCallback_${Date.now().toString(36)}_${execCallbackSeq}`;
}

export function getBridge(): RootBridge | null {
  const candidates = [window.ksu, window.apatch, window.ksud, window.KSU];
  return candidates.find((bridge) => typeof bridge?.exec === 'function') || null;
}

function isExecResult(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  return 'errno' in value || 'stdout' in value || 'stderr' in value;
}

function normalizeExecResult(value: unknown): BridgeExecResult {
  if (typeof value === 'string') return { errno: 0, stdout: value, stderr: '' };
  if (value && typeof value === 'object') {
    const result = value as BridgeExecResult;
    const errno = Number(result.errno ?? 0);
    return {
      errno: Number.isFinite(errno) ? errno : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  }
  return { errno: 0, stdout: '', stderr: '' };
}

function runSpawn(command: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<BridgeExecResult> {
  const bridge = getBridge();
  if (!bridge?.spawn) return runExec(command, options);
  const bridgeSpawn = bridge.spawn;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = 0;
    let lateCleanupId = 0;
    let exitFallbackId = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const callbackName = createCallbackName();
    const callbackRegistry = window as unknown as Record<string, SpawnCallback | undefined>;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.clearTimeout(lateCleanupId);
      window.clearTimeout(exitFallbackId);
      if (callbackRegistry[callbackName] === callback) delete callbackRegistry[callbackName];
    };
    const finish = (errno: unknown) => {
      if (settled) return;
      settled = true;
      const errnoNumber = Number(errno ?? 0);
      cleanup();
      resolve({
        errno: Number.isFinite(errnoNumber) ? errnoNumber : 1,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n')
      });
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const createStream = (target: string[]): SpawnStream => ({
      emit(event, data) {
        if (!settled && event === 'data' && typeof data === 'string') target.push(data);
      }
    });
    const callback: SpawnCallback = {
      stdout: createStream(stdout),
      stderr: createStream(stderr),
      emit(event, value) {
        if (event === 'exit') {
          const exitCode = Number(value ?? 0);
          const normalizedCode = Number.isFinite(exitCode) ? exitCode : 1;
          if (normalizedCode === 0) finish(0);
          else exitFallbackId = window.setTimeout(() => finish(normalizedCode), 250);
        } else if (event === 'error') {
          const error = value as { exitCode?: unknown; message?: unknown } | null;
          if (typeof error?.message === 'string' && error.message && stderr.length === 0) stderr.push(error.message);
          const exitCode = Number(error?.exitCode ?? 1);
          finish(Number.isFinite(exitCode) ? exitCode : 1);
        }
      }
    };

    callbackRegistry[callbackName] = callback;
    timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(exitFallbackId);
      const discardLateResult: SpawnCallback = {
        stdout: { emit() {} },
        stderr: { emit() {} },
        emit(event) {
          if (event !== 'exit' && event !== 'error') return;
          window.clearTimeout(lateCleanupId);
          if (callbackRegistry[callbackName] === discardLateResult) delete callbackRegistry[callbackName];
        }
      };
      callbackRegistry[callbackName] = discardLateResult;
      lateCleanupId = window.setTimeout(() => {
        if (callbackRegistry[callbackName] === discardLateResult) delete callbackRegistry[callbackName];
      }, 300000);
      reject(new BridgeTimeoutError());
    }, 60000);

    try {
      bridgeSpawn.call(bridge, command, '', JSON.stringify(options), callbackName);
    } catch (error) {
      fail(error);
    }
  });
}

function runExec(command: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<BridgeExecResult> {
  const bridge = getBridge();
  if (!bridge?.exec) return Promise.reject(new Error('环境异常：未找到 Root 桥接接口'));
  const bridgeExec = bridge.exec;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = 0;
    let lateCleanupId = 0;
    const callbackName = createCallbackName();
    const callbackRegistry = window as unknown as Record<string, ExecCallback | undefined>;
    const callback = (errno?: number | string, stdout?: string, stderr?: string) => {
      const errnoNumber = Number(errno ?? 0);
      finish({ errno: Number.isFinite(errnoNumber) ? errnoNumber : 1, stdout: stdout || '', stderr: stderr || '' });
    };
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.clearTimeout(lateCleanupId);
      if (callbackRegistry[callbackName] === callback) delete callbackRegistry[callbackName];
    };
    const finish = (result: BridgeExecResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    callbackRegistry[callbackName] = callback;
    timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      const discardLateResult: ExecCallback = () => {
        window.clearTimeout(lateCleanupId);
        if (callbackRegistry[callbackName] === discardLateResult) delete callbackRegistry[callbackName];
      };
      callbackRegistry[callbackName] = discardLateResult;
      lateCleanupId = window.setTimeout(discardLateResult, 300000);
      reject(new BridgeTimeoutError());
    }, 60000);
    try {
      const returned = bridgeExec.call(bridge, command, JSON.stringify(options), callbackName);
      if (returned && typeof (returned as Promise<unknown>).then === 'function') {
        (returned as Promise<unknown>).then((value) => finish(normalizeExecResult(value))).catch(fail);
      } else if (isExecResult(returned)) {
        finish(normalizeExecResult(returned));
      }
    } catch (error) {
      fail(error);
    }
  });
}

export function exec(command: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<BridgeExecResult> {
  return runSpawn(command, options);
}

export function enableEdgeToEdgeCompat(enabled: boolean): void {
  const bridge = getBridge();
  if (!bridge) return;
  const enableInsets = bridge.enableEdgeToEdge || bridge.enableInsets;
  enableInsets?.call(bridge, enabled);
}

export function bridgeToast(message: string): void {
  const bridge = getBridge();
  if (!bridge?.toast) throw new Error('toast bridge unavailable');
  bridge.toast(message);
}
