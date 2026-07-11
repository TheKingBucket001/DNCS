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
  appliedCount: number;
  requestedCount: number;
  uids: string[];
}

export type ApplyResolution =
  | { kind: 'authoritative'; result: ApplyResult }
  | { kind: 'reconciled'; succeeded: boolean };

const APPLY_FAILURE_RESULTS = new Set([
  'FAIL',
  'FS_ERROR',
  'INVALID_UID',
  'PMS_ERROR',
  'UPDATE_PENDING',
  'RECOVERY_FAILED',
  'LOCKED',
  'INIT_FAILED'
]);

export class ApplyResultUnknownError extends Error {
  constructor(message = 'APPLY_RESULT_UNKNOWN') {
    super(message);
    this.name = 'ApplyResultUnknownError';
  }
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
  const match = token.match(/^SUCCESS:(\d+):(\d+):(.*)$/);
  if (!match) {
    if (APPLY_FAILURE_RESULTS.has(token)) throw new Error(token);
    throw new ApplyResultUnknownError(token ? 'INVALID_APPLY_RESULT' : 'EMPTY_APPLY_RESULT');
  }

  const appliedCount = Number(match[1]);
  const requestedCount = Number(match[2]);
  const uids = match[3] ? match[3].split(',') : [];
  if (!Number.isSafeInteger(appliedCount)
    || !Number.isSafeInteger(requestedCount)
    || requestedCount < appliedCount
    || uids.length !== appliedCount
    || uids.some((uid) => !isValidUid(uid))
    || new Set(uids).size !== uids.length) {
    throw new ApplyResultUnknownError('INVALID_APPLY_RESULT');
  }
  return { appliedCount, requestedCount, uids };
}

export async function resolveApplyExecution(
  runApply: () => Promise<string>,
  reconcile: () => Promise<boolean>
): Promise<ApplyResolution> {
  try {
    return { kind: 'authoritative', result: parseApplyResult(await runApply()) };
  } catch (error) {
    if (!(error instanceof BridgeTimeoutError) && !(error instanceof ApplyResultUnknownError)) throw error;
    return { kind: 'reconciled', succeeded: await reconcile() };
  }
}
