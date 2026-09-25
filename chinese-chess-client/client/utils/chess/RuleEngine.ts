/**
 * 长将长捉规则引擎
 *
 * 依据《中国象棋娱乐向长将长捉规则与开发规范 v1.0》实现：
 * - 计数状态机（方案 3）：长将/长捉/将捉交替按「同一方连续执行该行为的着数」计数
 * - 每步走子后的判定流程（方案 5）：将军检测 → 捉子检测 → 计数更新 → 重复检测 → 阈值检查
 * - 捉子检测（方案 7）：走子后能够造成下一着吃掉对方无根子（假根视为无根），
 *   带特殊子力豁免（兵卒将帅长捉允许、未过河兵卒不算、单/双炮捉车不算、同类互献不算）
 * - 禁着与变招（方案 10）：达到阈值后强制禁着（banMoves 列表），变招后自动解除，
 *   连续 3 次坚持禁着自动判负（双方均拒绝变着判和）
 * - 判和体系（方案 2.4）：互长将/互长捉/非将非捉重复 5 次/自然限招 120 着/
 *   将军累计 40 着/总步数 400 着/双方无进攻子力
 * - 二将一还（方案 2.1.3）：对方还过将时长将方直接判负
 * - 所有阈值集中于 RULE_CONFIG（方案 19.5：可配置）
 *
 * 架构约束：
 * - 纯函数、无 UI 依赖，客户端（人机/残局/联机/复盘）与服务端（ruleEngine.cjs）共用
 * - RuleState 挂载于 GameState.ruleState 随状态序列化，断线重连/存档恢复天然支持
 * - 本模块不依赖 GameEngine（避免循环依赖），基础走法能力直接构建于 MoveCheck 之上
 * - 性能：单步判定 < 50ms（方案 15.1）；detectZhuo 攻击图单次构建、banMoves 仅禁着时生成
 */

import {
  BOARD_COLS, BOARD_ROWS, RED_SIDE, BLACK_SIDE,
  type SideTag, type GameState, type MoveRecord,
  type BanReason, type BanMove, type SideRuleCounters, type RuleState,
} from './types';
import { getPathPoints, afterMoveStillJiangJun } from './MoveCheck';

// 类型已下沉至 types.ts（避免与 GameEngine 循环依赖），此处 re-export 保持引用便利
export type { BanReason, BanMove, SideRuleCounters, RuleState } from './types';

// ---------------------------------------------------------------------------
// 阈值配置（方案 19.5：所有阈值必须可配置）
// ---------------------------------------------------------------------------
export const RULE_CONFIG = {
  /** 长将允许着数：按参与长将的子力数量（1 子 / 2 子 / 3 子及以上），方案 2.1.1 */
  longCheckByPieceCount: [6, 12, 18] as const,
  /** 长捉同一子允许着数（方案 2.2.1） */
  longChase: 6,
  /** 将捉交替允许着数：一子 / 一子以上（方案 2.3） */
  checkChaseByPieceCount: [12, 18] as const,
  /** 非将非捉局面重复判和次数（方案 2.4） */
  repetitionDraw: 5,
  /** 互相长将判和阈值（双方各自长将达到该着数，方案 2.1.2） */
  mutualLongCheckDraw: 6,
  /** 互相长捉判和阈值（方案 2.2.3） */
  mutualLongChaseDraw: 6,
  /** 自然限招：无吃子着数上限（方案 2.4） */
  naturalMoveLimit: 120,
  /** 自然限招窗口内将军累计上限（方案 2.4） */
  checkCountLimit: 40,
  /** 双方累计总着数上限（方案 2.4） */
  totalMoveLimit: 400,
  /** 连续坚持禁着自动判负次数（方案 10.1） */
  banViolationLimit: 3,
} as const;

// ---------------------------------------------------------------------------
// 类型定义见 types.ts（BanReason/BanMove/SideRuleCounters/RuleState，
// 方案 3.3 计数数据结构 + 方案 10.2 禁着列表），本文件顶部 re-export
// ---------------------------------------------------------------------------

/** 每步走子后的规则评估结果（方案 11.2 MoveResult 的规则部分） */
export interface RuleEvaluation {
  ruleState: RuleState;
  gameOver: boolean;
  /** 终局原因：mutual_long_check / mutual_long_chase / repetition / natural_limit /
   *  total_limit / no_attacking / changjiang（长将判负，含二将一还）/ changzhuo（长捉判负） */
  gameOverReason: string;
  /** 判负方（null = 和棋或未终局） */
  loser: SideTag | null;
}

