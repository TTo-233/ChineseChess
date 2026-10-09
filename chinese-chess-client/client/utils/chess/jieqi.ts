/**
 * 揭棋（Jieqi）核心：摆子、暗子身份、占位映射
 *
 * ============================================================================
 * 规则依据（腾讯象棋官方 + 棋者象棋，两处独立来源交叉核对，方案 §1.1）
 * ---------------------------------------------------------------------------
 *  1. 红黑各 15 枚暗子随机摆于己方初始位置，将/帅置于原点且始终明子；
 *  2. 暗子**按其所在棋位对应的棋种**走第一步（兵位暗子第一步只能向前一格）；
 *  3. 暗子可以吃子，**走子后自动翻开为明子**；
 *  4. 暗子被吃后，双方都看不到它是什么棋（**吃子方也不获得任何新子**）；
 *  5. 已翻开的士、象不受九宫与河界限制。
 *
 * ============================================================================
 * 核心设计：「占位即退役」制（方案 §3.1）
 * ---------------------------------------------------------------------------
 * 本引擎的 pieces 是**固定 32 格、以 id 为下标**的数组，棋盘 qiPan 上存的也是 id。
 * 所以「占位 id」与「真实 id」共用同一个 32 格命名空间，不能并存。采用的做法：
 *
 *   揭开瞬间：占位 23（实际是兵）的格子 → 退役 pieces[23]（alive=false）
 *             同一格                  → 升起 pieces[27] = {col,row,alive:true}
 *             hiddenMask[27] = false（真实 id 本就不标隐藏）
 *
 * 于是**揭开之后全局再无特殊处理**：该子从此就是个普通的、带真实 id 的明子，
 * calcShi/calcXiang/PIECE_VALUES/将军判定/UI 全部沿用现有逻辑。
 * 附带好处：任一时刻不存在两个活子共用同一 id，32 格命名空间恒够用
 * （每个真实 id 一旦升起就永久占用，最坏 16 红 + 16 黑 = 32，刚好用尽）。
 *
 * 走法为什么天然正确：暗子按**占位 id**（= 棋位对应棋种）写进 qiPan，
 * 而 MoveCheck.fillPathPoints 就是对 32 个字面量 id 的 switch，
 * 喂占位 id 给它，走法零改动即正确（兵位暗子只能前进一格等）。
 *
 * ============================================================================
 * 安全边界（方案 §2.1 铁律 A）
 * ---------------------------------------------------------------------------
 * 暗子真实身份**永不挂在 GameState 上**，只存在于 JieqiIdentity（随局内存放）。
 * GameState.hiddenMask 只表示「哪些格是暗子」，不含任何身份信息。
 * ============================================================================
 */

import {
  BOARD_COLS, BOARD_ROWS, RED_SIDE, BLACK_SIDE,
  QIZI_INIT_POSITION,
  type SideTag, type GameState, type PieceState,
} from './types';

// ---------------------------------------------------------------------------
// 棋种与 id 映射
// ---------------------------------------------------------------------------

export type JieqiPieceType = 'che' | 'ma' | 'pao' | 'shi' | 'xiang' | 'zu' | 'bing';

/** 与 SideTag 一一对应的查表键（Record 不能用 boolean 下标） */
type SideKey = 'red' | 'black';
const keyOf = (side: SideTag): SideKey => (side === RED_SIDE ? 'red' : 'black');

/**
 * 各棋种在**某一方的** id 清单。
 *
 * 注意黑方是「卒/象/士」、红方是「兵/相/仕」，所以同一棋种两侧的 id 不存在
 * 统一的 ±16 关系（兵的 id 本就是红方口径），必须按方显式列出。
 */
const TYPE_IDS_BY_SIDE: Record<SideKey, Record<JieqiPieceType, number[]>> = {
  black: {
    shi: [1, 2], xiang: [3, 4], ma: [5, 6], che: [7, 8], pao: [9, 10],
    zu: [11, 12, 13, 14, 15], bing: [],
  },
  red: {
    shi: [17, 18], xiang: [19, 20], ma: [21, 22], che: [23, 24], pao: [25, 26],
    zu: [], bing: [27, 28, 29, 30, 31],
  },
};

/**
 * 某一方的初始身份多重集（不含将帅，共 15 枚）。
 * 黑方是 5 卒、红方是 5 兵 —— 故必须按方取，不能用一张共用表。
 */
const HIDDEN_MULTISET_BY_SIDE: Record<SideKey, ReadonlyArray<readonly [JieqiPieceType, number]>> = {
  black: [['che', 2], ['ma', 2], ['pao', 2], ['shi', 2], ['xiang', 2], ['zu', 5]],
  red: [['che', 2], ['ma', 2], ['pao', 2], ['shi', 2], ['xiang', 2], ['bing', 5]],
};

