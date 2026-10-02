/**
 * 人机对战的「AI 走子代数防护」与延时排定。
 *
 * 第 3 批拆分自 `screens/game/index.tsx`（原先内联在页面里，与布局、弹窗、存档混在
 * 一个 78KB / 1673 行的文件中）。抽出来的原因不是「文件太长」，而是**一条安全约束
 * 被埋在页面中央**：任何会重置/改变局面的操作都必须让排队中与计算中的 AI 走子失效，
 * 否则旧局面的着法会覆盖新状态（「重开后 AI 又落一子把局面拉回旧棋」「悔棋被延时中的
 * AI 着法顶掉」）。约束一旦只靠页面作者记得调用，迟早漏一处。
 *
 * 代数（generation）的判定此前只覆盖了 AI 分支：玩家分支 `executeMove` 同样 await
 * 了音效播放却没有校验代数，于是「棋落子后立刻重开」会被音效 await 期间的旧 `newState`
 * 覆盖回去——这正是 CODE_AUDIT.md §8 表 #8 记的「同一语义两处实现、只有一处加固」。
 * 本 Hook 因此把「开始一次异步操作」收成一个入口，**两侧都必须过代数闸**：
 *
 *   const ticket = beginMoveTicket();
 *   ...
 *   await playSound('go');          // 期间界面可能已重开
 *   if (!isTicketLive(ticket)) return;   // 代数已变 → 丢弃本次结果
 *
 * 作废时通过 `onDiscard` 通知调用方复位自己的标记（如 `aiThinking`）；
 * 通过代数闸的操作则由调用方自己落地状态。
 */
import { useCallback, useEffect, useRef } from 'react';

import type { GameState } from '@/utils/chess/GameEngine';
import { abortSearch } from '@/utils/chess/AIEngine';

/** 一次异步操作的代数票据 */
export interface MoveTicket {
  /** 开始时的代号 */
  readonly gen: number;
}

/** 延时排定 AI 走子的默认间隔（毫秒） */
export const AI_MOVE_DEFAULT_DELAY_MS = 500;

export interface UsePendingAIMoveOptions {
  /**
   * 排定到点后真正执行 AI 走子。约定：实现方**不需要**自己管代数——
   * 本 Hook 只保证「已被作废的排定不会触发」。
   */
  runAIMove: (state: GameState) => void;
  /** 代数作废时（被重开/悔棋/翻转/读档打断）的副作用，如复位 aiThinking */
  onDiscard?: () => void;
  /** 卸载时清理，默认不需要额外动作 */
  onUnmount?: () => void;
}

export interface PendingAIMoveApi {
  /** 使所有排队中/计算中的 AI 走子失效（任何重置类操作的前置动作） */
  invalidatePendingAI: () => void;
  /** 延时排定一次 AI 走子，可被 invalidatePendingAI 取消 */
  scheduleAIMove: (state: GameState, delayMs?: number) => void;
  /** 开一张代数票据：异步操作开始前调用 */
  beginMoveTicket: () => MoveTicket;
  /** 票据是否仍然有效（代数未变） */
  isTicketLive: (ticket: MoveTicket) => boolean;
  /** 当前代号，仅用于调试/测试 */
  readGen: () => number;
}

/**
 * 返回代数防护 API。必须在卸载时失效所有排定，避免定时器在页面销毁后回调。
 */
export function usePendingAIMove(options: UsePendingAIMoveOptions): PendingAIMoveApi {
  const { runAIMove, onDiscard, onUnmount } = options;

  const gameGenRef = useRef(0);
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 用 ref 承接回调：调度函数本身保持稳定，调用方不必因内联箭头而重建排定。
  const runRef = useRef(runAIMove);
  runRef.current = runAIMove;
  const discardRef = useRef(onDiscard);
  discardRef.current = onDiscard;

  const invalidatePendingAI = useCallback(() => {
    gameGenRef.current += 1;
    if (aiTimerRef.current) {
      clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }
    // 只靠代数校验不够：旧搜索会继续占着主线程跑到自然结束（最多一整个预算），
    // 与重置后新排定的 AI 思考抢算力——「悔棋/翻转/重开后越打越卡就是这么来的」。
    abortSearch();
    discardRef.current?.();
  }, []);

  const scheduleAIMove = useCallback((state: GameState, delayMs = AI_MOVE_DEFAULT_DELAY_MS) => {
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    const gen = gameGenRef.current;
    aiTimerRef.current = setTimeout(() => {
      aiTimerRef.current = null;
      if (gameGenRef.current !== gen) return; // 局面已被重置，放弃
      runRef.current(state);
    }, delayMs);
  }, []);

  const beginMoveTicket = useCallback((): MoveTicket => ({ gen: gameGenRef.current }), []);
  const isTicketLive = useCallback((ticket: MoveTicket) => gameGenRef.current === ticket.gen, []);
  const readGen = useCallback(() => gameGenRef.current, []);

  useEffect(() => {
    return () => {
      if (aiTimerRef.current) {
        clearTimeout(aiTimerRef.current);
        aiTimerRef.current = null;
      }
      onUnmount?.();
    };
    // 卸载清理只跑一次，故不依赖回调
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { invalidatePendingAI, scheduleAIMove, beginMoveTicket, isTicketLive, readGen };
}