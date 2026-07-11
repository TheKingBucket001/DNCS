export type AppType = 'user' | 'system' | 'shared';
export type SearchMode = 'pkg' | 'uid';

export interface AppInfo {
  pkg: string;
  packageName: string;
  userId: string;
  displayPkg: string;
  isClone: boolean;
  uid: string;
  type: AppType;
}

export interface ParsedApps {
  apps: AppInfo[];
  blocked: Set<string>;
}

export const CATEGORIES: readonly AppType[] = ['user', 'system', 'shared'];

const VALID_APP_TYPES = new Set<AppType>(CATEGORIES);
const CLONE_SUFFIX = /^(.*) \(分身:(\d+)\)$/;

export function isValidUid(value: string): boolean {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) return false;
  return Number(value) <= 2147483647;
}

export function isValidUserId(value: string): boolean {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) return false;
  return Number(value) <= 21474;
}

export function isValidPackageName(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(value);
}

export function appIdentity(app: AppInfo): string {
  return `${app.userId}|${app.packageName}`;
}

export function parseAppsText(raw: string): ParsedApps {
  const apps: AppInfo[] = [];
  const blocked = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pkg, uid, type, blockedFlag, storedUserId, storedPackageName] = line.split('|');
    if (!pkg || !isValidUid(uid) || !VALID_APP_TYPES.has(type as AppType)) continue;

    const cloneMatch = pkg.match(CLONE_SUFFIX);
    const displayPkg = cloneMatch ? cloneMatch[1] : pkg;
    const userId = storedUserId || cloneMatch?.[2] || '0';
    const packageName = storedPackageName || displayPkg;
    if (!isValidUserId(userId) || !isValidPackageName(packageName)) continue;
    const isBlocked = blockedFlag === '1';

    apps.push({
      pkg,
      packageName,
      userId,
      displayPkg,
      isClone: userId !== '0',
      uid,
      type: type as AppType
    });

    if (isBlocked) blocked.add(uid);
  }

  return { apps, blocked };
}

export function setPendingChange(
  pending: Record<string, boolean>,
  currentBlocked: Set<string>,
  uid: string,
  nextBlocked: boolean
): Record<string, boolean> {
  if (!isValidUid(uid)) return pending;
  const updated = { ...pending };
  if (currentBlocked.has(uid) === nextBlocked) delete updated[uid];
  else updated[uid] = nextBlocked;
  return updated;
}

export function isEffectivelyBlocked(uid: string, currentBlocked: Set<string>, pending: Record<string, boolean>): boolean {
  return Object.prototype.hasOwnProperty.call(pending, uid) ? pending[uid] : currentBlocked.has(uid);
}

export function mergeBlocked(currentBlocked: Set<string>, pending: Record<string, boolean>): string[] {
  const merged = new Set(currentBlocked);
  for (const [uid, enabled] of Object.entries(pending)) {
    if (!isValidUid(uid)) continue;
    if (enabled) merged.add(uid);
    else merged.delete(uid);
  }
  return [...merged].sort((a, b) => Number(a) - Number(b));
}

export function filterApps(apps: AppInfo[], category: AppType, query: string, mode: SearchMode, blocked: Set<string>): AppInfo[] {
  const normalized = query.trim().toLowerCase();
  return apps
    .filter((app) => {
      if (app.type !== category) return false;
      if (!normalized) return true;
      return mode === 'pkg' ? app.pkg.toLowerCase().includes(normalized) : app.uid.includes(normalized);
    })
    .sort((a, b) => {
      const blockedDelta = Number(blocked.has(b.uid)) - Number(blocked.has(a.uid));
      if (blockedDelta) return blockedDelta;
      return a.pkg.localeCompare(b.pkg, 'zh-CN');
    });
}

export interface SharedGroup {
  uid: string;
  apps: AppInfo[];
}

export function groupSharedApps(apps: AppInfo[]): SharedGroup[] {
  const groups = new Map<string, AppInfo[]>();
  for (const app of apps) {
    const list = groups.get(app.uid) ?? [];
    list.push(app);
    groups.set(app.uid, list);
  }
  return [...groups.entries()]
    .map(([uid, groupApps]) => ({ uid, apps: groupApps.sort((a, b) => a.pkg.localeCompare(b.pkg, 'zh-CN')) }))
    .sort((a, b) => Number(a.uid) - Number(b.uid));
}

export function badgeKind(uid: string, currentBlocked: Set<string>, pending: Record<string, boolean>): 'blocked' | 'pending-block' | 'pending-restore' | 'none' {
  const actual = currentBlocked.has(uid);
  if (Object.prototype.hasOwnProperty.call(pending, uid)) {
    if (pending[uid] && !actual) return 'pending-block';
    if (!pending[uid] && actual) return 'pending-restore';
  }
  return actual ? 'blocked' : 'none';
}
