import { computeClockText, type ClockSnap } from '@/hooks/useBattleClock';
import { BLACK_SIDE, RED_SIDE } from '@/utils/chess/types';

/**
 * useBattleClock 的纯函数部分（computeClockText）回归测试。
 *
 * 抽成 Hook 的主要收益之一就是让这段时钟算术可以脱离 React 直接测：
 * 此前它内联在 lanBattle 的 useEffect 里，只能靠人工冒烟。
 */

/** 构造一份「红方走棋、双方余量均为 5 分钟、锚点为 t=0」的基础快照 */
function snap(partial: Partial<ClockSnap> = {}): ClockSnap {
  return {
    red: 300000,
    black: 300000,
    lastMoveTime: 0,
    sideTag: RED_SIDE,
    clockPausedAt: null,
    ...partial,
  };
}

describe('computeClockText', () => {
  it('只扣减走棋方的钟，非走棋方静态展示快照余量', () => {
    // 红方走棋，已过去 10 秒
    const text = computeClockText(snap(), 10000, 0, 'red');
    expect(text.mine).toBe('4:50');
    expect(text.opp).toBe('5:00');
  });

  it('钟面归属随本方阵营翻转：同一份快照在红/黑视角下 mine 与 opp 互换', () => {
    const asRed = computeClockText(snap(), 10000, 0, 'red');
    const asBlack = computeClockText(snap(), 10000, 0, 'black');
    expect(asRed.mine).toBe(asBlack.opp);
    expect(asRed.opp).toBe(asBlack.mine);
  });

  it('无法识别的阵营字符串按黑方处理（与引擎 id <= 15 的约定一致）', () => {
    const asBlack = computeClockText(snap(), 0, 0, 'black');
    const asJunk = computeClockText(snap(), 0, 0, '');
    expect(asJunk).toEqual(asBlack);
    expect(BLACK_SIDE).toBe(false);
  });

  it('余量向上取整到秒：剩 1ms 仍显示 0:01 而不是 0:00', () => {
    const text = computeClockText(snap({ red: 1 }), 0, 0, 'red');
    expect(text.mine).toBe('0:01');
  });

  it('基本用时 ≤ 30 秒时走棋方告警，非走棋方不告警', () => {
    const text = computeClockText(snap({ red: 30000, black: 30000 }), 0, 0, 'red');
    expect(text.mine).toBe('0:30');
    expect(text.mineUrgent).toBe(true);
    expect(text.oppUrgent).toBe(false);
  });

  it('基本用时耗尽且启用读秒：走棋方显示读秒剩余，非走棋方显示完整读秒时段', () => {
    // 红方走棋，其基本用时仅剩 1 秒 → 本步已进入读秒（读秒 30 秒）；黑方基本用时已耗尽 → 静态展示完整读秒
    const text = computeClockText(snap({ red: 1000, black: 0 }), 7000, 30000, 'red');
    expect(text.mine).toBe('读0:24');
    expect(text.opp).toBe('读0:30');
    expect(text.mineUrgent).toBe(false);
  });

  it('读秒剩余 ≤ 10 秒时走棋方告警', () => {
    // 基本用时耗尽 5 秒 → 读秒剩余 5 秒
    const text = computeClockText(snap({ red: 0 }), 5000, 10000, 'red');
    expect(text.mine).toBe('读0:05');
    expect(text.mineUrgent).toBe(true);
  });

  it('基本用时耗尽且未启用读秒：显示 0:00 并告警', () => {
    const text = computeClockText(snap({ red: 0 }), 1000, 0, 'red');
    expect(text.mine).toBe('0:00');
    expect(text.mineUrgent).toBe(true);
  });

  it('协商暂停（clockPausedAt 非空）时冻结钟面，忽略此后流逝的时间', () => {
    // 快照锚点 0，暂停于 5000；即使"现在"已是 60000 也只扣 5 秒
    const paused = snap({ red: 300000, clockPausedAt: 5000 });
    const atPause = computeClockText(paused, 5000, 0, 'red');
    const muchLater = computeClockText(paused, 60000, 0, 'red');
    expect(atPause.mine).toBe('4:55');
    expect(muchLater).toEqual(atPause);
  });

  it('时钟回拨（now 早于锚点）不产生负扣减，钟面不倒退', () => {
    const text = computeClockText(snap(), -9999, 0, 'red');
    expect(text.mine).toBe('5:00');
  });

  it('黑方走棋时扣减黑方', () => {
    const text = computeClockText(snap({ sideTag: BLACK_SIDE, black: 60000 }), 20000, 0, 'black');
    expect(text.mine).toBe('0:40');
    expect(text.opp).toBe('5:00');
  });
});