/** 两侧并集，供「任意棋种」的枚举使用（AI 评估等） */
const ALL_TYPES: readonly JieqiPieceType[] = ['che', 'ma', 'pao', 'shi', 'xiang', 'zu', 'bing'];

/** id → 棋种（占位 id 与真实 id 共用这张表；将帅 0/16 不在表内） */
const ID_TYPE: Record<number, JieqiPieceType> = (() => {
  const m: Record<number, JieqiPieceType> = {};
  for (const key of ['black', 'red'] as const) {
    const byType = TYPE_IDS_BY_SIDE[key];
    for (const t of ALL_TYPES) {
      for (const id of byType[t]) m[id] = t;
    }
  }
  return m;
})();

/** 某棋子 id 的棋种；将/帅返回 null */
export function pieceTypeOf(id: number): JieqiPieceType | null {
  return ID_TYPE[id] ?? null;
}

/** 某 id 属于哪一方 */
export function sideOfId(id: number): SideTag {
  return id <= 15 ? BLACK_SIDE : RED_SIDE;
}

/** 同类棋子的 id 清单（按方） */
function idsOfType(type: JieqiPieceType, side: SideTag): number[] {
  return TYPE_IDS_BY_SIDE[keyOf(side)][type];
}

/**
 * 棋种 → **该方同类棋子的代表 id**（用于 MoveCheck 的走法派发）。
 *
 * 揭棋下盘面 id 恒为棋位 id，已翻开的暗子必须按真实身份走法，于是需要一个
 * 「派发用代表 id」。同类棋子走法与攻击范围完全相同（车与车无差别），
 * 故取该方该类第一个 id 即可。
 *
 * 注意卒/兵分属两方：黑方的 'zu' 映射到黑卒 id，红方的 'bing' 映射到红兵 id。
 */
export function representativeId(type: JieqiPieceType, side: SideTag): number | null {
  const ids = idsOfType(type, side);
  return ids.length > 0 ? ids[0] : null;
}

/**
 * 该子的「有效棋种」——揭棋一切走法/攻击判定的依据。
 *
 * 规则：
 *   · 暗子（hiddenMask[id] === true）→ 返回 id 的棋种，即**所在棋位的棋种**
 *     （规则 2：暗子按棋位走法）。此时不查 revealedType。
 *   · 已翻开 → revealedType[id]（真实身份）。
 *   · 象棋局面 / 无 id → null（调用方按标准 id 处理）。
 */
export function effectiveTypeOf(state: GameState, id: number): JieqiPieceType | null {
  if (state.variant !== 'jieqi') return null;
  if (state.hiddenMask?.[id] === true) return ID_TYPE[id] ?? null;
  return state.revealedType?.[id] ?? null;
}

/**
 * 该子用于 MoveCheck 派发的代表 id（象棋或未翻开暗子 → undefined）。
 *
 * 未翻开的暗子刻意**返回 undefined**：让它继续用盘面 id 走法（= 棋位棋种），
 * 这正是规则 2 的要求，无需任何映射。
 */
export function effectiveIdOf(state: GameState, id: number): number | undefined {
  if (state.variant !== 'jieqi') return undefined;
  if (state.hiddenMask?.[id] === true) return undefined;
  const type = state.revealedType?.[id];
  if (!type) return undefined;
  return representativeId(type, sideOfId(id)) ?? undefined;
}

/**
 * 该子是否受过河/九宫放宽（仅**已翻开**的士/象为真）。
 *
 * 与 effectiveId 同源：未翻开的暗子按棋位走法，不享放宽（规则 5 只说
 * 「揭开后的士、象可以过河」）。象棋恒 false。
 */
export function crossRiverOf(state: GameState, id: number): boolean | undefined {
  if (state.variant !== 'jieqi') return undefined;
  if (state.hiddenMask?.[id] === true) return false;
  const type = state.revealedType?.[id];
  return type === 'shi' || type === 'xiang' ? true : undefined;
}

/** 该方暗子占位 id 清单（初始 15 枚，将帅除外）。占位 id == 该位标准 id。 */
export function hiddenSlotIdsOf(side: SideTag): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    if (i === 0 || i === 16) continue;      // 将帅恒明子
    if (sideOfId(i) !== side) continue;
    out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 身份（真相）：随局内存放，不进 GameState、不进任何 payload
// ---------------------------------------------------------------------------

