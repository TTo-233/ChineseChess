/**
 * jieqiRuntime —— 揭棋对局的**运行时上下文**
 *
 * ============================================================================
 * 【为什么需要它】
 *
 * 揭棋引擎每次搜索都需要三样在 `GameState` 之外的东西：
 *   1. **暗子池**（引擎视角的精确多重集）—— 来自 `JieqiDeterminization`；
 *   2. **带揭晓后缀的历史着法** —— 由 `buildJieqiHistoryMoves` 生成；
 *   3. **本局初始局面** —— 历史重放的起点。
 *
 * 而 `aiDispatcher.getBestMoveOffline(state, difficulty)` 的签名只接收
 * `GameState`（这是既有的公共契约，改动会波及多个调用点）。
 * 因此用一个**模块级注册表**承载这三样东西：页面在开局/续局时注册，
 * 换局或离开时注销。`aiDispatcher` 在揭棋分支里按需取用。
 *
 * ⚠️ 铁律 A：本上下文**不含暗子真身**。`determinization` 是「声明」，
 * 与 `JieqiIdentity`（真相）物理隔离；历史里的揭晓信息本就已公开。
 *
 * ============================================================================
 * 【线程/时序假设】
 *
 * 单机对局里同一时刻只有一个揭棋对局在跑，故用**单槽**注册即可。
 * 若将来出现多局并行（例如后台分析），需要改成按局 id 索引的 Map。
 */

import type { GameState } from './types';
import {
  createDeterminization,
  cloneDeterminization,
  declareCapturedIdentity,
  makeDeterministicRand,
  computePoolFromState,
  topUpCapturedDeclarations,
  type JieqiDeterminization,
} from './jieqiDeterminization';
import { buildJieqiHistoryMoves } from './jieqiHistory';
import { toJieqiFen, assertPoolMatchesBoard, initialJieqiPool } from './jieqiFen';

export interface JieqiRuntime {
  /** 本局初始局面（历史重放起点） */
  initialState: GameState;
  /**
   * 暗子池簿记的**种子来源**（声明，非真相）。
   *
   * ⚠️ 只用它的 `seed`：每次搜索都用该 seed **重建一份全新簿记**
   * （见 buildJieqiSearchPayload 的长注释——复用同一份会因声明累积而出错）。
   * 因此这里不保留可变的 `rand` 游标，避免误用。
   */
  determinization: JieqiDeterminization;
}

let current: JieqiRuntime | null = null;

/**
 * 注册/切换揭棋对局上下文。
 *
 * @param initialState 本局初始局面
 * @param seed         随机种子（续局时应传入存档里的 seed 以保证可重放）
 * @param saved        续局时已有的簿记（可选）
 */
export function setJieqiRuntime(
  initialState: GameState,
  seed: number,
  saved?: JieqiDeterminization | null
): void {
  current = {
    initialState,
    determinization: saved ? cloneDeterminization(saved) : createDeterminization(seed),
  };
}

/** 取当前揭棋上下文（未注册时返回 null，调用方应回落 TS AI） */
export function getJieqiRuntime(): JieqiRuntime | null {
  return current;
}

/** 换局/离开揭棋对局时注销 */
export function clearJieqiRuntime(): void {
  current = null;
}

/** 仅测试用：重置 */
export function __resetJieqiRuntimeForTest(): void {
  current = null;
}

/**
 * 构建一次引擎搜索所需的载荷：起始 FEN + 历史着法。
 *
 * ⚠️ 引擎侧约定：给了 moves 就**完全忽略** fen（见 pikafishUci.ts 的同源警告），
 * 所以 startFen 必须是**起始局面**，不能是当前局面。
 *
 * 若历史无法完整重放（池不足等），退化为「只发当前 FEN、不发历史」——
 * 代价是丢失重复局面感知，但保证这一步总能走（与 offlineAiAdapter 同款策略）。
 */
export interface JieqiSearchPayload {
  fen: string;
  moves: string[];
  /** true 表示历史不可用，已退化为纯 FEN 搜索 */
  degraded: boolean;
}

export function buildJieqiSearchPayload(
  state: GameState,
  ctx: JieqiRuntime
): JieqiSearchPayload {
  /**
   * ⚠️ 每次搜索都必须用**一份全新的簿记**，绝不能复用 `ctx.determinization`。
   *
   * 【为什么（2026-10 实测 bug：多回合后回退「启动中」）】
   * `declareCapturedIdentity` 会**就地修改**簿记（池 -1、capturedDeclared +1）。
   * 早期实现每次搜索都用同一个 `ctx.determinization` 重放整段历史，
   * 于是**同一批「被吃」在每次搜索时被重复声明**：
   *
   *   搜索 1：capturedDeclared=0  → 池 = 30 − revealed
   *   发生吃子后
   *   搜索 2：历史重放又声明一次  → capturedDeclared 累加
   *   搜索 3：再声明一次          → 继续累加 …
   *
   * ⇒ capturedDeclared 随搜索次数线性增长
   * ⇒ `computePoolFromState` 过度扣减 ⇒ 池 < 在盘暗子
   * ⇒ `assertPoolMatchesBoard` 抛错 ⇒ 引擎被跳过、静默回落 TS AI
   * ⇒ 角标回退「揭棋引擎启动中」。
   *
   * 这也解释了「前几回合正常、后续回退」：**只有发生过吃子才会触发**，
   * 且要等到下一次搜索才暴露。
   *
   * 修复：用 `seed` 重建一份全新簿记 + 全新随机源 ⇒ 同样的历史得到**同样的声明**
   * （幂等、可复现），既不累积，也保证同一局面多次构建结果一致。
   */
  const seed = ctx.determinization.seed;
  const freshDet = createDeterminization(seed);
  const rand = makeDeterministicRand(seed);

  const hist = buildJieqiHistoryMoves(state, ctx.initialState, (victimSide, atState) =>
    declareCapturedIdentity(freshDet, victimSide, rand, atState)
  );

  // 若历史重放中止/不完整，按**数量差**补齐声明，
  // 保证 ΣcapturedDeclared == 真实被吃暗子数 ⇒ 池与盘面自洽。
  topUpCapturedDeclarations(freshDet, state, rand);

  const livePool = computePoolFromState(state, freshDet.capturedDeclared);

  // 自洽性检查（修复后应恒成立；不成立说明口径有 bug，宁可回落也不喂错局面）
  assertPoolMatchesBoard(state, livePool);

  if (hist.abortedAt >= 0) {
    // 历史不完整：退化为当前局面的纯 FEN 搜索（池用重算值）
    return {
      fen: toJieqiFen(state, livePool),
      moves: [],
      degraded: true,
    };
  }

  // 完整历史：起点 FEN（初始池）+ 全部着法
  return {
    fen: toJieqiFen(ctx.initialState, initialJieqiPool()),
    moves: hist.moves,
    degraded: false,
  };
}
