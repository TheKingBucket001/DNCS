import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeTimeoutError, enableEdgeToEdgeCompat, exec } from '../../web-src/bridge';
import { runCore } from '../../web-src/shell';

type FakeWindow = Record<string, unknown> & typeof globalThis;

function installBridge(bridge: Record<string, unknown>): FakeWindow {
  const fakeWindow = { ksu: bridge, clearTimeout, setTimeout } as unknown as FakeWindow;
  vi.stubGlobal('window', fakeWindow);
  return fakeWindow;
}

function callbackKeys(win: FakeWindow): string[] {
  return Object.keys(win).filter((key) => key.startsWith('__dncsExecCallback_'));
}

describe('KernelSU bridge wrapper', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the KernelSU inset method and falls back to the APatch method with bridge binding intact', () => {
    const ksuCalls: boolean[] = [];
    const ksuBridge = {
      exec() {},
      enableEdgeToEdge(this: unknown, enabled: boolean) {
        expect(this).toBe(ksuBridge);
        ksuCalls.push(enabled);
      },
      enableInsets() {
        throw new Error('APatch fallback should not run when the KSU method exists');
      }
    };
    installBridge(ksuBridge);
    enableEdgeToEdgeCompat(true);
    expect(ksuCalls).toEqual([true]);

    const apatchCalls: boolean[] = [];
    const apatchBridge = {
      exec() {},
      enableInsets(this: unknown, enabled: boolean) {
        expect(this).toBe(apatchBridge);
        apatchCalls.push(enabled);
      }
    };
    installBridge(apatchBridge);
    enableEdgeToEdgeCompat(false);
    expect(apatchCalls).toEqual([false]);
  });

  it('keeps callback exec concurrent, bound to the injected bridge, and cleans callback globals', async () => {
    const callbackNames: string[] = [];
    let win: FakeWindow;
    const bridge = {
      exec(this: unknown, command: string, _options: string, callbackName: string) {
        expect(this).toBe(bridge);
        callbackNames.push(callbackName);
        const stdout = command.includes(' apply ') ? 'SUCCESS\n' : 'READY\n';
        const delay = command.includes(' apply ') ? 1 : 8;
        setTimeout(() => {
          const callback = win[callbackName] as (errno: number, stdout: string, stderr: string) => void;
          callback(0, stdout, '');
        }, delay);
      }
    };
    win = installBridge(bridge);

    await expect(Promise.all([
      runCore(exec, 'list'),
      runCore(exec, 'apply', ['1000'])
    ])).resolves.toEqual(['READY\n', 'SUCCESS\n']);

    expect(new Set(callbackNames).size).toBe(2);
    expect(callbackKeys(win)).toEqual([]);
  });

  it('does not treat string errno from promise-style bridges as success', async () => {
    installBridge({
      exec() {
        return Promise.resolve({ errno: '1', stdout: 'FAIL\n', stderr: '' });
      }
    });

    await expect(runCore(exec, 'apply', ['1000'])).rejects.toThrow('FAIL');
  });

  it('prefers the asynchronous native spawn bridge and collects streamed output', async () => {
    let win: FakeWindow;
    const bridge = {
      exec() {
        throw new Error('sync exec should not run');
      },
      spawn(this: unknown, command: string, args: string, _options: string, callbackName: string) {
        expect(this).toBe(bridge);
        expect(command).toContain(' list');
        expect(args).toBe('');
        setTimeout(() => {
          const callback = win[callbackName] as {
            stdout: { emit: (event: string, data: string) => void };
            emit: (event: string, code: number) => void;
          };
          callback.stdout.emit('data', 'READY');
          callback.emit('exit', 0);
        }, 1);
      }
    };
    win = installBridge(bridge);

    await expect(runCore(exec, 'list')).resolves.toBe('READY');
    expect(callbackKeys(win)).toEqual([]);
  });

  it('absorbs the KernelSU nonzero exit-then-error sequence before removing the spawn callback', async () => {
    let win: FakeWindow;
    const bridge = {
      exec() {
        throw new Error('sync exec should not run');
      },
      spawn(_command: string, _args: string, _options: string, callbackName: string) {
        setTimeout(() => {
          const callback = win[callbackName] as {
            stderr: { emit: (event: string, data: string) => void };
            emit: (event: string, value: unknown) => void;
          };
          callback.stderr.emit('data', 'forced failure');
          callback.emit('exit', 7);
          callback.emit('error', Object.assign(new Error('forced failure'), { exitCode: 7 }));
        }, 1);
      }
    };
    win = installBridge(bridge);

    await expect(runCore(exec, 'list')).rejects.toThrow('forced failure');
    expect(callbackKeys(win)).toEqual([]);
  });

  it('falls back to a nonzero spawn exit when a compatible bridge emits no error event', async () => {
    vi.useFakeTimers();
    let win: FakeWindow;
    const bridge = {
      exec() {},
      spawn(_command: string, _args: string, _options: string, callbackName: string) {
        const callback = win[callbackName] as { emit: (event: string, value: unknown) => void };
        callback.emit('exit', 9);
      }
    };
    win = installBridge(bridge);
    const pending = runCore(exec, 'list');
    const rejection = expect(pending).rejects.toThrow('core action failed: list');

    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(callbackKeys(win)).toEqual([]);
  });

  it('marks a silent spawn timeout unknown and removes its late callback tombstone on exit', async () => {
    vi.useFakeTimers();
    const win = installBridge({ exec() {}, spawn() {} });
    const pending = exec('timeout -s TERM -k 5 50 sh /data/adb/modules/dncs/scripts/core.sh list');
    const rejection = expect(pending).rejects.toBeInstanceOf(BridgeTimeoutError);

    await vi.advanceTimersByTimeAsync(60000);
    await rejection;
    const [callbackName] = callbackKeys(win);
    expect(callbackName).toBeTruthy();
    const callback = win[callbackName] as { emit: (event: string, value: unknown) => void };
    callback.emit('exit', 124);
    expect(callbackKeys(win)).toEqual([]);
  });

  it('normalizes invalid callback errno to failure and prefers stderr', async () => {
    let win: FakeWindow;
    installBridge({
      exec(_command: string, _options: string, callbackName: string) {
        setTimeout(() => {
          const callback = win[callbackName] as (errno: string, stdout: string, stderr: string) => void;
          callback('bad-errno', 'IGNORED\n', 'broken');
        }, 1);
      }
    });
    win = globalThis.window as unknown as FakeWindow;

    await expect(runCore(exec, 'list')).rejects.toThrow('broken');
    expect(callbackKeys(win)).toEqual([]);
  });

  it('cleans callback globals when the injected bridge throws', async () => {
    const win = installBridge({
      exec() {
        throw new Error('bridge boom');
      }
    });

    await expect(exec('sh /data/adb/modules/dncs/scripts/core.sh list')).rejects.toThrow('bridge boom');
    expect(callbackKeys(win)).toEqual([]);
  });

  it('skips bridge aliases without exec and accepts a three-argument synchronous result', async () => {
    const fakeWindow = {
      ksu: { toast() {} },
      apatch: {
        exec(_command: string, _options: string, _callbackName: string) {
          return { errno: 0, stdout: 'READY\n', stderr: '' };
        }
      },
      clearTimeout,
      setTimeout
    } as unknown as FakeWindow;
    vi.stubGlobal('window', fakeWindow);

    await expect(runCore(exec, 'list')).resolves.toBe('READY\n');
    expect(callbackKeys(fakeWindow)).toEqual([]);
  });

  it('marks timeout as an unknown result and leaves a one-shot late callback tombstone', async () => {
    vi.useFakeTimers();
    const win = installBridge({ exec() {} });
    const pending = exec('sh /data/adb/modules/dncs/scripts/core.sh apply 1000');
    const rejection = expect(pending).rejects.toBeInstanceOf(BridgeTimeoutError);

    await vi.advanceTimersByTimeAsync(60000);
    await rejection;
    const [callbackName] = callbackKeys(win);
    expect(callbackName).toBeTruthy();
    (win[callbackName] as () => void)();
    expect(callbackKeys(win)).toEqual([]);
  });
});
