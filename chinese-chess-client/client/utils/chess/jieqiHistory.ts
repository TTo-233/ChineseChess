/**
 * jieqiHistory —— 把本仓库的走棋历史转成引擎可重放的揭棋着法序列
 *
 * ============================================================================
 * 【为什么必须单独做】
 *
 * 引擎的 `position fen <FEN> moves <...>` 要求每步带上**揭晓后缀**
 * （4 字符 = 无揭晓；5 字符 = 自身揭晓；6 字符 = 自身 + 被吃揭晓），
 * 否则引擎无法正确重建暗子池，会在**错误的局面**上搜索。
 *
 * ============================================================================
 * 【口径依据（源码级，jieqi_old src/uci.cpp 的 position()）】
 *
 *   · token.size() == 4 / 5 / 6 三个分支；
 *   · 5 字符时，若 `!pos.isDark(from_sq(m))`（走的不是暗子），
 *     源码把该后缀当作**被吃暗子**处理：
 *         pCaptured = pGet; pGet = NO_PIECE;
 *     ⇒「走明子吃暗子」只需 5 字符（第 5 位 = 被吃方）。
 *
 * ============================================================================
 * 【哪些身份不用猜】
 *
 *   · 走子翻开的身份 → **公开真值**，`MoveRecord.revealedType` 已记录
 *     （types.ts 注释明写「该信息对双方都是公开的，不构成信息泄漏」）；
 *   · 被吃暗子的身份 → 双方都不知道（铁律 A），只能由
 *     `JieqiDeterminization` 按后验**声明**，故本模块接受一个声明回调。
 */

import type { GameState, MoveRecord, SideTag } from './types';
import { RED_SIDE } from './types';
import { sideOfId } from './jieqi';
import { typeToChar, buildJieqiMove } from './jieqiUci';
import { makeMove } from './GameEngine';
import type { JieqiPieceType } from './types';

/**
 * 声明被吃暗子身份的注入点（返回棋种如 'che'/'zu'，或 null 表示池已空）
 *
 * ⚠️【2026-10 实测 BUG：回合数增多后回退「揭棋引擎启动中」】
 * 声明**不是**在真空里抽签，它必须满足一个对**终局**成立的硬约束：
 *   「某棋种被声明被吃的枚数」 + 「该棋种最终被翻开的枚数」 ≤ 初始枚数
 * 采样若只看**当时**的局面（只扣掉当时已翻开的），就会在
 * "此刻还没翻开的棋种"上多声明——而那枚棋种可能在**后续**被全部翻开，
 * 于是最终的池按真值扣完已归零，再扣这枚凭空声明就被 `Math.max(0,…)` 吞掉
 * ⇒ 池比在盘暗子**多 1** ⇒ `assertPoolMatchesBoard` 抛错
 * ⇒ 引擎被 catch 静默跳过、回落 TS AI ⇒ 角标显示「揭棋引擎启动中」。
 *
 * 故 `finalState` 形参是**终局局面**（重放的目标局面），采样源按它扣减：
 *   余量 = 初始多重集 − **终局**已翻开真值 − 已声明枚数
 * 这样每种棋种都不可能被超发，池与盘面严格自洽（不再依赖 max(0) 兜底）。
 *
 * @param victimSide 被吃子所属方
 * @param finalState **终局局面**（提供"最终已翻开"的公开信息）
 */
export type DeclareCapturedFn = (
  victimSide: SideTag,
  finalState: GameState
) => string | null;

export interface JieqiHistoryResult {
  /** 引擎可重放的着法序列（4/5/6 字符） */
  moves: string[];
  /**
   * 因无法确定「被吃子身份」而中止的下标；-1 表示全部成功。
   * 中止时 moves 只含该下标之前的部分（调用方应退化为只发 FEN）。
   */
  abortedAt: number;
}

/** 内部坐标 → UCI（列 a..i，行 9-row） */
function uciOf(col: number, row: number): string {
  return String.fromCharCode(97 + col) + String(9 - row);
}

