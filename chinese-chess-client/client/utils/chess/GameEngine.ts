/**
 * 中国象棋游戏引擎
 * 管理游戏状态、走棋逻辑、将军/绝杀判定
 */

import {
  QIZI_INIT_POSITION, BOARD_COLS, BOARD_ROWS, RED_SIDE, BLACK_SIDE,
  type SideTag, type MoveRecord, type GameStatus,
} from './types';
import { getPathPoints, afterMoveStillJiangJun } from './MoveCheck';

export interface PieceState {
  id: number;
  col: number;
  row: number;
  alive: boolean;
}

export interface GameState {
  qiPan: number[][]; // 9x10, -1 表示空位
  pieces: PieceState[]; // 32 个棋子状态
  sideTag: SideTag; // 当前走棋方
  moveHistory: MoveRecord[];
  gameStatus: GameStatus;
  isCheck: boolean; // 当前是否被将军
  checkMessage: string;
  zobristHash: number; // Zobrist 哈希值（用于重复局面检测）
}

/**
 * 创建初始游戏状态
 */
export function createInitialState(firstMoveSide: SideTag = RED_SIDE): GameState {
  const qiPan: number[][] = [];
  for (let i = 0; i < BOARD_COLS; i++) {
    qiPan[i] = [];
    for (let j = 0; j < BOARD_ROWS; j++) {
      qiPan[i][j] = -1;
    }
  }

  const pieces: PieceState[] = [];
  for (let i = 0; i < 32; i++) {
    const col = QIZI_INIT_POSITION[i][0];
    const row = QIZI_INIT_POSITION[i][1];
    pieces.push({ id: i, col, row, alive: true });
    qiPan[col][row] = i;
  }

  const state: GameState = {
    qiPan,
    pieces,
    sideTag: firstMoveSide, // 先手方（默认红先，支持黑先变体）
    moveHistory: [],
    gameStatus: 'playing',
    isCheck: false,
    checkMessage: '',
    zobristHash: 0, // 初始哈希，稍后在调用方通过 computeZobristHash 计算
  };
  return state;
}

/**
 * 深拷贝游戏状态
 */
export function cloneGameState(state: GameState): GameState {
  return {
    qiPan: state.qiPan.map(r => [...r]),
    pieces: state.pieces.map(p => ({ ...p })),
    sideTag: state.sideTag,
    moveHistory: [...state.moveHistory],
    gameStatus: state.gameStatus,
    isCheck: state.isCheck,
    checkMessage: state.checkMessage,
    zobristHash: state.zobristHash,
  };
}

/**
 * 应用让子（在线对局房间设置：红方让车/马/炮）：
 * 将指定棋子从初始局面移除（置为不存活并清空棋盘占位）。
 * 直接原地修改传入的 state（调用方应传入新建/克隆的状态），并原样返回以便链式使用。
 */
export function applyHandicap(state: GameState, handicapIds: number[]): GameState {
  if (!Array.isArray(handicapIds) || handicapIds.length === 0) return state;
  for (const id of handicapIds) {
    const piece = state.pieces[id];
    if (!piece || !piece.alive) continue;
    piece.alive = false;
    if (state.qiPan[piece.col]?.[piece.row] === id) {
      state.qiPan[piece.col][piece.row] = -1;
    }
  }
  return state;
}

/**
 * 获取棋子位置数组（供 MoveCheck 使用）
 */
function toPiecePositions(pieces: PieceState[]) {
  return pieces.map(p => ({ col: p.col, row: p.row, alive: p.alive }));
}

/**
 * 获取指定棋子的合法移动位置
 * 成熟规则：在伪合法走法基础上，过滤走后己方将/帅仍被攻击的走法（含飞将规则）
 */
export function getValidMoves(state: GameState, pieceId: number): boolean[][] {
  if (pieceId < 0 || pieceId > 31) {
    return Array.from({ length: 9 }, () => Array(10).fill(false));
  }
  const piece = state.pieces[pieceId];
  if (!piece.alive) {
    return Array.from({ length: 9 }, () => Array(10).fill(false));
  }

  // 只有走棋方的棋子才能移动
  const pieceSide = pieceId <= 15 ? BLACK_SIDE : RED_SIDE;
  if (pieceSide !== state.sideTag) {
    return Array.from({ length: 9 }, () => Array(10).fill(false));
  }

  const positions = toPiecePositions(state.pieces);
  const points = getPathPoints(pieceId, state.qiPan, positions);

  // 排除自身位置
  points[piece.col][piece.row] = false;

  // 过滤走后己方将/帅仍被攻击（含两将照面）的非法走法
  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 10; r++) {
      if (points[c][r] && afterMoveStillJiangJun(pieceId, piece.col, piece.row, c, r, state.qiPan, positions)) {
        points[c][r] = false;
      }
    }
  }

  return points;
}

