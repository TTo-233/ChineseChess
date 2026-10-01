import { useEffect, useRef, useState } from 'react';

import { RED_SIDE } from '@/utils/chess/types';

/**
 * 在线对局「局时」时钟的本地插值。
 *
 * 背景：服务端是时钟的唯一权威，但它只在状态推送时给出**快照**（双方余量 + 该快照时刻的锚点
 * `lastMoveTime`）。要让钟面看起来是连续走动的，客户端必须在两次推送之间自行按秒插值，
 * 并且只在「当前走棋方」的钟上扣减。
 *
 * 为什么单独抽成 Hook：这段插值原先内联在 lanBattle（3400+ 行）里，包含一个 1 秒
 * `setInterval` 以及一对「值没变就不 setState」的守卫。抽出来后：
 *  - 定时器只在 `phase === 'playing'` 期间存在，随对局阶段自动起停；
 *  - 扣减算术变成纯函数 `computeClockText`，可脱离 React 直接单测（本仓库此前没有纯函数单测）；
 *  - 页面只需持有 Hook 返回的 `clockSnapRef` 并继续交给 `useBattleStateSync` 写入。
 *
 * 本 Hook **只读**快照、不写入：`clockSnapRef` 的所有权仍在页面/Hook 组合之外
 * （由 `useBattleStateSync` 依据服务端负载更新），本 Hook 仅在 1 秒回调里读它的 `.current`。
 */

/** 服务端局时快照：双方余量（ms）+ 锚点 + 当前走棋方 + 协商暂停锚点 */
export interface ClockSnap {
  red: number;
  black: number;
  /** 该快照对应的着法时刻（服务端时钟域，ms） */
  lastMoveTime: number;
  /** 快照时刻的走棋方标记：true = 红方走 */
  sideTag: boolean;
  /** 悔棋/求和等协商冻结时钟时的暂停锚点（服务端时钟域，ms）；null = 未暂停 */
  clockPausedAt: number | null;
}

/** 钟面展示文本：`null` 表示本房间未启用局时 */
export interface ClockText {
  mine: string | null;
  opp: string | null;
  mineUrgent: boolean;
  oppUrgent: boolean;
}

export interface UseBattleClockOptions {
  /** 对局阶段：只有 `'playing'` 期间才需要走钟 */
  phase: string;
  /** 本方阵营字符串（`'red'` / `'black'`），用于判断哪一侧是「我的钟」 */
  mySide: string;
  /** 服务端时钟偏移：服务端时间戳与本机 `Date.now()` 的差值（ms） */
  serverTimeOffsetRef: { current: number };
  /** 读秒时长（秒），0 = 未启用读秒制 */
  byoyomiRef: { current: number };
}

export interface UseBattleClockApi {
  clockText: ClockText;
  /** 时钟快照容器：请原样交给 `useBattleStateSync` 写入，不要另行创建 */
  clockSnapRef: { current: ClockSnap | null };
}

/** 未启用局时/无快照时的钟面值：用同一引用返回，便于 `setState` 的相等性守卫直接短路 */
const EMPTY_CLOCK_TEXT: ClockText = { mine: null, opp: null, mineUrgent: false, oppUrgent: false };

/** ms → `m:ss`（向上取整到秒；负数按 0 处理，避免钟面出现负值） */
function formatClockMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** 阵营字符串 → 走棋方标记；无法识别时按黑方处理（与服务端/引擎的 `id <= 15` 约定一致） */
function sideStringToTag(side: string): boolean {
  return side === 'red' ? RED_SIDE : !RED_SIDE;
}

/**
 * 由服务端快照推导出两侧钟面文本（纯函数，无副作用、不读时钟）。
 *
 * 规则：
 *  - 走棋方按 `elapsed = anchorNow - lastMoveTime` 实时扣减，非走棋方静态展示快照余量；
 *  - 基本用时耗尽后若启用读秒：走棋方显示「读 + 读秒剩余」，非走棋方显示完整读秒时段；
 *  - 基本用时耗尽且未启用读秒：显示 `0:00`；
 *  - 警示（urgent）：基本用时 ≤ 30s，或读秒阶段走棋方 ≤ 10s。
 */
export function computeClockText(
  snap: ClockSnap,
  correctedNow: number,
  byoyomiMs: number,
  mySide: string
): ClockText {
  // 协商期间以暂停锚点为「现在」，钟面冻结在暂停时刻
  const anchorNow = snap.clockPausedAt ?? correctedNow;
  const elapsed = Math.max(0, anchorNow - snap.lastMoveTime);
  const toMove: 'red' | 'black' = snap.sideTag === RED_SIDE ? 'red' : 'black';
  const myTag = sideStringToTag(mySide);
  const myColor: 'red' | 'black' = myTag === RED_SIDE ? 'red' : 'black';
  const oppColor: 'red' | 'black' = myColor === 'red' ? 'black' : 'red';

  const displayFor = (color: 'red' | 'black'): { text: string; urgent: boolean } => {
    const moving = toMove === color;
    const net = moving ? snap[color] - elapsed : snap[color];
    if (net > 0) {
      return { text: formatClockMs(net), urgent: moving && net <= 30000 };
    }
    if (byoyomiMs > 0) {
      const byoRemain = moving ? byoyomiMs + net : byoyomiMs;
      return { text: `读${formatClockMs(byoRemain)}`, urgent: moving && byoRemain <= 10000 };
    }
    return { text: formatClockMs(0), urgent: moving };
  };

  const mine = displayFor(myColor);
  const opp = displayFor(oppColor);
  return { mine: mine.text, opp: opp.text, mineUrgent: mine.urgent, oppUrgent: opp.urgent };
}

export function useBattleClock(options: UseBattleClockOptions): UseBattleClockApi {
  const { phase, mySide, serverTimeOffsetRef, byoyomiRef } = options;

  const clockSnapRef = useRef<ClockSnap | null>(null);
  const [clockText, setClockText] = useState<ClockText>(EMPTY_CLOCK_TEXT);

  // 只依赖 [phase, mySide]：ref 的 .current 在回调里读取，因此时钟偏移/读秒变化无需重建定时器。
  // mySide 进入依赖是刻意的——选边/重赛会改变阵营，此时必须按新阵营重新解释同一份快照。
  useEffect(() => {
    if (phase !== 'playing') return undefined;

    const tick = () => {
      const snap = clockSnapRef.current;
      if (!snap) {
        setClockText(prev => (prev === EMPTY_CLOCK_TEXT ? prev : EMPTY_CLOCK_TEXT));
        return;
      }
      const correctedNow = Date.now() + serverTimeOffsetRef.current;
      const next = computeClockText(snap, correctedNow, byoyomiRef.current * 1000, mySide);
      // 值没变就复用上一次的对象：1 秒定时器不应无条件触发重渲染
      setClockText(prev =>
        prev.mine === next.mine &&
        prev.opp === next.opp &&
        prev.mineUrgent === next.mineUrgent &&
        prev.oppUrgent === next.oppUrgent
          ? prev
          : next
      );
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase, mySide, serverTimeOffsetRef, byoyomiRef]);

  return { clockText, clockSnapRef };
}