// ---------------------------------------------------------------------------
// 棋子类型工具（棋子 id 区间：黑 0-15 / 红 16-31；
// 将帅 0/16，士 1-2/17-18，象 3-4/19-20，马 5-6/21-22，车 7-8/23-24，
// 炮 9-10/25-26，卒 11-15 / 兵 27-31）
// ---------------------------------------------------------------------------
function sideOfPiece(id: number): SideTag {
  return id <= 15 ? BLACK_SIDE : RED_SIDE;
}
function isJiangShuai(id: number): boolean {
  return id === 0 || id === 16;
}
function isChe(id: number): boolean {
  return id === 7 || id === 8 || id === 23 || id === 24;
}
function isPao(id: number): boolean {
  return id === 9 || id === 10 || id === 25 || id === 26;
}
function isBingZu(id: number): boolean {
  return (id >= 11 && id <= 15) || (id >= 27 && id <= 31);
}
/** 同类型棋子（车/马/炮/兵卒/士/象）——用于同类互献判定 */
function samePieceType(a: number, b: number): boolean {
  const t = (id: number): string =>
    isJiangShuai(id) ? 'k' : isChe(id) ? 'r' : isPao(id) ? 'c' : isBingZu(id) ? 'p'
      : (id === 5 || id === 6 || id === 21 || id === 22) ? 'n'
        : (id === 3 || id === 4 || id === 19 || id === 20) ? 'b' : 'a';
  return t(a) === t(b);
}
/** 兵/卒是否已过河（黑卒向下过河 row>=5；红兵向上过河 row<=4） */
function hasCrossedRiver(id: number, row: number): boolean {
  return id <= 15 ? row >= 5 : row <= 4;
}
function sideKey(side: SideTag): 'red' | 'black' {
  return side === RED_SIDE ? 'red' : 'black';
}

// ---------------------------------------------------------------------------
// 基础局面工具
// ---------------------------------------------------------------------------
type Positions = Array<{ col: number; row: number; alive: boolean }>;

function toPositions(state: GameState): Positions {
  return state.pieces.map(p => ({ col: p.col, row: p.row, alive: p.alive }));
}

/** 局面指纹：全部存活棋子位置 + 走棋方（方案 8 重复检测的键） */
export function positionKey(state: GameState): string {
  let key = '';
  for (let i = 0; i < 32; i++) {
    const p = state.pieces[i];
    if (p.alive) key += `${i}:${p.col}${p.row};`;
  }
  return key + (state.sideTag === RED_SIDE ? 'w' : 'b');
}

/** 指定方的将/帅是否被攻击（将军检测，方案 6） */
function isSideInCheck(state: GameState, side: SideTag): boolean {
  const kingId = side === RED_SIDE ? 16 : 0;
  const king = state.pieces[kingId];
  if (!king.alive) return false;
  const positions = toPositions(state);
  const enemyStart = side === RED_SIDE ? 5 : 21;
  const enemyEnd = side === RED_SIDE ? 16 : 32;
  for (let id = enemyStart; id < enemyEnd; id++) {
    if (!state.pieces[id].alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    if (pts[king.col][king.row]) return true;
  }
  return false;
}

/** 枚举指定方全部合法着法（伪合法 + 走后己方不被将/不飞将过滤） */
export function enumerateLegalMoves(
  state: GameState,
  side: SideTag
): Array<{ pieceId: number; fromCol: number; fromRow: number; toCol: number; toRow: number }> {
  const moves: Array<{ pieceId: number; fromCol: number; fromRow: number; toCol: number; toRow: number }> = [];
  const positions = toPositions(state);
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    const piece = state.pieces[id];
    if (!piece.alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (!pts[c][r]) continue;
        if (c === piece.col && r === piece.row) continue;
        if (afterMoveStillJiangJun(id, piece.col, piece.row, c, r, state.qiPan, positions)) continue;
        moves.push({ pieceId: id, fromCol: piece.col, fromRow: piece.row, toCol: c, toRow: r });
      }
    }
  }
  return moves;
}

/**
 * 轻量模拟走子（禁着分类/根判定专用，不触发规则评估与终局判定）：
 * 返回走后的新状态（棋盘/棋子/走棋方/isCheck），ruleState 原样透传，不记录 moveHistory。
 */