/**
 * 检查是否被将军
 * @returns [被将军方(0=黑将,16=红帅,-1=无), 攻击棋子1(-1=无), 攻击棋子2(-1=无)]
 */
export function isJiangJun(state: GameState, jiangOrShuai: number): number[] {
  const result = [-1, -1, -1];
  if (jiangOrShuai !== 0 && jiangOrShuai !== 16) return result;

  const positions = toPiecePositions(state.pieces);

  if (jiangOrShuai === 16) {
    // 检查红帅是否被黑方棋子攻击
    for (let qizi = 5; qizi <= 15; qizi++) {
      if (!state.pieces[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, state.qiPan, positions);
      const x = state.pieces[16].col;
      const y = state.pieces[16].row;
      if (thisPoints[x][y]) {
        result[0] = 16;
        if (result[1] === -1) result[1] = qizi;
        else { result[2] = qizi; return result; }
      }
    }
  }
  if (jiangOrShuai === 0) {
    // 检查黑将是否被红方棋子攻击
    for (let qizi = 21; qizi <= 31; qizi++) {
      if (!state.pieces[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, state.qiPan, positions);
      const x = state.pieces[0].col;
      const y = state.pieces[0].row;
      if (thisPoints[x][y]) {
        result[0] = 0;
        if (result[1] === -1) result[1] = qizi;
        else { result[2] = qizi; return result; }
      }
    }
  }
  return result;
}

/**
 * 检查是否绝杀
 */
/**
 * 检查指定一方是否还存在合法走法
 * 成熟象棋标准算法（参考 Pikafish 等主流引擎）：遍历该方所有棋子的伪合法走法，
 * 过滤走后己方将/帅仍被攻击的走法（含飞将规则），存在任意一条即为有合法走法
 */
export function hasAnyLegalMove(state: GameState, side: SideTag): boolean {
  const positions = toPiecePositions(state.pieces);
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;

  for (let id = start; id < end; id++) {
    const piece = state.pieces[id];
    if (!piece.alive) continue;
    const pathBool = getPathPoints(id, state.qiPan, positions);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (!pathBool[c][r]) continue;
        if (!afterMoveStillJiangJun(id, piece.col, piece.row, c, r, state.qiPan, positions)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 检查是否绝杀（成熟标准算法：被将军方无任何合法走法即为绝杀）
 * 天然覆盖双将、垫将、吃掉攻击子、撤炮架、别脚/塞眼牵制等所有情况
 * @param moveQiZi 刚走完的棋子（用于确定被将军的一方）
 */
export function isJueSha(state: GameState, moveQiZi: number): boolean {
  const checkedSide: SideTag = moveQiZi < 16 ? RED_SIDE : BLACK_SIDE;
  const jiangId = checkedSide === RED_SIDE ? 16 : 0;
  if (isJiangJun(state, jiangId)[0] === -1) return false; // 没有被将军
  return !hasAnyLegalMove(state, checkedSide);
}

/**
 * 检查是否困毙（成熟标准算法：走棋方未被将军且无任何合法走法 → 困毙判负）
 * 注意：中国象棋规则中困毙与将死均判负，与国际象棋的和棋规则不同
 * @param state 游戏状态
 * @param side 走棋方（检查该方是否被困毙）
 */
export function isKunBi(state: GameState, side: SideTag): boolean {
  const jiangId = side === RED_SIDE ? 16 : 0;
  // 被将军而无走法属于绝杀，不属于困毙
  if (isJiangJun(state, jiangId)[0] !== -1) return false;
  return !hasAnyLegalMove(state, side);
}

/**
 * 重复局面规则裁决结果
 */
export interface RepetitionVerdict {
  /** changjiang=长将判负 / changzhuo=长捉(长打)判负 / repetition=双方不变作和 */
  type: 'changjiang' | 'changzhuo' | 'repetition';
  /** 判负方；和棋时为 null */
  loser: SideTag | null;
}

/**
 * 局面指纹：全部存活棋子位置 + 走棋方。
 * 棋子 id 固定对应棋子类型，指纹相同 ⇔ 局面（含走棋方）完全相同。
 */
function positionKey(state: GameState): string {
  let key = '';
  for (let i = 0; i < 32; i++) {
    const p = state.pieces[i];
    if (p.alive) key += `${i}:${p.col}${p.row};`;
  }
  return key + (state.sideTag === RED_SIDE ? 'w' : 'b');
}

/**
 * 原地回退最近一步（重复局面回溯专用，避免 undoMove 的整状态克隆开销）
 */
function undoInPlace(state: GameState): MoveRecord | null {
  const last = state.moveHistory.pop();
  if (!last) return null;
  const piece = state.pieces[last.pieceId];
  state.qiPan[piece.col][piece.row] = -1;
  piece.col = last.fromCol;
  piece.row = last.fromRow;
  state.qiPan[last.fromCol][last.fromRow] = last.pieceId;
  if (last.capturedPieceId !== -1) {
    state.pieces[last.capturedPieceId].alive = true;
  }
  state.sideTag = !state.sideTag;
  return last;
}

/**
 * 攻击图：棋盘各点是否被指定方任一存活棋子攻击（走法生成同源的 getPathPoints，
 * 天然包含吃子点、炮打隔子、兵卒过河横走等规则）。
 * @param excludePieceId 排除某棋子（用于"被保护"判定：不计自身）
 */
function computeAttackMap(state: GameState, side: SideTag, excludePieceId = -1): boolean[][] {
  const map: boolean[][] = Array.from({ length: 9 }, () => Array(10).fill(false));
  const positions = toPiecePositions(state.pieces);
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    if (id === excludePieceId) continue;
    const p = state.pieces[id];
    if (!p.alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (pts[c][r]) map[c][r] = true;
      }
    }
  }
  return map;
}

/**
 * 判定循环内一步棋是否构成「捉」：
 * 非将军着法使对方某个无根（无己方棋子保护）非将棋子受到新的攻击。
 * 循环内着法必为非吃子着法（吃子改变子力，局面不可能重复），故目标子走前走后位置不变。
 * @param before 走前局面
 * @param after  走后局面
 * @param moverSide 走子方
 */
function isChaseMove(before: GameState, after: GameState, moverSide: SideTag): boolean {
  const enemySide: SideTag = !moverSide;
  const atkBefore = computeAttackMap(before, moverSide);
  const atkAfter = computeAttackMap(after, moverSide);
  const enemyStart = enemySide === RED_SIDE ? 16 : 0;
  const enemyEnd = enemySide === RED_SIDE ? 32 : 16;
  for (let id = enemyStart; id < enemyEnd; id++) {
    const p = after.pieces[id];
    if (!p.alive) continue;
    if (id === 0 || id === 16) continue; // 将/帅不作为捉的对象（对其攻击属于"将"）
    if (!atkAfter[p.col][p.row]) continue; // 走后未受攻击
    if (atkBefore[p.col][p.row]) continue; // 走前已被攻击 → 非新产生的捉
    // 有根判定：对方其他任一棋子攻击该子所在点 → 有保护，捉之不成立
    const guard = computeAttackMap(after, enemySide, id);
    if (guard[p.col][p.row]) continue;
    return true;
  }
  return false;
}

/**
 * 重复局面规则裁决（makeMove 应用着法后调用）。
 *
 * 若当前局面在本局历史中第 3 次出现（含当前），取「上一次出现该局面以来」的循环着法，
 * 按中国象棋规则裁决：
 * - 一方循环内每步都在将军 → 该方长将判负；双方互相长将 → 和棋
 * - 否则一方循环内每步都是"打"（将军或捉）→ 该方长捉/长打判负；双方长打 → 和棋
 * - 否则 → 双方不变作和
 *
 * 未达 3 次重复返回 null。相比旧版 isLianSha（仅识别固定 12 步 4 着循环且判负方向错误），
 * 本实现基于局面指纹计数，支持任意长度循环，且判负方归属正确。
 */
export function detectRepetitionVerdict(state: GameState): RepetitionVerdict | null {
  const total = state.moveHistory.length;
  if (total < 4) return null; // 最短循环 2 着，3 次出现至少需 4 着

  const targetKey = positionKey(state);
  const probe = cloneGameState(state);

  // 第一遍：回退计数，找到最近一次同局面（循环长度）与总出现次数
  let occurrences = 1; // 当前局面计 1 次
  let cycleLen = -1;
  for (let i = 1; i <= total; i++) {
    const undone = undoInPlace(probe);
    if (!undone) break;
    // 回退越过吃子着法后，更早局面子力必然与当前不同，不可能重复，提前终止
    if (undone.capturedPieceId !== -1) break;
    // 仅走棋方相同的局面（偶数次回退）才可能构成重复
    if (i % 2 === 1) continue;
    if (positionKey(probe) === targetKey) {
      occurrences++;
      if (occurrences === 2) cycleLen = i;
      if (occurrences >= 3) break;
    }
  }
  if (occurrences < 3 || cycleLen <= 0) return null;

  // 第二遍：重建循环内各节点局面（walk[i] = 从当前回退 i 着后的局面）
  const walk: GameState[] = [cloneGameState(state)];
  const walker = cloneGameState(state);
  for (let i = 1; i <= cycleLen; i++) {
    undoInPlace(walker);
    walk.push(cloneGameState(walker));
  }

  // 循环着法（旧→新）：cycleMoves[j] 走前局面 = walk[cycleLen-j]，走后局面 = walk[cycleLen-j-1]
  const cycleMoves = state.moveHistory.slice(total - cycleLen);
  const flags = {
    [`${RED_SIDE}`]: { allCheck: true, allDa: true, moves: 0 },
    [`${BLACK_SIDE}`]: { allCheck: true, allDa: true, moves: 0 },
  } as Record<string, { allCheck: boolean; allDa: boolean; moves: number }>;

  for (let j = 0; j < cycleLen; j++) {
    const mv = cycleMoves[j];
    const moverSide: SideTag = mv.pieceId <= 15 ? BLACK_SIDE : RED_SIDE;
    const after = walk[cycleLen - j - 1];
    const before = walk[cycleLen - j];
    // 将军判定：走后局面中轮到走棋的一方（对方）是否被将
    const checkedKing = after.sideTag === RED_SIDE ? 16 : 0;
    const givesCheck = isJiangJun(after, checkedKing)[0] !== -1;
    const isChase = !givesCheck && isChaseMove(before, after, moverSide);
    const f = flags[`${moverSide}`];
    f.moves++;
    if (!givesCheck) f.allCheck = false;
    if (!givesCheck && !isChase) f.allDa = false;
  }

  const red = flags[`${RED_SIDE}`];
  const black = flags[`${BLACK_SIDE}`];
  const redCheck = red.moves > 0 && red.allCheck;
  const blackCheck = black.moves > 0 && black.allCheck;
  const redDa = red.moves > 0 && red.allDa;
  const blackDa = black.moves > 0 && black.allDa;

  if (redCheck && blackCheck) return { type: 'repetition', loser: null }; // 互相长将 → 和
  if (redCheck) return { type: 'changjiang', loser: RED_SIDE };
  if (blackCheck) return { type: 'changjiang', loser: BLACK_SIDE };
  if (redDa && blackDa) return { type: 'repetition', loser: null }; // 双方长打 → 和
  if (redDa) return { type: 'changzhuo', loser: RED_SIDE };
  if (blackDa) return { type: 'changzhuo', loser: BLACK_SIDE };
  return { type: 'repetition', loser: null }; // 双方不变作和
}

/**
 * 执行走棋
 * @returns 新的游戏状态，以及走棋信息
 */
export function makeMove(
  state: GameState,
  pieceId: number,
  toCol: number,
  toRow: number
): { newState: GameState; captured: number; isCheck: boolean; isGameOver: boolean; gameOverReason: string } {
  const newState = cloneGameState(state);
  const piece = newState.pieces[pieceId];
  const fromCol = piece.col;
  const fromRow = piece.row;
  const captured = newState.qiPan[toCol][toRow];

  // 更新棋盘
  newState.qiPan[fromCol][fromRow] = -1;
  newState.qiPan[toCol][toRow] = pieceId;

  // 更新棋子位置
  piece.col = toCol;
  piece.row = toRow;

  // 如果被吃子，标记为死亡
  if (captured !== -1) {
    newState.pieces[captured].alive = false;
  }

  // 记录走棋历史
  newState.moveHistory.push({
    pieceId,
    fromCol,
    fromRow,
    toCol,
    toRow,
    capturedPieceId: captured,
  });

  // 切换走棋方
  newState.sideTag = !newState.sideTag;

  // 检查是否被将军
  const checkResult = newState.sideTag === RED_SIDE
    ? isJiangJun(newState, 16)
    : isJiangJun(newState, 0);
  newState.isCheck = checkResult[0] !== -1;
  newState.checkMessage = '';

  // 检查是否绝杀
  let isGameOver = false;
  let gameOverReason = '';

  if (isJueSha(newState, pieceId)) {
    isGameOver = true;
    gameOverReason = 'juesha';
  }

  // 检查是否困毙
  if (!isGameOver && isKunBi(newState, newState.sideTag)) {
    isGameOver = true;
    gameOverReason = 'kunbi';
  }

  // 重复局面规则裁决：长将判负 / 长捉(长打)判负 / 双方不变作和
  let repetitionVerdict: RepetitionVerdict | null = null;
  if (!isGameOver) {
    repetitionVerdict = detectRepetitionVerdict(newState);
    if (repetitionVerdict) {
      isGameOver = true;
      gameOverReason = repetitionVerdict.type;
    }
  }

  // 检查将/帅是否被吃
  if (captured === 0) {
    isGameOver = true;
    gameOverReason = 'red_win';
  }
  if (captured === 16) {
    isGameOver = true;
    gameOverReason = 'black_win';
  }

  if (isGameOver) {
    // gameStatus 仅允许 'playing' | 'red_win' | 'black_win' | 'draw'：
    // 依据终局原因换算出真正的获胜方，避免把 'juesha'/'kunbi' 等展示用原因
    // 强转进 gameStatus 造成类型违约与消费端误判
    if (repetitionVerdict) {
      // 重复局面裁决：判负方明确；无判负方则为和棋（双方不变/互相长将/双方长打）
      newState.gameStatus = repetitionVerdict.loser === null
        ? 'draw'
        : repetitionVerdict.loser === RED_SIDE ? 'black_win' : 'red_win';
    } else {
      const winnerTag = getWinnerSideTagFromReason(newState.sideTag, gameOverReason);
      newState.gameStatus = winnerTag === RED_SIDE ? 'red_win' : 'black_win';
    }
  }

  return {
    newState,
    captured,
    isCheck: newState.isCheck,
    isGameOver,
    gameOverReason,
  };
}

/**
 * 依据终局原因与"新走棋方"换算获胜方
 *
 * 规则语义（makeMove 中 sideTag 已切换为对方）：
 * - juesha/kunbi：刚走棋方获胜 → 获胜方 = 新走棋方的对面
 * - red_win/black_win：直接指明获胜方（将/帅被吃）
 * - changjiang/changzhuo：违规方判负，胜方归属由 detectRepetitionVerdict 的 loser
 *   字段在 makeMove 中直接换算，不经过本函数
 *
 * @param newSideTag makeMove 后已切换的走棋方
 * @param reason     终局原因
 * @returns 获胜方；无法判定时返回红方（调用方仅在终局时使用）
 */
export function getWinnerSideTagFromReason(newSideTag: SideTag, reason: string): SideTag {
  switch (reason) {
    case 'red_win':
      return RED_SIDE;
    case 'black_win':
      return BLACK_SIDE;
    case 'juesha':
    case 'kunbi':
    default:
      return !newSideTag;
  }
}

/**
 * 从终局局面读取获胜方（供 UI/联机同步统一使用，避免各处重复推断出错）。
 * makeMove 已把终局原因换算为合法的 gameStatus（red_win/black_win），此处直接读取。
 * @returns 获胜方；未终局返回 null
 */
export function getWinnerSideTag(state: GameState): SideTag | null {
  if (state.gameStatus === 'red_win') return RED_SIDE;
  if (state.gameStatus === 'black_win') return BLACK_SIDE;
  return null;
}

/**
 * 悔棋
 */
export function undoMove(state: GameState): GameState | null {
  if (state.moveHistory.length === 0) return null;

  const newState = cloneGameState(state);
  const lastMove = newState.moveHistory.pop()!;

  // 恢复棋子位置
  const piece = newState.pieces[lastMove.pieceId];
  piece.col = lastMove.fromCol;
  piece.row = lastMove.fromRow;

  // 恢复棋盘
  newState.qiPan[lastMove.fromCol][lastMove.fromRow] = lastMove.pieceId;
  newState.qiPan[lastMove.toCol][lastMove.toRow] = lastMove.capturedPieceId;

  // 恢复被吃棋子
  if (lastMove.capturedPieceId !== -1) {
    newState.pieces[lastMove.capturedPieceId].alive = true;
  }

  // 切换回走棋方
  newState.sideTag = !newState.sideTag;
  newState.gameStatus = 'playing';
  // 重新计算将军状态：回退后的局面可能本身正处于被将军（如撤销的是解将着法）
  const undoCheck = newState.sideTag === RED_SIDE
    ? isJiangJun(newState, 16)
    : isJiangJun(newState, 0);
  newState.isCheck = undoCheck[0] !== -1;
  newState.checkMessage = '';

  return newState;
}

/**
 * 从 FEN 字符串创建游戏状态
 */
export function createFromFen(fen: string): GameState {
  const FEN_CHARS = [
    'k', 'a', 'a', 'b', 'b', 'n', 'n', 'r', 'r', 'c', 'c', 'p', 'p', 'p', 'p', 'p',
    'K', 'A', 'A', 'B', 'B', 'N', 'N', 'R', 'R', 'C', 'C', 'P', 'P', 'P', 'P', 'P',
  ];

  const qiPan: number[][] = [];
  for (let i = 0; i < BOARD_COLS; i++) {
    qiPan[i] = [];
    for (let j = 0; j < BOARD_ROWS; j++) {
      qiPan[i][j] = -1;
    }
  }

  const pieces: PieceState[] = [];
  for (let i = 0; i < 32; i++) {
    pieces.push({ id: i, col: -1, row: -1, alive: false });
  }

  const fenParts = fen.split(' ');
  const boardStr = fenParts[0];
  let col = 0;
  let row = 0;
  const usedFen = [...FEN_CHARS];

  for (const c of boardStr) {
    if (c === '/') {
      row++;
      col = 0;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const num = parseInt(c);
      for (let n = 0; n < num; n++) {
        qiPan[col][row] = -1;
        col++;
      }
    } else {
      const idx = usedFen.indexOf(c);
      if (idx !== -1) {
        qiPan[col][row] = idx;
        pieces[idx].col = col;
        pieces[idx].row = row;
        pieces[idx].alive = true;
        usedFen[idx] = '';
      }
      col++;
    }
  }

  const sideTag = fenParts[1] === 'b' ? BLACK_SIDE : RED_SIDE;

  const state: GameState = {
    qiPan,
    pieces,
    sideTag,
    moveHistory: [],
    gameStatus: 'playing',
    isCheck: false,
    checkMessage: '',
    zobristHash: 0, // 初始哈希，稍后在调用方通过 computeZobristHash 计算
  };
  return state;
}

/**
 * 将游戏状态转换为 FEN 字符串
 */
export function toFenString(state: GameState): string {
  const FEN_CHARS = [
    'k', 'a', 'a', 'b', 'b', 'n', 'n', 'r', 'r', 'c', 'c', 'p', 'p', 'p', 'p', 'p',
    'K', 'A', 'A', 'B', 'B', 'N', 'N', 'R', 'R', 'C', 'C', 'P', 'P', 'P', 'P', 'P',
  ];

  let output = '';
  for (let i = 0; i < 10; i++) {
    let lineStr = '';
    let spaceNum = 0;
    for (let j = 0; j < 9; j++) {
      const qz = state.qiPan[j][i];
      if (qz === -1) {
        spaceNum++;
      } else {
        if (spaceNum > 0) {
          lineStr += spaceNum.toString();
          spaceNum = 0;
        }
        lineStr += FEN_CHARS[qz];
      }
    }
    if (spaceNum > 0) lineStr += spaceNum.toString();
    output += lineStr;
    if (i < 9) output += '/';
  }

  output += state.sideTag === BLACK_SIDE ? ' b' : ' w';
  return output;
}

/** 内部坐标 → UCI 坐标（如 (2,1) → c8） */
function toUci(col: number, row: number): string {
  return `${String.fromCharCode(97 + col)}${9 - row}`;
}

/**
 * 构建完整对局历史（供在线引擎感知重复局面规则）。
 *
 * 通过原地回退全部已走着法还原「本局起始局面」，再把 moveHistory 逐着换算为
 * UCI 序列。服务端收到 (startFen, moves) 后以 `position fen startFen moves ...`
 * 设置局面，引擎即可在搜索中识别本局真实出现的重复局面（长将/长捉/不变循环）。
 *
 * 注意：回退在克隆体上进行，不修改传入状态。
 */
export function buildEngineHistory(state: GameState): { startFen: string; moves: string[] } {
  const probe = cloneGameState(state);
  while (probe.moveHistory.length > 0) {
    undoInPlace(probe);
  }
  const startFen = toFenString(probe);
  const moves = state.moveHistory.map((mv: MoveRecord) =>
    `${toUci(mv.fromCol, mv.fromRow)}${toUci(mv.toCol, mv.toRow)}`
  );
  return { startFen, moves };
}
