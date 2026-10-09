/**
 * 人机对战「开新局」的重置逻辑。
 *
 * 第 3 批拆分自 `screens/game/index.tsx`。此前同一份 15 行重置序列在页面里存在**三份
 * 手工副本**（确认重开 / 再来一局 / 残局下一关），逐字段比对才敢确认它们一致——这正是
 * CODE_AUDIT.md §8 表所记的失效模式（同一语义多处实现，改一处漏一处）：新增一个重置字段
 * 时漏掉其中一份，表现是新局残留上一局的某个状态（如「重开后步数没归零」）。
 *
 * 本 Hook 把「建局面 + 清 UI 状态 + 重置额度」收成单一实现，三处调用点只声明各自的差异
 * （是否弹确认框、是否换棋盘 key、是否自动开局），差异通过显式选项表达，不再靠复制整段。
 */
import { useCallback } from 'react';

import {
  createInitialState,
  createFromFen,
  type GameState,
} from '@/utils/chess/GameEngine';
import {
  createJieqiInitialState,
  type JieqiIdentity,
} from '@/utils/chess/jieqi';
import {
  clearHistoryHash,
  computeZobristHash,
  recordHistoryHash,
} from '@/utils/chess/AIEngine';
import {
  notifyOfflineNewGame,
  precomputeOfflineHint,
} from '@/utils/chess/offlineAiAdapter';

/** 残局闯关每局限用次数：提示 3 次、悔棋 10 次（评级只看提示，悔棋不计入） */
export const ENDGAME_HINT_LIMIT = 3;
export const ENDGAME_UNDO_LIMIT = 10;

/**
 * 从 FEN 建局面（补齐 Zobrist 哈希并重建重复局面检测历史）。
 *
 * 刻意做成**模块级纯函数**而不是 Hook 的一部分：初始局面的 lazy state 初始化必须能
 * 在任何 Hook 之前调用（`useState(() => …)` 里的第一个副作用），而「同一语义单一实现」
 * 要求两处共用同一段代码，所以不能靠「先建 Hook 再用」的顺序来解耦。
 */
export function buildGameStateFromFen(fen: string): GameState {
  const state = createFromFen(fen.trim());
  state.zobristHash = computeZobristHash(state);
  clearHistoryHash();
  recordHistoryHash(state);
  return state;
}

/** 同上，但带开局走棋方的标准局（同样补齐 Zobrist 与历史）。 */
export function buildInitialGameState(initialSideTag: boolean): GameState {
  const state = createInitialState(initialSideTag);
  state.zobristHash = computeZobristHash(state);
  clearHistoryHash();
  recordHistoryHash(state);
  return state;
}

/**
 * 揭棋开局局面 + **身份表**（与 buildInitialGameState 同构）。
 *
 * ⚠️ 身份表（JieqiIdentity）**不是** GameState 的一部分（铁律 A）：
 * 它只交给调用方存在内存里，`makeMove` 每次翻开暗子时需要它。
 * 故本函数返回 `{ state, identity }` 而不是裸 GameState ——
 * 让「必须一起带着走」这件事在类型上就无法忽略。
 *
 * 开局走棋方：揭棋**红先**（规则 1）。故 `initialSideTag` 只在显式要求黑先时生效，
 * 正常入口传 RED_SIDE。
 */
export function buildJieqiInitialGameState(
  initialSideTag: boolean,
  seed?: number
): { state: GameState; identity: JieqiIdentity } {
  const { state, identity } = createJieqiInitialState(undefined, initialSideTag);
  state.zobristHash = computeZobristHash(state);
  clearHistoryHash();
  recordHistoryHash(state);
  void seed;
  return { state, identity };
}

export interface GameResetHandlers {
  setGameState: (state: GameState) => void;
  setSelectedPieceId: (id: number | null) => void;
  setValidMoves: (moves: boolean[][] | null) => void;
  setLastMove: (move: { fromCol: number; fromRow: number; toCol: number; toRow: number } | null) => void;
  setMoveCount: (updater: number | ((prev: number) => number)) => void;
  setCapturedRed: (updater: number | ((prev: number) => number)) => void;
  setCapturedBlack: (updater: number | ((prev: number) => number)) => void;
  setIsFlipped: (updater: boolean | ((prev: boolean) => boolean)) => void;
  setJueShaVisible: (visible: boolean) => void;
  setGameOverReason: (reason: string | null) => void;
  setEndgameHintLeft: (updater: number | ((prev: number) => number)) => void;
  setEndgameUndoLeft: (updater: number | ((prev: number) => number)) => void;
  setBoardKey?: (updater: number | ((prev: number) => number)) => void;
}

export interface NewGameOptions {
  /** 残局模式下的开局局面；缺省（或非残局）则按 `initialSideTag` 开标准局 */
  endgameFen?: string;
  /**
   * 揭棋：开一局揭棋而非象棋。身份表由本 Hook 生成并通过 `onIdentity` 交给调用方持有
   * （铁律 A：它不能进 GameState，所以必须显式带出去）。
   */
  variant?: 'jieqi';
  /** 揭棋身份表的接收口；象棋路径不调用 */
  onIdentity?: (identity: JieqiIdentity) => void;
  /** 标准局的开局走棋方 SideTag */
  initialSideTag: boolean;
  /** 玩家执黑时棋盘默认翻转 */
  initialFlipped: boolean;
  /** 是否 AI 先手（决定开局后自动触发 AI 还是预计算提示） */
  aiFirst: boolean;
  /** 强制棋盘翻转（残局下一关用 false 覆盖，因为新局固定红先、正向显示） */
  forceFlipped?: boolean;
  /** 递增 ChessBoard 的 key，强制重新挂载（换关需要，旧关的内部测量状态不可复用） */
  remountBoard?: boolean;
  /**
   * 忽略 `aiFirst`，按新局面的 FEN 决定是否让 AI 先走。
   * 残局下一关用：下一关 FEN 带 `b` 段（黑先）时 AI 走第一步。
   */
  aiFirstByFen?: boolean;
}

