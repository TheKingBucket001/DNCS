import { describe, expect, it } from 'vitest';
import { parseConfigText, resolveConfig } from '../../web-src/config';
import { parseAppsText } from '../../web-src/state';

describe('DNCS config parser', () => {
  it('parses DNCS_CONFIG_V1 with comments, uid lines, dedupe, and numeric sorting', () => {
    expect(parseConfigText([
      'DNCS_CONFIG_V1',
      '# created=2026-07-10 15:20:00',
      'uid=10387',
      '10007',
      'uid=10387',
      '10266'
    ].join('\n'))).toEqual({
      format: 'v1',
      uids: ['10007', '10266', '10387'],
      groups: []
    });
  });

  it('keeps legacy plain UID config compatible', () => {
    expect(parseConfigText('10167\n10007\n')).toEqual({
      format: 'legacy',
      uids: ['10007', '10167'],
      groups: []
    });
  });

  it('resolves V2 package identities to current UIDs and preserves complete shared groups', () => {
    const config = parseConfigText([
      'DNCS_CONFIG_V2',
      'uid=10123',
      'app=0|com.example.single',
      'uid=1000',
      'app=0|android',
      'app=0|com.example.shared'
    ].join('\n'));
    const { apps } = parseAppsText([
      'com.example.single|10555|user|0|0|com.example.single',
      'android|1000|shared|0|0|android',
      'com.example.shared|1000|shared|0|0|com.example.shared'
    ].join('\n'));

    expect(resolveConfig(config, apps)).toEqual({
      format: 'v2',
      uids: ['1000', '10555'],
      sourceGroupCount: 2,
      skippedGroupCount: 0
    });
  });

  it('skips V2 groups when an app is missing or the current shared UID has extra packages', () => {
    const config = parseConfigText([
      'DNCS_CONFIG_V2',
      'uid=10123',
      'app=0|com.example.missing',
      'uid=1000',
      'app=0|android',
      'app=0|com.example.shared'
    ].join('\n'));
    const { apps } = parseAppsText([
      'android|1000|shared|0|0|android',
      'com.example.shared|1000|shared|0|0|com.example.shared',
      'com.example.newmember|1000|shared|0|0|com.example.newmember'
    ].join('\n'));

    expect(resolveConfig(config, apps)).toEqual({
      format: 'v2',
      uids: [],
      sourceGroupCount: 2,
      skippedGroupCount: 2
    });
  });

  it('rejects empty, malformed, and invalid UID configs before apply', () => {
    expect(() => parseConfigText('# empty only\n')).toThrow('配置文件为空');
    expect(() => parseConfigText('DNCS_CONFIG_V1\nuid=abc\n')).toThrow('配置文件包含无效 UID');
    expect(() => parseConfigText('DNCS_CONFIG_V1\nname=bad\n')).toThrow('配置文件包含无效 UID');
    expect(() => parseConfigText('not-a-uid\n1000\n')).toThrow('配置文件格式不正确');
    expect(() => parseConfigText('DNCS_CONFIG_V2\napp=0|com.example.app\n')).toThrow('配置文件格式不正确');
    expect(() => parseConfigText('DNCS_CONFIG_V2\nuid=1000\napp=bad|com.example.app\n')).toThrow('配置文件包含无效应用身份');
    expect(() => parseConfigText('DNCS_CONFIG_V3\nuid=1000\n')).toThrow('配置文件版本不受支持');
  });
});