/**
 * 暗子真实身份映射。
 *
 * identity[占位 id] = 该暗子的真实**棋种**（不是 id！）；仅当该暗子尚未翻开时
 * 有意义。
 *
 * ⚠️ 这里存「棋种」而不是「真实棋子 id」，是踩过坑之后的设计修正：
 * 盘面 id 是 pieces 的下标且与暗子占位格同一集合，若把身份存成 id，
 * 翻开时就要把 id 写进 pieces —— 而那个 id 极可能已被另一个在盘暗子占用
 * （实测 30/30 暗子全撞，见 jieqiSetup.test.ts「id 冲突回归」）。
 * 存棋种则彻底绕开命名空间：翻开只写 revealedType[id]，盘面 id 永不变。
 */
export interface JieqiIdentity {
  /** 下标 = 暗子占位 id，值 = 真实棋种（null = 该格无暗子/已翻开） */
  hiddenType: (JieqiPieceType | null)[];
  /** 初始洗牌用的随机种子（供复盘/悔棋还原，不外发） */
  seed: number;
}

function emptyMultiset(): Record<JieqiPieceType, number> {
  return { che: 0, ma: 0, pao: 0, shi: 0, xiang: 0, zu: 0, bing: 0 };
}

/**
 * 洗牌：把该方 15 枚身份随机指派给 15 个占位 id。
 *
 * randInt 返回 [0,n) 的整数。
 */
function assignSide(
  hiddenType: (JieqiPieceType | null)[],
  slots: number[],
  randInt: (n: number) => number
): void {
  // 每个占位 id 的棋种 = 它所在棋位对应的棋种（揭棋「暗子按棋位走」）
  const types = slots.map(s => ID_TYPE[s]);
  // Fisher–Yates 洗牌
  for (let i = types.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = types[i];
    types[i] = types[j];
    types[j] = tmp;
  }
  // 逐个写入真实棋种
  for (let i = 0; i < slots.length; i++) {
    hiddenType[slots[i]] = types[i] ?? null;
  }
}

/** 构造身份表。randInt 返回 [0,n) 的整数。 */
export function buildJieqiIdentity(
  randInt: (n: number) => number,
  seed = 0
): JieqiIdentity {
  const hiddenType = new Array<JieqiPieceType | null>(32).fill(null);
  assignSide(hiddenType, hiddenSlotIdsOf(BLACK_SIDE), randInt);
  assignSide(hiddenType, hiddenSlotIdsOf(RED_SIDE), randInt);
  return { hiddenType, seed };
}

// ---------------------------------------------------------------------------
// 洗牌随机源
// ---------------------------------------------------------------------------

/**
 * 生产用随机源：优先 CSPRNG（Node 的 globalThis.crypto.getRandomValues）。
 *
 * 方案 §6.2 要求服务端用密码学随机 —— 若用 Math.random，「猜种子 → 还原全部暗子
 * 身份」会成为可行的作弊路径。取模偏置在此可接受（洗牌不需要完美均匀）。
 * 运行环境无 CSPRNG 时（如部分 RN 环境）退回 Math.random，仅供离线单机。
 */
export function makeShuffleRand(): (n: number) => number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    return (n: number) => {
      c.getRandomValues(buf);
      return buf[0] % n;
    };
  }
  return (n: number) => Math.floor(Math.random() * n);
}

/** 可注入种子的确定性随机（测试/复盘用；生产洗牌请用 makeShuffleRand） */
export function makeSeededRand(seed: number): (n: number) => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return (n: number) => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s % n;
  };
}

// ---------------------------------------------------------------------------
// 揭棋初始局面
// ---------------------------------------------------------------------------

/**
 * 构造揭棋初始局面。
 *
 * 产出 GameState（variant='jieqi'，qiPan 上写占位 id，hiddenMask 除将帅全 true）
 * 与 JieqiIdentity（真相，绝不进 GameState）。
 */
export function createJieqiInitialState(
  randInt?: (n: number) => number,
  firstMoveSide: SideTag = RED_SIDE
): { state: GameState; identity: JieqiIdentity } {
  const rand = randInt ?? makeShuffleRand();
  const qiPan: number[][] = Array.from(
    { length: BOARD_COLS },
    () => new Array<number>(BOARD_ROWS).fill(-1)
  );
  const pieces: PieceState[] = [];
  const hiddenMask = new Array<boolean>(32).fill(false);

  // 占位 id == 标准初始 id：除将帅外全部暗置
  for (let i = 0; i < 32; i++) {
    const col = QIZI_INIT_POSITION[i][0];
    const row = QIZI_INIT_POSITION[i][1];
    pieces.push({ id: i, col, row, alive: true });
    qiPan[col][row] = i;
    if (i !== 0 && i !== 16) hiddenMask[i] = true;
  }

  const identity = buildJieqiIdentity(rand, 0);

  const state: GameState = {
    qiPan,
    pieces,
    sideTag: firstMoveSide,
    moveHistory: [],
    gameStatus: 'playing',
    isCheck: false,
    checkMessage: '',
    zobristHash: 0,
    variant: 'jieqi',
    hiddenMask,
    // 翻开后才会写入；开局全为 null
    revealedType: new Array<JieqiPieceType | null>(32).fill(null),
  };
  return { state, identity };
}