function simulateMove(state: GameState, pieceId: number, toCol: number, toRow: number): GameState {
  const next: GameState = {
    qiPan: state.qiPan.map(r => [...r]),
    pieces: state.pieces.map(p => ({ ...p })),
    sideTag: !state.sideTag,
    moveHistory: [...state.moveHistory],
    gameStatus: 'playing',
    isCheck: false,
    checkMessage: '',
    zobristHash: 0,
    ruleState: state.ruleState,
  };
  const piece = next.pieces[pieceId];
  const captured = next.qiPan[toCol][toRow];
  next.qiPan[piece.col][piece.row] = -1;
  next.qiPan[toCol][toRow] = pieceId;
  piece.col = toCol;
  piece.row = toRow;
  if (captured !== -1) next.pieces[captured].alive = false;
  next.isCheck = isSideInCheck(next, next.sideTag);
  return next;
}

// ---------------------------------------------------------------------------
// 捉子检测（方案 7）
// ---------------------------------------------------------------------------

/** 棋子移动到 (toCol,toRow) 后其原方是否仍被将军（含飞将）——牵制判定 */
function isPinnedMove(state: GameState, pieceId: number, toCol: number, toRow: number): boolean {
  const positions = toPositions(state);
  const p = state.pieces[pieceId];
  return afterMoveStillJiangJun(pieceId, p.col, p.row, toCol, toRow, state.qiPan, positions);
}

/** 在给定局面中，attackSide 一方能攻击到 (col,row) 的棋子 id 列表 */
function attackersOf(state: GameState, attackSide: SideTag, col: number, row: number): number[] {
  const positions = toPositions(state);
  const result: number[] = [];
  const start = attackSide === RED_SIDE ? 16 : 0;
  const end = attackSide === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    if (!state.pieces[id].alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    if (pts[col][row]) result.push(id);
  }
  return result;
}

/**
 * 被吃模拟：attacker 吃掉 target 后的局面上，target 方是否存在真根
 * （能反吃 attacker 且反吃后不被将军的保护子；保护子被牵制 = 假根，方案 1.3 / 7.2）。
 * 模拟 attacker 落到 target 位、target 亡、attacker 原位清空后再查保护，
 * 天然处理炮架变化等位置依赖。
 */
function targetHasRealRoot(state: GameState, targetId: number, attackerId: number): boolean {
  const t = state.pieces[targetId];
  const sim = simulateMove(state, attackerId, t.col, t.row);
  const defenderSide = sideOfPiece(targetId);
  const a = sim.pieces[attackerId];
  const guards = attackersOf(sim, defenderSide, a.col, a.row).filter(id => id !== targetId);
  for (const g of guards) {
    if (!isPinnedMove(sim, g, a.col, a.row)) return true; // 有真根
  }
  return false; // 无根或全部为假根
}

/**
 * 同类互献（长献）判定（方案 1.2）：捉同类子，双方均未受牵制且互能去子 → 不算捉。
 */
function isSacrificeExchange(state: GameState, attackerId: number, targetId: number): boolean {
  if (!samePieceType(attackerId, targetId)) return false;
  const defenderSide = sideOfPiece(targetId);
  const a = state.pieces[attackerId];
  const t = state.pieces[targetId];
  // target 方能吃到 attacker 当前位置（互能去子）
  if (!attackersOf(state, defenderSide, a.col, a.row).includes(targetId)) return false;
  // 双方均未受牵制
  if (isPinnedMove(state, attackerId, t.col, t.row)) return false;
  if (isPinnedMove(state, targetId, a.col, a.row)) return false;
  return true;
}

/**
 * 棋子是否被完全牵制（方案 1.2「一方受牵制时，对方捉该受牵制的子算捉」）：
 * 该子的所有走法都会使己方将/帅暴露（含飞将）→ 无安全移动 → 被牵制。
 */
