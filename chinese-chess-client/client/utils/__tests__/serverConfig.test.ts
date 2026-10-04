/**
 * @/utils/serverConfig —— 预置线路（樱花穿透 / Cloudflare）与自定义地址的读写契约
 *
 * 本模块的价值在于「用户永远连得上，且默认走快的那条线」。因此测试重点是三类
 * 会静默出错的场景：
 *   1. 持久化与内存缓存一致（用户点了换线路，界面必须立刻反映，不能被 30s 缓存拖住）；
 *   2. 线路选择与地址解析互不脱节（选了哪条线路，就必须存哪条地址）；
 *   3. 旧版本迁移不能误伤用户填过的自定义地址，也不能反复触发。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
    },
  };
});

import { Platform } from 'react-native';
import {
  DEFAULT_SERVER_PROFILE_ID,
  DEFAULT_SERVER_URL,
  SERVER_PROFILES,
  getOnlineServerProfile,
  getOnlineServerUrl,
  getOnlineWsUrl,
  getServerProfile,
  matchServerProfile,
  migrateLegacyServerUrl,
  normalizeServerUrl,
  resetOnlineServerUrl,
  setOnlineServerProfile,
  setOnlineServerUrl,
  latencyTier,
  LATENCY_FAIR_MS,
  LATENCY_SLOW_MS,
  type LatencyTier,
} from '@/utils/serverConfig';

const SAKURA = getServerProfile('sakura')!;
const CF = getServerProfile('cloudflare')!;

/** 模拟用户手动填过的第三方地址（既不是预置线路，也不是环境变量地址） */
const CUSTOM = 'https://my-own-server.example.com:9091';

describe('serverConfig 预置线路', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    // 模块级 30s 内存缓存跨用例残留，用一次写操作把它冲掉
    await setOnlineServerProfile(DEFAULT_SERVER_PROFILE_ID);
  });

  it('提供两条预置线路，且默认是樱花穿透节点', () => {
    expect(SERVER_PROFILES.map(p => p.id)).toEqual(['sakura', 'cloudflare']);
    expect(DEFAULT_SERVER_PROFILE_ID).toBe('sakura');
    // Web 端默认走 Metro 代理（空串），原生端默认樱花穿透节点
    if (Platform.OS === 'web') {
      expect(DEFAULT_SERVER_URL).toBe('');
    } else {
      expect(DEFAULT_SERVER_URL).toBe(SAKURA.url);
      expect(DEFAULT_SERVER_URL).not.toBe(CF.url);
    }
  });

  it('两条线路的延迟标注体现数量级差异', () => {
    // 界面用它显示"延迟约 xxxms"，若数值顺序反了会给玩家误导性的推荐
    expect(SAKURA.latencyMs).toBeLessThan(CF.latencyMs);
  });

  it('按 id 取线路：未知 id 返回 null', () => {
    expect(getServerProfile('sakura')?.url).toBe(SAKURA.url);
    expect(getServerProfile('nope')).toBeNull();
  });

  it('matchServerProfile 归一化尾部斜杠与大小写', () => {
    expect(matchServerProfile(SAKURA.url)?.id).toBe('sakura');
    expect(matchServerProfile(`${SAKURA.url}/`)?.id).toBe('sakura');
    expect(matchServerProfile(SAKURA.url.toUpperCase())?.id).toBe('sakura');
    expect(matchServerProfile(CUSTOM)).toBeNull();
    expect(matchServerProfile('')).toBeNull();
  });

  it('切换线路后，地址与线路解析一致，且立即落盘', async () => {
    await setOnlineServerProfile('cloudflare');
    expect(await getOnlineServerUrl()).toBe(CF.url);
    expect((await getOnlineServerProfile())?.id).toBe('cloudflare');
    expect(await AsyncStorage.getItem('online_server_url')).toBe(CF.url);

    await setOnlineServerProfile('sakura');
    expect(await getOnlineServerUrl()).toBe(SAKURA.url);
    expect((await getOnlineServerProfile())?.id).toBe('sakura');
  });

  it('切换到未知线路 id 时回退到默认线路，不抛错', async () => {
    await setOnlineServerProfile('sakura');
    const chosen = await setOnlineServerProfile('does-not-exist');
    expect(chosen.id).toBe('sakura');
    expect(await getOnlineServerUrl()).toBe(SAKURA.url);
  });

  it('自定义地址会解除与预置线路的关联', async () => {
    await setOnlineServerUrl(CUSTOM);
    expect(await getOnlineServerUrl()).toBe(CUSTOM);
    expect(await getOnlineServerProfile()).toBeNull();
    // 再切回预置线路即可恢复关联
    await setOnlineServerProfile('sakura');
    expect((await getOnlineServerProfile())?.id).toBe('sakura');
  });

  it('WS 地址随线路切换而切换，且协议映射正确', async () => {
    await setOnlineServerProfile('sakura');
    expect(await getOnlineWsUrl()).toBe(`wss://${SAKURA.url.replace(/^https:\/\//i, '')}/api/v1/lan/ws`);
    await setOnlineServerProfile('cloudflare');
    expect(await getOnlineWsUrl()).toBe(`wss://${CF.url.replace(/^https:\/\//i, '')}/api/v1/lan/ws`);
  });

  it('normalizeServerUrl 对两条线路都是幂等的（不会重复补协议）', () => {
    for (const p of SERVER_PROFILES) {
      expect(normalizeServerUrl(p.url)).toBe(p.url);
    }
  });

  it('恢复默认回到樱花穿透节点', async () => {
    await setOnlineServerUrl(CUSTOM);
    await resetOnlineServerUrl();
    if (Platform.OS !== 'web') {
      expect(await getOnlineServerUrl()).toBe(SAKURA.url);
      expect((await getOnlineServerProfile())?.id).toBe('sakura');
    }
  });
});

