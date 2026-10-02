/**
 * @/utils/serverClock（第 3 批 / §8 表 #7）
 *
 * 本模块的全部价值在于「偏移量只在一处加」。所以测试的重点不是算术本身，
 * 而是三种会静默出错的输入：
 *   1. 载荷里没有 / 有伪造的 serverNow（不能把已有偏移清零）；
 *   2. 服务端时间戳缺失（返回兜底值，而不是 NaN 流向界面）；
 *   3. 设备时钟偏快 / 偏慢两个方向都能被抵消（差值只取决于两端时间戳）。
 */

import {
  applyServerNow,
  serverElapsedMs,
  serverNow,
  serverRemainingSec,
  type ServerTimeOffsetRef,
} from '@/utils/serverClock';

/** 固定 Date.now，避免用例依赖真实时钟 */
function withFakeClock(value: number): () => void {
  const original = Date.now;
  Date.now = () => value;
  return () => {
    Date.now = original;
  };
}

describe('serverClock', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = null;
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  const lockClock = (value: number) => {
    restore = withFakeClock(value);
  };

  describe('serverNow', () => {
    it('偏移量为 0 时等于本机时间', () => {
      lockClock(1_000_000);
      expect(serverNow({ current: 0 })).toBe(1_000_000);
    });

    it('叠加偏移量（设备慢于服务端时偏移为正）', () => {
      lockClock(1_000_000);
      expect(serverNow({ current: 45_000 })).toBe(1_045_000);
    });

    it('叠加负偏移（设备快于服务端时）', () => {
      lockClock(1_000_000);
      expect(serverNow({ current: -90_000 })).toBe(910_000);
    });

    it('ref 缺失或 null 时退回本机时间（不抛错）', () => {
      lockClock(1_000_000);
      expect(serverNow(undefined)).toBe(1_000_000);
      expect(serverNow(null)).toBe(1_000_000);
    });
  });

  describe('applyServerNow', () => {
    it('用 serverNow - 本机时间 写入偏移量', () => {
      lockClock(1_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      applyServerNow(ref, 1_060_000);
      expect(ref.current).toBe(60_000);
    });

    it('本机偏快时写入负偏移', () => {
      lockClock(1_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      applyServerNow(ref, 950_000);
      expect(ref.current).toBe(-50_000);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['字符串', '1700000000000'],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['对象', { now: 1 }],
    ])('非法 serverNow（%s）不覆盖已有偏移量', (_label, bad) => {
      lockClock(1_000_000);
      const ref: ServerTimeOffsetRef = { current: 1234 };
      applyServerNow(ref, bad);
      expect(ref.current).toBe(1234);
    });

    it('ref 为 null/undefined 时静默跳过', () => {
      lockClock(1_000_000);
      expect(() => applyServerNow(undefined, 1_060_000)).not.toThrow();
      expect(() => applyServerNow(null, 1_060_000)).not.toThrow();
    });
  });

  describe('serverElapsedMs', () => {
    it('只取决于两个服务端时间戳之差，与设备时钟无关', () => {
      lockClock(5_000_000);
      // 设备快 1 小时 → 服务端坐标系里服务端"现在"是 1_400_000
      const ref: ServerTimeOffsetRef = { current: -3_600_000 };
      expect(serverNow(ref)).toBe(1_400_000);
      expect(serverElapsedMs(ref, 400_000)).toBe(1_000_000);
    });

    it('正偏移（本机慢）同样抵消', () => {
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: 3_600_000 };
      expect(serverNow(ref)).toBe(8_600_000);
      expect(serverElapsedMs(ref, 7_600_000)).toBe(1_000_000);
    });

    it('起点缺失/非法时返回兜底值 0，不产生 NaN', () => {
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      expect(serverElapsedMs(ref, undefined)).toBe(0);
      expect(serverElapsedMs(ref, null)).toBe(0);
      expect(serverElapsedMs(ref, NaN)).toBe(0);
      expect(Number.isNaN(serverElapsedMs(ref, undefined))).toBe(false);
    });

    it('支持自定义兜底值', () => {
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      expect(serverElapsedMs(ref, null, 250)).toBe(250);
    });

    it('偏移量为 0 时退化为本机时间减服务端时间戳', () => {
      lockClock(5_000_000);
      expect(serverElapsedMs({ current: 0 }, 4_000_000)).toBe(1_000_000);
    });
  });

  describe('serverRemainingSec', () => {
    it('总秒数减去已用秒数（向下取整）', () => {
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      // 已用 10.5 秒 → 60 - 10.5 = 49.5 → 49
      expect(serverRemainingSec(ref, 60, 4_989_500)).toBe(49);
    });

    it('倒计时归零后钳到 0（不会出现负数）', () => {
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      expect(serverRemainingSec(ref, 10, 4_980_000)).toBe(0);
    });

    it('本机偏快时不会因为时钟差提前归零', () => {
      // 设备快 1 小时：若拿本机时间当服务端时间去减，倒计时会瞬间归零
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: -3_600_000 };
      // 服务端坐标系：服务端"现在"= 5_000_000 − 3_600_000 = 1_400_000
      // 起点 400_000 → 已用 400s，超时钳到 0（不是被时钟差误判，是真的超时）
      expect(serverRemainingSec(ref, 60, 400_000)).toBe(0);
      // 起点 1_380_000 → 已用 20s → 剩 40s；若无校正则会按本机时间算成 0
      expect(serverRemainingSec(ref, 60, 1_380_000)).toBe(40);
    });

    it('起点缺失时返回满值（刚开始）', () => {
      lockClock(5_000_000);
      const ref: ServerTimeOffsetRef = { current: 0 };
      expect(serverRemainingSec(ref, 60, undefined)).toBe(60);
      expect(serverRemainingSec(ref, 60, null)).toBe(60);
    });

    it('负的 totalSec 被钳到 0', () => {
      lockClock(5_000_000);
      expect(serverRemainingSec({ current: 0 }, -5, 1_000_000)).toBe(0);
    });
  });

  it('四个函数在同一负载下给出一致的视图（跨函数一致性）', () => {
    lockClock(10_000_000);
    const ref: ServerTimeOffsetRef = { current: 0 };
    applyServerNow(ref, 12_000_000); // 服务端比本机快 2 秒
    // 下面两个时间戳都取自服务端坐标系：起点 2 秒前 / 1.5 秒前
    expect(serverNow(ref)).toBe(12_000_000);
    expect(serverElapsedMs(ref, 10_500_000)).toBe(1_500_000);
    expect(serverRemainingSec(ref, 60, 11_998_000)).toBe(58);
  });
});