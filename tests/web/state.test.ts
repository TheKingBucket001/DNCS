import { describe, expect, it } from 'vitest';
import { badgeKind, filterApps, groupSharedApps, isEffectivelyBlocked, isValidUid, mergeBlocked, parseAppsText, setPendingChange } from '../../web-src/state';

describe('apps.txt parsing', () => {
  it('parses valid rows and skips malformed data', () => {
    const parsed = parseAppsText([
      'com.demo.app|10123|user|1',
      'bad|uid|user|0',
      'com.android.phone|1001|system|0',
      'com.shared.one|1000|shared|0',
      'com.demo.app (分身:10)|110123|user|0'
    ].join('\n'));

    expect(parsed.apps).toHaveLength(4);
    expect(parsed.blocked.has('10123')).toBe(true);
    expect(parsed.apps[3].displayPkg).toBe('com.demo.app');
    expect(parsed.apps[3].isClone).toBe(true);
    expect(parsed.apps[3].userId).toBe('10');
    expect(parsed.apps[3].packageName).toBe('com.demo.app');
  });

  it('rejects UIDs outside Android signed uid_t range', () => {
    expect(isValidUid('2147483647')).toBe(true);
    expect(isValidUid('2147483648')).toBe(false);
    expect(isValidUid('99999999999999999999')).toBe(false);
  });
});

describe('state reducers', () => {
  it('tracks only changes that differ from current blocked set', () => {
    const current = new Set(['10001']);
    let pending = setPendingChange({}, current, '10001', false);
    expect(pending).toEqual({ '10001': false });
    pending = setPendingChange(pending, current, '10001', true);
    expect(pending).toEqual({});
    pending = setPendingChange(pending, current, '10002', true);
    expect(isEffectivelyBlocked('10002', current, pending)).toBe(true);
    expect(mergeBlocked(current, pending)).toEqual(['10001', '10002']);
  });

  it('reports badge states', () => {
    const current = new Set(['1']);
    expect(badgeKind('1', current, {})).toBe('blocked');
    expect(badgeKind('1', current, { '1': false })).toBe('pending-restore');
    expect(badgeKind('2', current, { '2': true })).toBe('pending-block');
    expect(badgeKind('3', current, {})).toBe('none');
  });
});

describe('filtering and grouping', () => {
  const { apps } = parseAppsText([
    'com.beta|10002|user|0',
    'com.alpha|10001|user|1',
    'com.sys|1000|system|0',
    'com.shared.b|1000|shared|0',
    'com.shared.a|1000|shared|0'
  ].join('\n'));

  it('filters by category and sorts blocked apps first', () => {
    const result = filterApps(apps, 'user', '', 'pkg', new Set(['10001']));
    expect(result.map((app) => app.pkg)).toEqual(['com.alpha', 'com.beta']);
  });

  it('filters UID search', () => {
    const result = filterApps(apps, 'user', '10002', 'uid', new Set());
    expect(result.map((app) => app.pkg)).toEqual(['com.beta']);
  });

  it('groups shared UID apps', () => {
    const result = groupSharedApps(apps.filter((app) => app.type === 'shared'));
    expect(result).toHaveLength(1);
    expect(result[0].uid).toBe('1000');
    expect(result[0].apps.map((app) => app.pkg)).toEqual(['com.shared.a', 'com.shared.b']);
  });
});
