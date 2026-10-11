/**
 * jieqiDeterminization —— 暗子池的「确定性化」簿记
 *
 * ============================================================================
 * 【为什么需要它】
 *
 * 引擎的 FEN 第 3 段要求一个**精确的暗子多重集**（`Σ池 == 在盘暗子数`），
 * 而本仓库对暗子的认知是**一个分布**：
 *   · 已翻开的暗子 → 真值即公开信息（`revealedType`），不需要猜；
 *   · **被吃的暗子** → 双方都不知道（铁律 A），但它确实离开了池；
 *   · 仍在盘的暗子 → 未知，引擎自己会按池推理。
 *
 * 因此唯一「需要决定」的是**被吃暗子声明为什么**。这层簿记做两件事：
 *   1. 从后验采样出被吃暗子的身份，并从池中扣除，保持池与盘面严格自洽；
 *   2. 保证**可重放**——同一 seed + 同一公开着法序列 ⇒ 同一份池演化。
 *
 * ============================================================================
 * 【铁律 A 延伸】
 *
 * 本簿记是**声明**，不是**真相**。它永不写入 `GameState`、永不进任何出站 payload。
 * 真实身份仍只存在于 `JieqiIdentity`（客户端 ref / 服务端 jieqiSecret）。
 */

import type { GameState, SideTag } from './types';
import { RED_SIDE, BLACK_SIDE } from './types';
import { liveHiddenSlots, sideOfId } from './jieqi';
import {
  emptyDarkPool,
  initialJieqiPool,
  poolTotal,
  isPoolValid,
  type JieqiDarkPool,
} from './jieqiFen';

/** 簿记本体 */
export interface JieqiDeterminization {
  /** 引擎视角的当前未揭池（精确多重集） */
  pool: JieqiDarkPool;
  /** 已声明「被吃掉」的各棋种枚数（从池中扣减，不回填） */
  capturedDeclared: JieqiDarkPool;
  /** 独立随机种子，保证同 seed + 同着法序列可重放 */
  seed: number;
}

/** 新开一局的簿记 */
export function createDeterminization(seed: number): JieqiDeterminization {
  return {
    pool: initialJieqiPool(),
    capturedDeclared: emptyDarkPool(),
    seed,
  };
}

/** 深拷贝（悔棋/续局需要独立副本） */
export function cloneDeterminization(d: JieqiDeterminization): JieqiDeterminization {
  return {
    pool: { red: { ...d.pool.red }, black: { ...d.pool.black } },
    capturedDeclared: {
      red: { ...d.capturedDeclared.red },
      black: { ...d.capturedDeclared.black },
    },
    seed: d.seed,
  };
}

/**
 * xorshift32：确定性随机源。
 *
 * 必须确定性——续局/悔棋重放要得到同一份池，故不能用 Math.random。
 */