/**
 * 从走棋历史合成一份「公开身份表」，供重放时驱动 makeMove 的翻牌逻辑。
 *
 * 这不是暗子真相（铁律 A）：它只包含**已经公开**的翻牌结果
 * ——即每步 `MoveRecord.revealedType`。makeMove 只用它把
 * `hiddenMask[id]` 清位、`revealedType[id]` 写入，从而让重放出的中间态
 * 与真实对局一致（否则暗子会一直是暗子，后续「落点是否暗子」的判断全错）。
 */
function synthesizePublicIdentity(state: GameState): {
  hiddenType: (JieqiPieceType | null)[];
  seed: number;
} {
  const hiddenType = new Array<JieqiPieceType | null>(32).fill(null);
  for (const rec of state.moveHistory) {
    if (rec.revealedType) hiddenType[rec.pieceId] = rec.revealedType;
  }
  return { hiddenType, seed: 0 };
}

/**
 * 构建引擎可重放的揭棋着法序列。
 *
 * 实现：从 `initialState` 起逐步重放（用真实 `makeMove` 维护中间态），
 * 每步依据**当时的真实局面**判断：
 *   · 走的子是否为暗子 → 需要「自身揭晓」后缀（用公开真值）；
 *   · 落点上是否为暗子 → 需要「被吃揭晓」后缀（用声明回调）。
 *
 * @param state           当前局面（含完整 moveHistory）
 * @param initialState    重放起点（本局的初始局面）
 * @param declareCaptured 被吃暗子身份的声明回调
 */
export function buildJieqiHistoryMoves(
  state: GameState,
  initialState: GameState,
  declareCaptured: DeclareCapturedFn
): JieqiHistoryResult {
  const moves: string[] = [];
  const identity = synthesizePublicIdentity(state);
  let cur = initialState;

  for (let i = 0; i < state.moveHistory.length; i++) {
    const rec = state.moveHistory[i];

    // 走子**前**该落点上的子：是否存在、是否暗子
    const targetId = cur.qiPan[rec.toCol]?.[rec.toRow] ?? -1;
    const capturedWasHidden = targetId >= 0 && cur.hiddenMask?.[targetId] === true;
    const moverWasHidden = cur.hiddenMask?.[rec.pieceId] === true;

    const base = `${uciOf(rec.fromCol, rec.fromRow)}${uciOf(rec.toCol, rec.toRow)}`;
    const moverIsRed = sideOfId(rec.pieceId) === RED_SIDE;

    let movedChar: string | null = null;
    let capturedChar: string | null = null;

    if (moverWasHidden) {
      // 自身揭晓：用 MoveRecord 的公开真值，不需要猜
      const t = rec.revealedType;
      if (!t) return { moves, abortedAt: i }; // 走了暗子却没记翻牌结果 = 历史不完整
      movedChar = typeToChar(t, moverIsRed);
      if (!movedChar) return { moves, abortedAt: i };
    }

    if (capturedWasHidden) {
      const victimSide = sideOfId(targetId);
      // 传**终局局面**：声明必须满足「对终局成立」的硬约束，
      // 否则会在"当时未翻开、后来被翻开"的棋种上超发（见 DeclareCapturedFn 注释）
      const declaredType = declareCaptured(victimSide, state);
      if (!declaredType) return { moves, abortedAt: i };
      capturedChar = typeToChar(declaredType, victimSide === RED_SIDE);
      if (!capturedChar) return { moves, abortedAt: i };
    }

    try {
      moves.push(buildJieqiMove(base, movedChar, capturedChar));
    } catch {
      return { moves, abortedAt: i };
    }

    // 推进中间态：传合成身份表，让翻牌语义与真实对局一致
    const next = makeMove(cur, rec.pieceId, rec.toCol, rec.toRow, identity);
    cur = next.newState;
  }

  return { moves, abortedAt: -1 };
}

/**
 * 把整局历史转成「起始 FEN + moves」的引擎请求载荷。
 *
 * 引擎侧约定：给了 moves 就**完全忽略** fen（见 pikafishUci.ts 的同源警告），
 * 因此这里返回的 fen 必须是**起始局面**，不能是当前局面。
 */
export interface JieqiReplayPayload {
  startFen: string;
  moves: string[];
}

export type BuildFenFn = (s: GameState) => string;
