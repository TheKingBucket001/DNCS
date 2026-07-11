import { describe, expect, it } from 'vitest';
import { CORE_SCRIPT, CORE_TIMEOUT_SECONDS, buildCoreCommand, parseApplyResult, runCore } from '../../web-src/shell';
import { BridgeTimeoutError } from '../../web-src/bridge';

describe('core shell command wrapper', () => {
  it('builds fixed action commands', () => {
    const prefix = `timeout -s TERM -k 5 ${CORE_TIMEOUT_SECONDS} sh ${CORE_SCRIPT}`;
    expect(buildCoreCommand('list')).toBe(`${prefix} list`);
    expect(buildCoreCommand('apply', ['1000', '10123'])).toBe(`${prefix} apply 1000 10123`);
    expect(buildCoreCommand('backup_config')).toBe(`${prefix} backup_config`);
  });

  it('rejects invalid UID arguments', () => {
    expect(() => buildCoreCommand('apply', ['1000;reboot'])).toThrow(/Invalid UID/);
    expect(() => buildCoreCommand('apply', ['2147483648'])).toThrow(/Invalid UID/);
    expect(() => buildCoreCommand('rescue', ['1000'])).toThrow(/does not accept/);
    expect(() => buildCoreCommand('backup_config', ['1000'])).toThrow(/does not accept/);
  });

  it('normalizes KernelSU exec results', async () => {
    await expect(runCore(async () => ({ errno: 0, stdout: 'READY\n' }), 'list')).resolves.toBe('READY\n');
    await expect(runCore(async () => ({ errno: 1, stderr: 'boom' }), 'list')).rejects.toThrow('boom');
    await expect(runCore(async () => ({ errno: '1', stdout: 'FAIL\n' }), 'apply', ['1000'])).rejects.toThrow('FAIL');
  });

  it('treats timeout termination codes as an unknown result that must be reconciled', async () => {
    for (const errno of [124, 137, 143]) {
      await expect(runCore(async () => ({ errno, stderr: 'terminated' }), 'apply', ['1000']))
        .rejects.toBeInstanceOf(BridgeTimeoutError);
    }
  });

  it('keeps boot-only actions out of the WebUI command surface', () => {
    expect(() => buildCoreCommand('boot_apply' as never)).toThrow(/Unsupported action/);
  });

  it('parses structured and legacy apply results without accepting malformed state', () => {
    expect(parseApplyResult('SUCCESS:2:3:1000,10123\n')).toEqual({
      appliedCount: 2,
      requestedCount: 3,
      uids: ['1000', '10123']
    });
    expect(parseApplyResult('SUCCESS')).toEqual({ appliedCount: null, requestedCount: null, uids: null });
    expect(() => parseApplyResult('SUCCESS:2:1:1000,10123')).toThrow('INVALID_APPLY_RESULT');
    expect(() => parseApplyResult('SUCCESS:2:2:1000')).toThrow('INVALID_APPLY_RESULT');
    expect(() => parseApplyResult('FAIL')).toThrow('FAIL');
  });
});