export function makeDeterministicRand(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function poolOf(d: JieqiDeterminization, side: SideTag) {
  return side === RED_SIDE ? d.pool.red : d.pool.black;
}
function capturedOf(d: JieqiDeterminization, side: SideTag) {
  return side === RED_SIDE ? d.capturedDeclared.red : d.capturedDeclared.black;
}

/**
 * 引擎要求的棋种字符（红大写 / 黑小写）。
 * 与 jieqiFen 的约定一致。
 */
const TYPE_CHAR: Record<string, [string, string]> = {
  che: ['R', 'r'], ma: ['N', 'n'], pao: ['C', 'c'],
  shi: ['A', 'a'], xiang: ['B', 'b'], bing: ['P', ''], zu: ['', 'p'],
};

/**
 * 【采样源：真正「还有哪些身份没被公开」的余量】
 *
 * 被吃暗子的身份只能从「尚未公开的身份余量」里抽，该余量 =
 *   初始多重集 − **已翻开真值**（revealedType，公开信息）− 已声明被吃
 *
 * ⚠️【2026-10 实测 BUG：回合数增多后回退「揭棋引擎启动中」】
 * 早期实现直接拿 `d.pool` 当采样源，而 `d.pool` 的语义是
 * 「初始 − 已声明被吃」——它**只扣声明、从不扣已翻开真值**。
 * 于是会出现这种采样：
 *   某方 2 枚「炮」全都已翻开（池里 C 实际已归零），采样却仍选中 C
 *   ⇒ 后续 `computePoolFromState` 扣「已翻开真值」时 C 已经是 0，
 *     再扣这枚凭空声明的 C 被 `Math.max(0, …)` 静默吞掉
 *   ⇒ 池总数比在盘暗子**多 1** ⇒ `assertPoolMatchesBoard` 抛错
 *   ⇒ 引擎被 catch 静默跳过、回落 TS AI ⇒ 角标显示「揭棋引擎启动中」。
 *
 * 用「余量」采样后恒有 `declared[t] ≤ initial[t] − revealed[t]`，
 * 每种棋种都不可能被凭空多声明 ⇒ 池与盘面严格自洽（不再依赖 max(0) 兜底）。
 *
 * ⚠️ 传入的 `state` 必须是**最终局面**（而不是重放到该步的中间态）：
 * 「被吃暗子」的身份约束是对**终局**成立的——
 * 只看当时的中间态就会在"此刻还没翻开、后来被翻开"的棋种上超发，
 * 最终的池按真值扣完已归零，再扣这枚声明同样被 max(0) 吞掉（同一个 BUG）。
 *
 * 这里读的都是**公开信息**（revealedType），不触碰 JieqiIdentity（铁律 A）。
 */
function residualPoolOf(
  state: GameState,
  d: JieqiDeterminization,
  side: SideTag
): Record<string, number> {
  const init = side === RED_SIDE ? initialJieqiPool().red : initialJieqiPool().black;
  const out: Record<string, number> = {};
  for (const k of Object.keys(init)) out[k] = init[k] ?? 0;

  // 1. 扣已翻开真值（含"翻开后又被吃"的：身份已公开，不可能再是被吃暗子）
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue; // 将帅恒明
    if (sideOfId(id) !== side) continue;
    const rv = state.revealedType?.[id];
    if (!rv) continue;
    const key = typeToPoolKey(rv, side);
    if (key && out[key] !== undefined) out[key] = Math.max(0, out[key] - 1);
  }

  // 2. 扣已经声明过的（同一枚不能被声明两次）
  const dec = capturedOf(d, side);
  for (const k of Object.keys(out)) out[k] = Math.max(0, out[k] - (dec[k] ?? 0));

  return out;
}

/**
 * 声明一枚**被吃暗子**的真实身份，并从池中扣除。
 *
 * 概率严格按「尚未公开的身份余量」分布（引擎视角的可得信息），
 * **不读取 JieqiIdentity**（那会构成看牌作弊，且违反 AI 不看牌的产品定稿）。
 *
 * @param state **最终局面**（提供"最终已翻开"的公开信息）。**强烈建议传**：
 *              不传时退化为按 `d.pool`（初始 − 已声明）采样，会漏扣已翻开真值，
 *              可能声明出已被翻开的棋种 ⇒ 池与盘面不自洽（见 residualPoolOf 注释）。
 * @returns 被吃暗子的棋种（che/ma/…），供调用方拼进着法后缀
 */
export function declareCapturedIdentity(
  d: JieqiDeterminization,
  victimSide: SideTag,
  rand: () => number,
  state?: GameState
): string | null {
  const source = state ? residualPoolOf(state, d, victimSide) : poolOf(d, victimSide);
  const entries = Object.entries(source).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return null; // 余量已空：不应发生，返回 null 让调用方报错

  const total = entries.reduce((s, [, n]) => s + (n ?? 0), 0);
  let r = rand() % total;
  let picked: string | null = null;
  for (const [ch, n] of entries) {
    r -= n ?? 0;
    if (r < 0) {
      picked = ch;
      break;
    }
  }
  if (!picked) return null;

  // 簿记：池 −1、capturedDeclared +1
  //（picked 必在 residual ⊆ d.pool 内，故这里不会减成负数）
  const pool = poolOf(d, victimSide);
  pool[picked] = Math.max(0, (pool[picked] ?? 0) - 1);
  const cap = capturedOf(d, victimSide);
  cap[picked] = (cap[picked] ?? 0) + 1;
  return charToType(picked);
}

function charToType(ch: string): string {
  const map: Record<string, string> = {
    R: 'che', N: 'ma', C: 'pao', A: 'shi', B: 'xiang', P: 'bing',
    r: 'che', n: 'ma', c: 'pao', a: 'shi', b: 'xiang', p: 'zu',
  };
  return map[ch] ?? 'che';
}

/** 棋种 → 该方对应的池键（大写=红 / 小写=黑） */
export function typeToPoolKey(type: string, side: SideTag): string | null {
  const pair = TYPE_CHAR[type];
  if (!pair) return null;
  const isRed = side === RED_SIDE;
  const ch = isRed ? pair[0] : pair[1];
  return ch || null;
}