// ---------------------------------------------------------------------------
// 局面查询
// ---------------------------------------------------------------------------

/** 该 GameState 是否为揭棋（缺省 variant 视为象棋） */
export function isJieqi(state: GameState): boolean {
  return state.variant === 'jieqi';
}

/** 该子当前是否未翻开（暗子）；象棋局面恒 false */
export function isHidden(state: GameState, pieceId: number): boolean {
  return state.hiddenMask?.[pieceId] === true;
}

/** 某方当前仍在盘上的暗子占位 id 列表 */
export function liveHiddenSlots(state: GameState, side: SideTag): number[] {
  const out: number[] = [];
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue;
    if (sideOfId(id) !== side) continue;
    if (!state.pieces[id]?.alive) continue;
    if (state.hiddenMask?.[id] === true) out.push(id);
  }
  return out;
}

/** 暗子总数（用于 UI 角标：已获得 N 枚未知暗子） */
export function countCapturedHidden(initialHiddenCount: number, liveHiddenCount: number): number {
  return Math.max(0, initialHiddenCount - liveHiddenCount);
}

// ---------------------------------------------------------------------------
// AI：暗子身份后验（超几何分布，解析可算，无需蒙特卡洛）
// ---------------------------------------------------------------------------

/**
 * 计算某方**尚未翻开的暗子**的真实身份后验分布。
 *
 * 关键洞察（方案 §9.3）：服务端洗牌时身份在同方 15 枚暗子上均匀随机置换，
 * 因此对任一未读暗子，其真实身份服从**超几何分布**。该后验精确可算。
 *
 * 计算方式：
 *   remaining[t] = 初始多重集[t] - 当前盘上该方**已翻开**的 t 数量
 *   （被吃暗子的真实身份对双方都不可见，故只能整体作为未知余量）
 *   归一化后即得每个未读暗子的身份分布。
 *
 * @returns 未读暗子占位 id → 身份分布（各 value 之和为 1）
 */
export function hiddenIdentityPosterior(
  state: GameState,
  side: SideTag
): Map<number, Record<JieqiPieceType, number>> {
  const out = new Map<number, Record<JieqiPieceType, number>>();
  const slots = liveHiddenSlots(state, side);
  if (slots.length === 0) return out;

  const types = HIDDEN_MULTISET_BY_SIDE[keyOf(side)];

  // 初始多重集
  const remaining = emptyMultiset();
  for (const [t, n] of types) remaining[t] = n;

  // 扣掉该方**已翻开**（revealedType 有值）的身份
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue;
    if (sideOfId(id) !== side) continue;
    const p = state.pieces[id];
    if (!p || !p.alive) continue;            // 已死的身份不在盘上，不重复扣
    if (state.hiddenMask?.[id] === true) continue; // 仍是暗子，未翻开
    // 揭棋：已翻开的真实身份在 revealedType；象棋走 ID_TYPE（永不触发，见下）
    const t = state.revealedType?.[id] ?? (state.variant === 'jieqi' ? null : ID_TYPE[id]);
    if (t) remaining[t] = Math.max(0, remaining[t] - 1);
  }

  let total = 0;
  for (const [t] of types) total += remaining[t];

  // 未读暗子之间不可区分：每个暗子都取同一份归一化分布
  if (total > 0) {
    const dist = emptyMultiset();
    for (const [t] of types) dist[t] = remaining[t] / total;
    for (const slot of slots) out.set(slot, { ...dist });
  } else {
    // 理论上不会发生（暗子还在但池已空 = 数据损坏），退回均匀分布以免除零
    const uniform = emptyMultiset();
    for (const [t] of types) uniform[t] = 1 / types.length;
    for (const slot of slots) out.set(slot, { ...uniform });
  }
  return out;
}

/**
 * 某枚暗子的期望子力价值（AI 评估用）。
 * 棋种 → 价值的映射由调用方注入，避免本模块依赖 AIEngine 的 PIECE_VALUES。
 */
export function expectedHiddenValue(
  posterior: Map<number, Record<JieqiPieceType, number>>,
  slot: number,
  valueOf: (t: JieqiPieceType) => number
): number {
  const dist = posterior.get(slot);
  if (!dist) return 0;
  let sum = 0;
  for (const t of ALL_TYPES) sum += (dist[t] ?? 0) * valueOf(t);
  return sum;
}

export const __jieqiInternal = {
  TYPE_IDS_BY_SIDE,
  HIDDEN_MULTISET_BY_SIDE,
  ID_TYPE,
  keyOf,
  idsOfType,
};