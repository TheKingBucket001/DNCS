import { describe, expect, it, vi } from 'vitest';
import {
  ApplyResultUnknownError,
  CORE_SCRIPT,
  CORE_TIMEOUT_SECONDS,
  buildCoreCommand,
  parseApplyResult,
  resolveApplyExecution,
  runCore
} from '../../web-src/shell';
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

  it('only accepts a complete structured apply result as authoritative state', () => {
    expect(parseApplyResult('SUCCESS:2:3:1000,10123\n')).toEqual({
      appliedCount: 2,
      requestedCount: 3,
      uids: ['1000', '10123']
    });
    expect(parseApplyResult('SUCCESS:0:0:')).toEqual({
      appliedCount: 0,
      requestedCount: 0,
      uids: []
    });
    expect(() => parseApplyResult('SUCCESS')).toThrow(ApplyResultUnknownError);
    expect(() => parseApplyResult('SUCCESS:2:1:1000,10123')).toThrow(ApplyResultUnknownError);
    expect(() => parseApplyResult('SUCCESS:2:2:1000')).toThrow(ApplyResultUnknownError);
    expect(() => parseApplyResult('FAIL')).toThrow('FAIL');
  });

  it('skips reconcile only for an authoritative structured success', async () => {
    const reconcile = vi.fn(async () => true);
    await expect(resolveApplyExecution(
      async () => 'SUCCESS:1:1:10123',
      reconcile
    )).resolves.toEqual({
      kind: 'authoritative',
      result: { appliedCount: 1, requestedCount: 1, uids: ['10123'] }
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ['bridge timeout', async () => { throw new BridgeTimeoutError(); }],
    ['legacy success', async () => 'SUCCESS'],
    ['damaged success', async () => 'SUCCESS:2:2:10123'],
    ['missing output', async () => '']
  ])('reconciles an uncertain apply result: %s', async (_label, runApply) => {
    const reconcile = vi.fn(async () => true);
    await expect(resolveApplyExecution(runApply, reconcile)).resolves.toEqual({
      kind: 'reconciled',
      succeeded: true
    });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('does not reconcile an explicit apply failure', async () => {
    const reconcile = vi.fn(async () => true);
    await expect(resolveApplyExecution(async () => 'FS_ERROR', reconcile)).rejects.toThrow('FS_ERROR');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('keeps an uncertain result untrusted when reconcile fails', async () => {
    await expect(resolveApplyExecution(
      async () => 'SUCCESS',
      async () => false
    )).resolves.toEqual({ kind: 'reconciled', succeeded: false });
  });
});