/** 每方的初始暗子枚数（除将帅外 15 枚） */
export const HIDDEN_PER_SIDE = 15;

/**
 * 某一方**被吃掉的暗子枚数**（身份不可知，但数量可精确算出）。
 *
 * 恒等式：15 = 已翻开 + 仍在盘暗子 + 被吃暗子
 *   · 已翻开   → `revealedType` 有值（公开信息，含"翻开后又被吃"的子）
 *   · 仍在盘   → `liveHiddenSlots`
 *   · 被吃暗子 → 本函数求出的余量
 *
 * ⚠️ 「已翻开」必须**含已死的**（翻开后被吃掉的子）：它虽不在盘上，
 * 但身份已公开、已离开池，若漏计会让池偏大。
 */
export function capturedHiddenCount(state: GameState, side: SideTag): number {
  let revealed = 0;
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue; // 将帅恒明
    if (sideOfId(id) !== side) continue;
    if (state.revealedType?.[id]) revealed++;
  }
  const live = liveHiddenSlots(state, side).length;
  return Math.max(0, HIDDEN_PER_SIDE - revealed - live);
}

/** 某方已声明的被吃总数 */
export function declaredCapturedTotal(d: JieqiDeterminization, side: SideTag): number {
  const m = capturedOf(d, side);
  return Object.values(m).reduce((a, b) => a + (b ?? 0), 0);
}

/**
 * 按**数量差**补齐被吃暗子的声明。
 *
 * 为什么需要：历史重放（`buildJieqiHistoryMoves`）会为每枚被吃暗子声明一次，
 * 但若历史重放中止/不完整，声明数会少于真实被吃数，池就会偏大 ⇒ 断言失败。
 * 这里把差额补上，保证 `ΣcapturedDeclared == capturedHiddenCount`，
 * 从而 `Σpool == 在盘暗子数` 恒成立。
 *
 * 声明顺序对引擎无影响（池是多重集），故补齐是安全的。
 */
export function topUpCapturedDeclarations(
  d: JieqiDeterminization,
  state: GameState,
  rand: () => number
): void {
  for (const side of [RED_SIDE, BLACK_SIDE]) {
    const need = capturedHiddenCount(state, side);
    let have = declaredCapturedTotal(d, side);
    while (have < need) {
      // 透传 state：让采样源扣掉已翻开真值，避免声明出已被翻开的棋种
      const t = declareCapturedIdentity(d, side, rand, state);
      if (!t) break; // 余量已空（不应发生）
      have++;
    }
  }
}

/**
 * 依据**当前局面**重算引擎视角的暗子池。
 *
 * ============================================================================
 * 【为什么必须重算，而不是维护一个静态池】
 *
 * 池的语义是「**当前**仍未揭晓的暗子身份多重集」，它随对局演化：
 *   · 暗子被**走子翻开** → 身份公开（`revealedType`）⇒ 该棋种离开池；
 *   · 暗子被**吃掉**       → 身份不可知，但确实离开池 ⇒ 用声明值扣除。
 *
 * 早期实现只在开局建一次池、之后从不更新，导致：
 *   开局 池=30、在盘暗子=30 ✅（首步恰好成功）
 *   走一步后 池=30、在盘暗子=29 ❌ ⇒ assertPoolMatchesBoard 抛错
 *                                ⇒ 引擎被跳过、静默回落 TS AI
 *   （这正是用户实测「一直显示揭棋引擎启动中」的根因。）
 *
 * 本函数从初始池出发，逐项扣除，得到与盘面严格自洽的池。
 * 它**不读** `JieqiIdentity`（暗子真相）——已翻开的身份来自
 * `revealedType`（公开信息），被吃的来自 `capturedDeclared`（声明）。
 */
export function computePoolFromState(
  state: GameState,
  capturedDeclared?: JieqiDarkPool
): JieqiDarkPool {
  const pool = initialJieqiPool();

  const dec = (side: SideTag, type: string, n = 1): void => {
    const key = typeToPoolKey(type, side);
    if (!key) return;
    const target = side === RED_SIDE ? pool.red : pool.black;
    target[key] = Math.max(0, (target[key] ?? 0) - n);
  };

  // 1. 扣掉**已翻开**的暗子：身份是公开真值（revealedType）
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue; // 将帅恒明
    const rv = state.revealedType?.[id];
    if (!rv) continue;
    dec(sideOfId(id), rv, 1);
  }

  // 2. 扣掉**已声明被吃**的暗子（身份不可知，用声明值）
  if (capturedDeclared) {
    for (const [key, n] of Object.entries(capturedDeclared.red)) {
      if ((n ?? 0) > 0) {
        pool.red[key] = Math.max(0, (pool.red[key] ?? 0) - (n ?? 0));
      }
    }
    for (const [key, n] of Object.entries(capturedDeclared.black)) {
      if ((n ?? 0) > 0) {
        pool.black[key] = Math.max(0, (pool.black[key] ?? 0) - (n ?? 0));
      }
    }
  }

  return pool;
}

