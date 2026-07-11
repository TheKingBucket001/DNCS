import { isValidUid } from './state';
import { BridgeTimeoutError } from './bridge';

export const MODULE_DIR = '/data/adb/modules/dncs';
export const CORE_SCRIPT = `${MODULE_DIR}/scripts/core.sh`;
export const CORE_TIMEOUT_SECONDS = 50;

export type CoreAction = 'list' | 'apply' | 'backup_config' | 'rescue' | 'toggle_debug' | 'clear_log';

const ACTIONS = new Set<CoreAction>(['list', 'apply', 'backup_config', 'rescue', 'toggle_debug', 'clear_log']);

export interface ExecResult {
  errno?: number | string;
  stdout?: string;
  stderr?: string;
}

export type ExecFn = (command: string, options?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult | string>;

export interface ApplyResult {
  appliedCount: number | null;
  requestedCount: number | null;
  uids: string[] | null;
}

export function buildCoreCommand(action: CoreAction, uids: string[] = []): string {
  if (!ACTIONS.has(action)) throw new Error(`Unsupported action: ${action}`);
  if (action !== 'apply' && uids.length > 0) throw new Error(`${action} does not accept UID arguments`);
  for (const uid of uids) {
    if (!isValidUid(uid)) throw new Error(`Invalid UID: ${uid}`);
  }
  return ['timeout', '-s', 'TERM', '-k', '5', String(CORE_TIMEOUT_SECONDS), 'sh', CORE_SCRIPT, action, ...uids].join(' ');
}

export async function runCore(execFn: ExecFn, action: CoreAction, uids: string[] = []): Promise<string> {
  const command = buildCoreCommand(action, uids);
  const result = await execFn(command, { cwd: MODULE_DIR });
  if (typeof result === 'string') return result;
  if (result.errno !== undefined) {
    const errno = Number(result.errno);
    if (errno === 124 || errno === 137 || errno === 143) throw new BridgeTimeoutError();
    if (!Number.isFinite(errno) || errno !== 0) {
      throw new Error(result.stderr || result.stdout || `core action failed: ${action}`);
    }
  }
  return result.stdout || '';
}

export function parseApplyResult(raw: string): ApplyResult {
  const token = raw.trim();
  if (token === 'SUCCESS') return { appliedCount: null, requestedCount: null, uids: null };
  const match = token.match(/^SUCCESS:(\d+):(\d+):(.*)$/);
  if (!match) throw new Error(token || 'EMPTY');

  const appliedCount = Number(match[1]);
  const requestedCount = Number(match[2]);
  const uids = match[3] ? match[3].split(',') : [];
  if (!Number.isSafeInteger(appliedCount)
    || !Number.isSafeInteger(requestedCount)
    || requestedCount < appliedCount
    || uids.length !== appliedCount
    || uids.some((uid) => !isValidUid(uid))
    || new Set(uids).size !== uids.length) {
    throw new Error('INVALID_APPLY_RESULT');
  }
  return { appliedCount, requestedCount, uids };
}