export interface UseNewGameApi {
  /** 按 FEN 构建局面（含 Zobrist 初始化与历史记录） */
  buildEndgameState: (fen: string) => GameState;
  /** 覆盖全部重置字段后建新局；差异通过 options 表达 */
  startNewGame: (options: NewGameOptions) => GameState;
}

export interface UseNewGameArgs extends GameResetHandlers {
  /** 残局模式：本局结局标记需要在重置时清空 */
  endgameResultRef: { current: 'win' | 'lose' | 'draw' | null };
  /** 复盘自动保存标记：新一局允许再次保存 */
  replaySavedRef: { current: boolean };
  /** 作废排队中/计算中的 AI 走子（由 usePendingAIMove 提供） */
  invalidatePendingAI: () => void;
  /** 排定一次 AI 走子（由 usePendingAIMove 提供） */
  scheduleAIMove: (state: GameState, delayMs?: number) => void;
  /** 清掉当前提示 */
  clearHint: () => void;
}

/**
 * 统一的新局重置。`invalidatePendingAI` 必须在建局面前调用（先作废旧代数，再写新状态），
 * 本 Hook 内部保证这个顺序，调用方无需重复。
 */
export function useNewGame(args: UseNewGameArgs): UseNewGameApi {
  const {
    endgameResultRef,
    replaySavedRef,
    invalidatePendingAI,
    scheduleAIMove,
    clearHint,
    setGameState,
    setSelectedPieceId,
    setValidMoves,
    setLastMove,
    setMoveCount,
    setCapturedRed,
    setCapturedBlack,
    setIsFlipped,
    setJueShaVisible,
    setGameOverReason,
    setEndgameHintLeft,
    setEndgameUndoLeft,
    setBoardKey,
  } = args;

  // endgameResultRef / replaySavedRef 由调用方 useRef 创建，身份跨渲染稳定，
  // 可直接进依赖数组（不需要"渲染期写 ref"的镜像写法，那会触发 react-hooks/refs 规则）。
  const buildEndgameState = useCallback((fen: string): GameState => buildGameStateFromFen(fen), []);

  const startNewGame = useCallback(
    (options: NewGameOptions): GameState => {
      const {
        endgameFen,
        variant,
        onIdentity,
        initialSideTag,
        initialFlipped,
        aiFirst,
        forceFlipped,
        remountBoard,
        aiFirstByFen,
      } = options;

      // 先作废旧局面排定/计算中的 AI 走子，再写新状态：
      // 顺序反了会让旧代数下的回调看到新状态并覆盖它。
      invalidatePendingAI();
      clearHint();

      /**
       * 揭棋重开必须**重新洗牌**：每局暗子身份都不同（规则 1）。
       * 身份表交给调用方持有，本 Hook 不留存 —— 它只负责生成。
       */
      const jieqi = variant === 'jieqi' ? buildJieqiInitialGameState(initialSideTag) : null;
      if (jieqi) onIdentity?.(jieqi.identity);

      const newState = jieqi
        ? jieqi.state
        : endgameFen
          ? buildGameStateFromFen(endgameFen)
          : buildInitialGameState(initialSideTag);

      setGameState(newState);
      setSelectedPieceId(null);
      setValidMoves(null);
      setLastMove(null);
      setMoveCount(0);
      setCapturedRed(0);
      setCapturedBlack(0);
      setIsFlipped(forceFlipped ?? initialFlipped);
      setGameOverReason(null);
      setJueShaVisible(false);
      endgameResultRef.current = null;
      replaySavedRef.current = false; // 新一局允许再次自动保存复盘
      setEndgameHintLeft(ENDGAME_HINT_LIMIT);
      setEndgameUndoLeft(ENDGAME_UNDO_LIMIT);
      if (remountBoard) setBoardKey?.(k => k + 1);

      // 新一局：通知本地引擎清空跨局状态与排队中的预计算
      // （引擎每次搜索都会带 ucinewgame，这里额外清队列，避免旧局面的
      //   pending 请求在新局面上"复活"）
      notifyOfflineNewGame();

      // 开局：AI 先走则排定一次 AI 走子，玩家先走则后台预计算提示
      const fenSaysAiFirst =
        aiFirstByFen && typeof endgameFen === 'string'
          ? endgameFen.trim().split(/\s+/)[1] === 'b'
          : aiFirst;
      if (fenSaysAiFirst) {
        scheduleAIMove(newState);
      } else {
        precomputeOfflineHint(newState);
      }
      return newState;
    },
    [
      buildEndgameState,
      endgameResultRef,
      replaySavedRef,
      clearHint,
      invalidatePendingAI,
      scheduleAIMove,
      setGameState,
      setSelectedPieceId,
      setValidMoves,
      setLastMove,
      setMoveCount,
      setCapturedRed,
      setCapturedBlack,
      setIsFlipped,
      setGameOverReason,
      setJueShaVisible,
      setEndgameHintLeft,
      setEndgameUndoLeft,
      setBoardKey,
    ]
  );

  return { buildEndgameState, startNewGame };
}