describe('serverConfig 旧版本迁移', () => {
  const OLD_DEFAULT = 'https://chess.ttocnserver.dpdns.org'; // 旧版本硬编码的默认地址

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('存量用户（只有旧默认地址、无选择标记）被迁移到樱花穿透', async () => {
    await AsyncStorage.setItem('online_server_url', OLD_DEFAULT);
    await migrateLegacyServerUrl();
    if (Platform.OS !== 'web') {
      expect(await AsyncStorage.getItem('online_server_url')).toBe(SAKURA.url);
    }
  });

  it('用户填过的自定义地址不被覆盖', async () => {
    await AsyncStorage.setItem('online_server_url', CUSTOM);
    await migrateLegacyServerUrl();
    expect(await AsyncStorage.getItem('online_server_url')).toBe(CUSTOM);
  });

  it('已明确选过线路的用户不被覆盖（尊重显式选择）', async () => {
    await AsyncStorage.setItem('online_server_url', CF.url);
    await AsyncStorage.setItem('online_server_pick_v1', 'cloudflare');
    await migrateLegacyServerUrl();
    expect(await AsyncStorage.getItem('online_server_url')).toBe(CF.url);
  });

  it('已是新默认地址的用户不被重复改写', async () => {
    await AsyncStorage.setItem('online_server_url', SAKURA.url);
    await migrateLegacyServerUrl();
    expect(await AsyncStorage.getItem('online_server_url')).toBe(SAKURA.url);
  });

  it('无历史数据的新用户不写入任何东西（保持零副作用）', async () => {
    await migrateLegacyServerUrl();
    expect(await AsyncStorage.getItem('online_server_url')).toBeNull();
    expect(await AsyncStorage.getItem('online_server_pick_v1')).toBeNull();
  });

  it('迁移失败不抛出（AsyncStorage 异常时静默降级）', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage down'));
    await expect(migrateLegacyServerUrl()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

/**
 * 延迟档位决定卡片右侧数字的绿/黄/红。阈值一旦调错，玩家会被误导去选慢线路，
 * 因此把边界值全部钉住（尤其是 200 与 400 这两个分界本身）。
 */
describe('serverConfig 延迟档位', () => {
  it('≤200ms 为 fast（绿）：落子反馈基本无感', () => {
    const cases: number[] = [1, 82, 100, 199, LATENCY_FAIR_MS];
    cases.forEach(ms => expect(latencyTier(ms)).toBe<LatencyTier>('fast'));
  });

  it('200~400ms 为 fair（黄）：能明显感到"点了要等"', () => {
    const cases: number[] = [201, 300, 399, LATENCY_SLOW_MS];
    cases.forEach(ms => expect(latencyTier(ms)).toBe<LatencyTier>('fair'));
  });

  it('>400ms 为 slow（红）：Cloudflare Tunnel 实测区间必须落在这一档', () => {
    const cases: number[] = [401, 500, 735, 1115, 1700];
    cases.forEach(ms => expect(latencyTier(ms)).toBe<LatencyTier>('slow'));
  });

  it('两条预置线路的参考值分别落在 fast / slow，颜色上可区分', () => {
    // 参考值只是未探测时的兜底显示，但若两个值同档，卡片右侧会显示同一种颜色，
    // 界面上就失去了"哪条更快"的直观对比。
    expect(latencyTier(SAKURA.latencyMs)).toBe('fast');
    expect(latencyTier(CF.latencyMs)).toBe('slow');
  });

  it('null / undefined / NaN / Infinity 一律 slow（界面绝不出现 NaNms）', () => {
    expect(latencyTier(null)).toBe('slow');
    expect(latencyTier(undefined)).toBe('slow');
    expect(latencyTier(NaN)).toBe('slow');
    expect(latencyTier(Infinity)).toBe('slow');
  });
});
