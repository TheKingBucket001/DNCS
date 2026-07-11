import {
  AppInfo,
  appIdentity,
  isValidPackageName,
  isValidUid,
  isValidUserId
} from './state';

export type ConfigFormat = 'v2' | 'v1' | 'legacy';

export interface ConfigIdentity {
  userId: string;
  packageName: string;
}

export interface ConfigGroup {
  savedUid: string;
  apps: ConfigIdentity[];
}

export interface ParsedConfig {
  format: ConfigFormat;
  uids: string[];
  groups: ConfigGroup[];
}

export interface ResolvedConfig {
  format: ConfigFormat;
  uids: string[];
  sourceGroupCount: number;
  skippedGroupCount: number;
}

function parseUidPayload(lines: string[]): string[] {
  const uids = new Set<string>();
  for (const line of lines) {
    const uid = line.startsWith('uid=') ? line.slice(4) : line;
    if (!isValidUid(uid)) throw new Error('配置文件包含无效 UID');
    uids.add(uid);
  }
  return [...uids].sort((a, b) => Number(a) - Number(b));
}

function parseV2(lines: string[]): ParsedConfig {
  const groups = new Map<string, Map<string, ConfigIdentity>>();
  let currentUid = '';

  for (const line of lines) {
    if (line.startsWith('uid=')) {
      currentUid = line.slice(4);
      if (!isValidUid(currentUid)) throw new Error('配置文件包含无效 UID');
      if (!groups.has(currentUid)) groups.set(currentUid, new Map());
      continue;
    }
    if (!line.startsWith('app=') || !currentUid) throw new Error('配置文件格式不正确');
    const identity = line.slice(4);
    const separator = identity.indexOf('|');
    if (separator <= 0 || separator === identity.length - 1) throw new Error('配置文件包含无效应用身份');
    const userId = identity.slice(0, separator);
    const packageName = identity.slice(separator + 1);
    if (!isValidUserId(userId) || !isValidPackageName(packageName)) {
      throw new Error('配置文件包含无效应用身份');
    }
    groups.get(currentUid)?.set(`${userId}|${packageName}`, { userId, packageName });
  }

  return {
    format: 'v2',
    uids: [],
    groups: [...groups.entries()].map(([savedUid, apps]) => ({ savedUid, apps: [...apps.values()] }))
  };
}

export function parseConfigText(raw: string): ParsedConfig {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) throw new Error('配置文件为空');

  if (lines[0] === 'DNCS_CONFIG_V2') return parseV2(lines.slice(1));
  if (/^DNCS_CONFIG_V\d+$/.test(lines[0]) && lines[0] !== 'DNCS_CONFIG_V1') {
    throw new Error('配置文件版本不受支持');
  }

  const format: ConfigFormat = lines[0] === 'DNCS_CONFIG_V1' ? 'v1' : 'legacy';
  const payload = format === 'v1' ? lines.slice(1) : lines;
  if (format === 'legacy' && !payload.every((line) => isValidUid(line) || /^uid=\d+$/.test(line))) {
    throw new Error('配置文件格式不正确');
  }
  return { format, uids: parseUidPayload(payload), groups: [] };
}

export function resolveConfig(config: ParsedConfig, apps: AppInfo[]): ResolvedConfig {
  if (config.format !== 'v2') {
    return {
      format: config.format,
      uids: config.uids,
      sourceGroupCount: config.uids.length,
      skippedGroupCount: 0
    };
  }

  const identityMap = new Map<string, AppInfo[]>();
  const uidIdentities = new Map<string, Set<string>>();
  for (const app of apps) {
    const identity = appIdentity(app);
    const matches = identityMap.get(identity) ?? [];
    matches.push(app);
    identityMap.set(identity, matches);
    const identities = uidIdentities.get(app.uid) ?? new Set<string>();
    identities.add(identity);
    uidIdentities.set(app.uid, identities);
  }

  const resolved = new Set<string>();
  let skippedGroupCount = 0;
  for (const group of config.groups) {
    const savedIdentities = new Set(group.apps.map((app) => `${app.userId}|${app.packageName}`));
    const matchedUids = new Set<string>();
    let valid = savedIdentities.size > 0;
    for (const identity of savedIdentities) {
      const matches = identityMap.get(identity) ?? [];
      const uids = new Set(matches.map((app) => app.uid));
      if (uids.size !== 1) {
        valid = false;
        break;
      }
      matchedUids.add([...uids][0]);
    }

    if (valid && matchedUids.size === 1) {
      const [uid] = matchedUids;
      const currentIdentities = uidIdentities.get(uid) ?? new Set<string>();
      valid = currentIdentities.size === savedIdentities.size
        && [...savedIdentities].every((identity) => currentIdentities.has(identity));
      if (valid) resolved.add(uid);
    }
    if (!valid) skippedGroupCount += 1;
  }

  return {
    format: config.format,
    uids: [...resolved].sort((a, b) => Number(a) - Number(b)),
    sourceGroupCount: config.groups.length,
    skippedGroupCount
  };
}