/**
 * 把簿记**推进**到与 state 同步的状态。
 *
 * 做法：以 state 的在盘暗子为准，逐项核对；若池与盘面不一致（说明此前漏记了
 * 被吃暗子），则调用方应重放整局——本函数只在**每步正常推进**时被调用。
 *
 * 更实用的接口是 `reconcile`：给定当前局面，从初始池重放到当前 moveHistory，
 * 保证「续局/读档后池依然正确」。这是最稳的做法，代价是 O(走子数)。
 */
export function reconcilePool(state: GameState): JieqiDarkPool {
  // 从初始池开始，按当前盘面反推：
  // 池 = 初始多重集 − 已翻开真值 − 已被吃暗子
  // 但「已被吃暗子身份」不可知，故这里用「在盘暗子数」来补齐：
  // 先扣掉所有已翻开的真实身份，剩余即为「仍在盘 + 已被吃」的混合。
  // 引擎要求精确值，而我们选择：**已翻开的用真值，被吃的用均分假设**。
  const pool = initialJieqiPool();

  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue;
    const rv = state.revealedType?.[id];
    if (!rv) continue;
    const side = sideOfId(id);
    const key = typeToPoolKey(rv, side);
    if (!key) continue;
    const target = side === RED_SIDE ? pool.red : pool.black;
    if ((target[key] ?? 0) > 0) target[key] = (target[key] ?? 0) - 1;
  }

  // 剩余数量应当等于在盘暗子 + 被吃暗子。
  // 引擎池必须等于「在盘暗子」，所以要把被吃的部分扣掉 —— 但身份不可知。
  // 解法：被吃暗子的数量 = 初始 - 已翻开 - 在盘暗子。
  // 这正好是「按数量守恒」推出的：把剩余按数量均摊扣减是不精确的，
  // 正确做法是调用 declareCapturedIdentity 逐次记录（见上）。
  // 因此 reconcile 只保证「扣掉已翻开」，剩余交给调用方的逐手簿记。
  return pool;
}

/** 池不变量检查：Σ池 == 在盘暗子数 */
export function checkPoolInvariant(
  d: JieqiDeterminization,
  liveHidden: number
): { ok: boolean; poolTotal: number; liveHidden: number } {
  const t = poolTotal(d.pool);
  return { ok: t === liveHidden, poolTotal: t, liveHidden };
}

/** 在盘暗子总数（按 state 计算） */
export function countLiveHidden(state: GameState): number {
  return liveHiddenSlots(state, RED_SIDE).length + liveHiddenSlots(state, BLACK_SIDE).length;
}

/** 序列化为可落盘结构 */
export function serializeDeterminization(d: JieqiDeterminization) {
  return {
    pool: { red: { ...d.pool.red }, black: { ...d.pool.black } },
    capturedDeclared: {
      red: { ...d.capturedDeclared.red },
      black: { ...d.capturedDeclared.black },
    },
    seed: d.seed,
  };
}

/** 从落盘结构还原（容错：缺失时回退为全新簿记） */
export function deserializeDeterminization(
  raw: unknown
): JieqiDeterminization | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!o.pool || !o.capturedDeclared) return null;
  const seed = typeof o.seed === 'number' ? o.seed : 0;
  const pool = (o.pool as JieqiDarkPool) ?? initialJieqiPool();
  if (!isPoolValid(pool)) return null;
  return {
    pool: { red: { ...pool.red }, black: { ...pool.black } },
    capturedDeclared: (o.capturedDeclared as JieqiDarkPool) ?? emptyDarkPool(),
    seed,
  };
}

/** 剩余未揭池的棋种字符列表（供 UI/调试展示，不含任何身份信息） */
export function poolSummary(d: JieqiDeterminization): string {
  const f = (m: Record<string, number>) =>
    Object.entries(m)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([ch, n]) => `${ch}${n}`)
      .join('');
  return f(d.pool.red) + f(d.pool.black);
}