function isPiecePinned(state: GameState, targetId: number): boolean {
  const positions = toPositions(state);
  const t = state.pieces[targetId];
  const pts = getPathPoints(targetId, state.qiPan, positions);
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) {
      if (!pts[c][r]) continue;
      if (c === t.col && r === t.row) continue;
      // 存在任一走后不被将军的走法 → 未被完全牵制
      if (!afterMoveStillJiangJun(targetId, t.col, t.row, c, r, state.qiPan, positions)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 捉子检测（方案 7.1）：走子后，moverSide 能够在下一着吃掉的对方「无根子」列表。
 *
 * 豁免（方案 1.2「不算捉的情形」+ 2.2.4 特殊子力限制）：
 * - 将/帅不作为捉的对象；未过河兵/卒不作为捉的对象
 * - 兵/卒、将/帅作为攻击者的长捉允许——有效攻击者全部为兵卒将帅时豁免
 * - 单炮或双炮长捉一车：不算捉
 * - 同类互献（双方未受牵制互能去子）：不算捉
 * - 假根子（保护子被牵制无法反吃）：按无根计，算捉
 * - 受牵制无法移动的子：直接算捉（不论有无根，方案 1.2）
 */
export function detectZhuo(state: GameState, moverSide: SideTag): number[] {
  const enemySide: SideTag = !moverSide;
  const enemyStart = enemySide === RED_SIDE ? 16 : 0;
  const enemyEnd = enemySide === RED_SIDE ? 32 : 16;
  const results: number[] = [];

  // moverSide 全部存活子的走法表（单次构建，攻击图查表）
  const positions = toPositions(state);
  const myPoints = new Map<number, boolean[][]>();
  const myStart = moverSide === RED_SIDE ? 16 : 0;
  const myEnd = moverSide === RED_SIDE ? 32 : 16;
  for (let id = myStart; id < myEnd; id++) {
    if (!state.pieces[id].alive) continue;
    myPoints.set(id, getPathPoints(id, state.qiPan, positions));
  }

  for (let targetId = enemyStart; targetId < enemyEnd; targetId++) {
    const t = state.pieces[targetId];
    if (!t.alive) continue;
    if (isJiangShuai(targetId)) continue; // 将/帅不作捉的对象
    if (isBingZu(targetId) && !hasCrossedRiver(targetId, t.row)) continue; // 未过河兵/卒不算

    const attackers: number[] = [];
    for (const [id, pts] of myPoints) {
      if (pts[t.col][t.row]) attackers.push(id);
    }
    if (attackers.length === 0) continue;

    // 兵/卒、将/帅长捉豁免：有效攻击者（车马炮象士）为空 → 不算捉
    let effective = attackers.filter(id => !isBingZu(id) && !isJiangShuai(id));
    if (effective.length === 0) continue;

    // 单炮/双炮长捉一车：不算捉（方案 2.2.4）
    if (isChe(targetId) && effective.every(isPao)) continue;

    // 同类互献豁免（方案 1.2）
    effective = effective.filter(id => !isSacrificeExchange(state, id, targetId));
    if (effective.length === 0) continue;

    // 受牵制无法移动的子：直接算捉（不论有无根，方案 1.2「一方受牵制时，
    // 对方捉该受牵制的子算捉」；如车被牵制时任何子捉车，方案 2.2.4）
    if (isPiecePinned(state, targetId)) {
      results.push(targetId);
      continue;
    }

    // 无根/假根判定：任一有效攻击者吃 target 后对方无真根 → 算捉
    let chased = false;
    for (const attackerId of effective) {
      if (!targetHasRealRoot(state, targetId, attackerId)) {
        chased = true;
        break;
      }
    }
    if (chased) results.push(targetId);
  }
  return results;
}

// ---------------------------------------------------------------------------
// RuleState 构造与克隆
// ---------------------------------------------------------------------------
function emptySideCounters(): SideRuleCounters {
  return {
    jiangCount: 0,
    jiangPieceIds: [],
    zhuoCounts: {},
    jiangZhuoLoop: 0,
    jiangZhuoPieceIds: [],
    opponentCheckedDuringRun: false,
  };
}

export function createInitialRuleState(state: GameState): RuleState {
  return {
    red: emptySideCounters(),
    black: emptySideCounters(),
    positionKeys: [positionKey(state)],
    naturalMoveCounter: 0,
    checkCounterInWindow: 0,
    banActive: false,
    banSide: null,
    banReason: null,
    banChaseTargets: [],
    banMoves: [],
    banViolations: { red: 0, black: 0 },
    notice: null,
    noticeKey: null,
  };
}

function cloneSideCounters(s: SideRuleCounters): SideRuleCounters {
  return {
    jiangCount: s.jiangCount,
    jiangPieceIds: [...s.jiangPieceIds],
    zhuoCounts: { ...s.zhuoCounts },
    jiangZhuoLoop: s.jiangZhuoLoop,
    jiangZhuoPieceIds: [...s.jiangZhuoPieceIds],
    opponentCheckedDuringRun: s.opponentCheckedDuringRun,
  };
}

export function cloneRuleState(r: RuleState): RuleState {
  return {
    red: cloneSideCounters(r.red),
    black: cloneSideCounters(r.black),
    positionKeys: [...r.positionKeys],
    naturalMoveCounter: r.naturalMoveCounter,
    checkCounterInWindow: r.checkCounterInWindow,
    banActive: r.banActive,
    banSide: r.banSide,
    banReason: r.banReason,
    banChaseTargets: [...r.banChaseTargets],
    banMoves: r.banMoves.map(m => ({ ...m })),
    banViolations: { ...r.banViolations },
    notice: r.notice,
    noticeKey: r.noticeKey,
  };
}

function resetSideCounters(s: SideRuleCounters) {
  s.jiangCount = 0;
  s.jiangPieceIds = [];
  s.zhuoCounts = {};
  s.jiangZhuoLoop = 0;
  s.jiangZhuoPieceIds = [];
  s.opponentCheckedDuringRun = false;
}

// ---------------------------------------------------------------------------
// 禁着
// ---------------------------------------------------------------------------

/** 长将允许着数（按参与子数分档：1 子 6 / 2 子 12 / 3 子及以上 18，方案 2.1.1） */
function longCheckLimit(pieceCount: number): number {
  return pieceCount <= 1 ? RULE_CONFIG.longCheckByPieceCount[0]
    : pieceCount === 2 ? RULE_CONFIG.longCheckByPieceCount[1]
      : RULE_CONFIG.longCheckByPieceCount[2];
}

/** 将捉交替允许着数（一子 12 / 一子以上 18，方案 2.3） */
function checkChaseLimit(pieceCount: number): number {
  return pieceCount <= 1 ? RULE_CONFIG.checkChaseByPieceCount[0] : RULE_CONFIG.checkChaseByPieceCount[1];
}

/**
 * 生成禁着列表（方案 10.2）：banActive 时枚举被禁方全部合法着法，按 banReason 分类：
 * - LONG_CHECK：模拟后构成将军的着法
 * - LONG_CHASE：模拟后捉到触发阈值目标子的着法
 * - CHECK_CHASE：模拟后构成将军或有效捉的着法（禁将捉组合，必须变招）
 */
function buildBanMoves(state: GameState, banSide: SideTag, banReason: BanReason, chaseTargets: number[]): BanMove[] {
  const bans: BanMove[] = [];
  for (const mv of enumerateLegalMoves(state, banSide)) {
    const after = simulateMove(state, mv.pieceId, mv.toCol, mv.toRow);
    let banned = false;
    if (banReason === 'LONG_CHECK') {
      banned = after.isCheck;
    } else if (banReason === 'LONG_CHASE') {
      banned = detectZhuo(after, banSide).some(id => chaseTargets.includes(id));
    } else {
      banned = after.isCheck || detectZhuo(after, banSide).length > 0;
    }
    if (banned) bans.push({ ...mv, reason: banReason });
  }
  return bans;
}

/** 指定着法当前是否为禁着（提交前校验；非禁着激活或非被禁方恒为 false） */
export function isMoveBanned(state: GameState, pieceId: number, toCol: number, toRow: number): boolean {
  const rs = state.ruleState;
  if (!rs || !rs.banActive || rs.banReason == null) return false;
  if (state.sideTag !== rs.banSide) return false;
  return rs.banMoves.some(m => m.pieceId === pieceId && m.toCol === toCol && m.toRow === toRow);
}

/**
 * 记录一次坚持禁着的违规（提交被拒后调用）。
 * @returns 'lose' 该方判负；'draw' 双方均拒绝变着判和（BOTH_BAN_REFUSE_CHANGE）；null 继续
 */
export function recordBanViolation(rs: RuleState, side: SideTag): 'lose' | 'draw' | null {
  const key = sideKey(side);
  rs.banViolations[key] = (rs.banViolations[key] ?? 0) + 1;
  if (rs.banViolations[key] >= RULE_CONFIG.banViolationLimit) {
    const other = key === 'red' ? 'black' : 'red';
    return (rs.banViolations[other] ?? 0) >= RULE_CONFIG.banViolationLimit ? 'draw' : 'lose';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 每步走子后的判定流程（方案 5）
// ---------------------------------------------------------------------------

function maxZhuoCount(s: SideRuleCounters): number {
  let max = 0;
  for (const k of Object.keys(s.zhuoCounts)) {
    if (s.zhuoCounts[k] > max) max = s.zhuoCounts[k];
  }
  return max;
}

/** 是否存在进攻子力（车/马/炮/兵卒任一存活，方案 2.4 例外条款） */
function hasAttackingPieces(state: GameState, side: SideTag): boolean {
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    if (!state.pieces[id].alive) continue;
    if (isJiangShuai(id)) continue;
    if (id === 1 || id === 2 || id === 17 || id === 18) continue; // 士
    if (id === 3 || id === 4 || id === 19 || id === 20) continue; // 象/相
    return true;
  }
  return false;
}

function finish(rs: RuleState, gameOver: boolean, reason: string, loser: SideTag | null): RuleEvaluation {
  if (gameOver) {
    rs.banActive = false;
    rs.banSide = null;
    rs.banReason = null;
    rs.banChaseTargets = [];
    rs.banMoves = [];
  }
  return { ruleState: rs, gameOver, gameOverReason: reason, loser };
}

/**
 * 走子后规则评估（makeMove 在绝杀/困毙判定之后调用，方案 5 判定顺序）。
 *
 * @param beforeState 走前局面（用于应将着识别：before.isCheck 为 true 时该着为应将着）
 * @param afterState  走后局面（sideTag 已切换，isCheck 已更新）
 * @param move        本着信息（走动子与吃子）
 */
export function evaluateRuleAfterMove(
  beforeState: GameState,
  afterState: GameState,
  move: { pieceId: number; captured: number }
): RuleEvaluation {
  const moverSide: SideTag = sideOfPiece(move.pieceId);
  const opponentSide: SideTag = !moverSide;
  const isCheck = afterState.isCheck; // 本着是否将军着（走后对方被将）
  const wasRespondingCheck = beforeState.isCheck; // 本着是否为应将着（方案 2.3.3）

  const rs = beforeState.ruleState
    ? cloneRuleState(beforeState.ruleState)
    : createInitialRuleState(beforeState);
  rs.notice = null;
  rs.noticeKey = null;

  const mover = rs[sideKey(moverSide)];
  const opponent = rs[sideKey(opponentSide)];

  // --- 变招解除（方案 4.2：BAN_ACTIVE + 玩家变招 → NORMAL） ---
  // 被禁方走出非禁着（着法已被提交说明通过了校验层拦截）= 变招 → 清空其计数；
  // 防御：若被禁方的禁着着法意外到达此处（校验层失效），同样清零并交由计数重建
  if (rs.banActive && rs.banSide === moverSide) {
    resetSideCounters(mover);
    rs.banViolations[sideKey(moverSide)] = 0;
  }

  // --- 计数更新（方案 3） ---
  const zhuoList = isCheck ? [] : detectZhuo(afterState, moverSide);

  if (move.captured !== -1) {
    // 吃子：重新计算所有计数（方案 3.1.1），自然限招窗口重置
    resetSideCounters(mover);
    resetSideCounters(opponent);
    rs.naturalMoveCounter = 0;
    rs.checkCounterInWindow = 0;
  } else if (isCheck) {
    // 将军着：优先算将（方案 2.3.2），清空走子方捉子计数，将捉循环照常累计
    mover.jiangCount += 1;
    if (!mover.jiangPieceIds.includes(move.pieceId)) mover.jiangPieceIds.push(move.pieceId);
    mover.jiangZhuoLoop += 1;
    if (!mover.jiangZhuoPieceIds.includes(move.pieceId)) mover.jiangZhuoPieceIds.push(move.pieceId);
    mover.zhuoCounts = {};
    rs.checkCounterInWindow += 1;
    // 二将一还线索（方案 2.1.3）：对方（被我这步将军的一方）若正处于连将，
    // 则对方连将期间"我还过将"——为对方标记，待其长将达到阈值时判其负
    if (opponent.jiangCount > 0) {
      opponent.opponentCheckedDuringRun = true;
    }
  } else if (zhuoList.length > 0) {
    // 捉着
    mover.jiangCount = 0;
    mover.jiangPieceIds = [];
    mover.jiangZhuoLoop += 1;
    if (!mover.jiangZhuoPieceIds.includes(move.pieceId)) mover.jiangZhuoPieceIds.push(move.pieceId);
    if (wasRespondingCheck) {
      // 应将产生的捉：算捉，被捉次数保留但不增加（方案 2.3.3）
    } else {
      // 分捉目标切换清空旧目标计数，仅累计当前着法实际捉到的目标（方案 2.2.2 / 3.1.2）
      const next: Record<string, number> = {};
      for (const targetId of zhuoList) {
        next[String(targetId)] = (mover.zhuoCounts[String(targetId)] ?? 0) + 1;
      }
      mover.zhuoCounts = next;
    }
  } else {
    // 非将非捉：连续性中断，清空走子方计数
    resetSideCounters(mover);
  }

  // --- 局面指纹与自然限招（方案 8 / 2.4） ---
  const currentKey = positionKey(afterState);
  rs.positionKeys.push(currentKey);
  // 吃子着不计入自然限招窗口（吃子即重置窗口，方案 0.1「从最后一次吃子开始累计」）
  if (move.captured === -1) rs.naturalMoveCounter += 1;
  const totalMoves = afterState.moveHistory.length;

  // --- 阈值检查（方案 9 触发表；判和优先，方案 0.2） ---

  // 双方无进攻子力（无车马炮卒）自动判和（方案 2.4 例外）
  if (!hasAttackingPieces(afterState, RED_SIDE) && !hasAttackingPieces(afterState, BLACK_SIDE)) {
    return finish(rs, true, 'no_attacking', null);
  }

  // 总步数上限（方案 2.4）
  if (totalMoves >= RULE_CONFIG.totalMoveLimit) {
    return finish(rs, true, 'total_limit', null);
  }

  // 自然限招：无吃子 120 着（方案 2.4）
  if (rs.naturalMoveCounter >= RULE_CONFIG.naturalMoveLimit) {
    return finish(rs, true, 'natural_limit', null);
  }

  // 自然限招窗口内将军累计 40 着（方案 2.4）
  if (rs.checkCounterInWindow >= RULE_CONFIG.checkCountLimit) {
    return finish(rs, true, 'natural_limit', null);
  }

  // 互相长将：双方各自长将达到 6 着判和（方案 2.1.2）
  if (rs.red.jiangCount >= RULE_CONFIG.mutualLongCheckDraw && rs.black.jiangCount >= RULE_CONFIG.mutualLongCheckDraw) {
    return finish(rs, true, 'mutual_long_check', null);
  }

  // 互相长捉：双方各一子连续被捉达到 6 着判和（方案 2.2.3）
  if (maxZhuoCount(rs.red) >= RULE_CONFIG.mutualLongChaseDraw && maxZhuoCount(rs.black) >= RULE_CONFIG.mutualLongChaseDraw) {
    return finish(rs, true, 'mutual_long_chase', null);
  }

  // 非将非捉局面重复 5 次判和（方案 2.4 / 8）
  if (!isCheck && zhuoList.length === 0) {
    let repetition = 1;
    for (let i = rs.positionKeys.length - 2; i >= 0; i--) {
      if (rs.positionKeys[i] === currentKey) repetition++;
    }
    if (repetition >= RULE_CONFIG.repetitionDraw) {
      return finish(rs, true, 'repetition', null);
    }
  }

  // 二将一还：一方步步叫将、对方还过将 → 长将方作负（方案 2.1.3）。
  // 互长将场景（对方连将至 5+）不适用，由上面的互长将判和/等待逻辑接管
  if (isCheck
    && mover.jiangCount >= RULE_CONFIG.longCheckByPieceCount[0]
    && mover.opponentCheckedDuringRun
    && opponent.jiangCount < RULE_CONFIG.mutualLongCheckDraw - 1) {
    return finish(rs, true, 'changjiang', moverSide);
  }

  // --- 禁着判定（强制变招，方案 10） ---
  // 对双方分别检查阈值：对方超阈值时其禁着必须保留——对方上一步触发的禁着
  // 不应因本方闲着而消失（直到对方变招清零计数）。本方（刚走子方）优先。
  const tryBan = (side: SideTag): { reason: BanReason; targets: number[] } | null => {
    const c = rs[sideKey(side)];
    const opp = rs[sideKey(!side as SideTag)];
    // 长将阈值：一子 6 / 两子 12 / 三子及以上 18（方案 2.1.1）
    if (c.jiangCount >= longCheckLimit(c.jiangPieceIds.length)) {
      // 互相长将进行中（对方连将至 5+）：暂不禁着，待对方达到 6 判和（方案 2.1.2）
      if (opp.jiangCount < RULE_CONFIG.mutualLongCheckDraw - 1) {
        return { reason: 'LONG_CHECK', targets: [] };
      }
      return null;
    }
    // 长捉阈值：连续捉同一子 6 着（方案 2.2.1）
    const targets = Object.keys(c.zhuoCounts)
      .filter(k => c.zhuoCounts[k] >= RULE_CONFIG.longChase)
      .map(k => Number(k));
    if (targets.length > 0) {
      // 互相长捉进行中（对方也有 5+ 捉计数）：暂不禁，待对方到 6 判和（方案 2.2.3）
      if (maxZhuoCount(opp) < RULE_CONFIG.mutualLongChaseDraw - 1) {
        return { reason: 'LONG_CHASE', targets };
      }
      return null;
    }
    // 将捉交替阈值：一子 12 / 一子以上 18（方案 2.3）
    if (c.jiangZhuoLoop >= checkChaseLimit(c.jiangZhuoPieceIds.length)) {
      return { reason: 'CHECK_CHASE', targets: [] };
    }
    return null;
  };

  const moverBan = tryBan(moverSide);
  const oppBan = tryBan(opponentSide);
  const hit = moverBan ?? oppBan;
  const hitSide = moverBan ? moverSide : opponentSide;

  if (hit) {
    rs.banActive = true;
    rs.banSide = hitSide; // 该方下一次走子时受限
    rs.banReason = hit.reason;
    rs.banChaseTargets = hit.targets;
    rs.banMoves = buildBanMoves(afterState, hitSide, hit.reason, hit.targets);
    rs.notice = hit.reason === 'LONG_CHECK'
      ? '长将禁着，请变招'
      : hit.reason === 'LONG_CHASE' ? '长捉禁着，请变招' : '将捉禁着，请变招';
    rs.noticeKey = `${sideKey(hitSide)}-ban-${hit.reason}`;
  } else {
    rs.banActive = false;
    rs.banSide = null;
    rs.banReason = null;
    rs.banChaseTargets = [];
    rs.banMoves = [];

    // 接近阈值提示（倒数第 2 着，方案 10.3 / 12；刚走子方优先，其次对方）
    const noticeFor = (side: SideTag): { text: string; key: string } | null => {
      const c = rs[sideKey(side)];
      const checkLimit = longCheckLimit(c.jiangPieceIds.length);
      if (c.jiangCount >= checkLimit - 1 && c.jiangCount < checkLimit) {
        return { text: '请尽快变招，避免长将判负', key: `${sideKey(side)}-jiang-${c.jiangCount}` };
      }
      const zhuoMax = maxZhuoCount(c);
      if (zhuoMax >= RULE_CONFIG.longChase - 1 && zhuoMax < RULE_CONFIG.longChase) {
        return { text: '请尽快变招，避免长捉判负', key: `${sideKey(side)}-zhuo-${zhuoMax}` };
      }
      const jzLimit = checkChaseLimit(c.jiangZhuoPieceIds.length);
      if (c.jiangZhuoLoop >= jzLimit - 1 && c.jiangZhuoLoop < jzLimit) {
        return { text: '请尽快变招，避免将捉判负', key: `${sideKey(side)}-jz-${c.jiangZhuoLoop}` };
      }
      return null;
    };
    const notice = noticeFor(moverSide) ?? noticeFor(opponentSide);
    if (notice) {
      rs.notice = notice.text;
      rs.noticeKey = notice.key;
    }
  }

  return finish(rs, false, '', null);
}

// ---------------------------------------------------------------------------
// 全量重算（悔棋/加载旧存档后恢复规则状态，方案 15.6）
// ---------------------------------------------------------------------------

/**
 * 从对局起点重放全部着法，重建规则状态。
 * 悔棋（undoMove）后 ruleState 与 moveHistory 不再对应，需全量重算；
 * 输入 state 的 moveHistory 必须自起始局面起完整。
 * 返回携带重算 ruleState 的同一局面（棋盘数据与传入 state 一致）。
 */
export function recomputeRuleState(state: GameState): GameState {
  const moves = state.moveHistory.slice();

  // 逆向回退到起始局面
  const probe: GameState = {
    qiPan: state.qiPan.map(r => [...r]),
    pieces: state.pieces.map(p => ({ ...p })),
    sideTag: state.sideTag,
    moveHistory: [],
    gameStatus: 'playing',
    isCheck: state.isCheck,
    checkMessage: '',
    zobristHash: 0,
    ruleState: undefined,
  };
  for (let i = moves.length - 1; i >= 0; i--) {
    const mv = moves[i];
    const p = probe.pieces[mv.pieceId];
    probe.qiPan[mv.toCol][mv.toRow] = mv.capturedPieceId;
    probe.qiPan[mv.fromCol][mv.fromRow] = mv.pieceId;
    p.col = mv.fromCol;
    p.row = mv.fromRow;
    if (mv.capturedPieceId !== -1) probe.pieces[mv.capturedPieceId].alive = true;
    probe.sideTag = !probe.sideTag;
  }
  probe.ruleState = createInitialRuleState(probe);

  // 正向重放（重放过程不做终局短路：真实对局中终局出现后 history 即终止）
  let current = probe;
  for (const mv of moves) {
    const after = simulateMove(current, mv.pieceId, mv.toCol, mv.toRow);
    after.moveHistory.push(mv);
    const evaluation = evaluateRuleAfterMove(current, after, {
      pieceId: mv.pieceId,
      captured: mv.capturedPieceId,
    });
    after.ruleState = evaluation.ruleState;
    current = after;
  }

  return { ...state, ruleState: current.ruleState };
}
