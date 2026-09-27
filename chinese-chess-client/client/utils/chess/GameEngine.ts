/**
 * 中国象棋游戏引擎
 * 管理游戏状态、走棋逻辑、将军/绝杀判定
 */

import {
  QIZI_INIT_POSITION, BOARD_COLS, BOARD_ROWS, RED_SIDE, BLACK_SIDE,
  type SideTag, type MoveRecord, type GameStatus,
  type GameState, type PieceState,
} from './types';
import { getPathPoints, afterMoveStillJiangJun } from './MoveCheck';
import {
  evaluateRuleAfterMove, recomputeRuleState, cloneRuleState,
} from './RuleEngine';

// 类型已下沉至 types.ts（避免与 RuleEngine 循环依赖），此处 re-export 保持既有引用兼容
export type { GameState, PieceState } from './types';

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
    ruleState: state.ruleState ? cloneRuleState(state.ruleState) : undefined,
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
 * 获取指定棋子的可选落点（仅按棋子自身走法判定）
 *
 * 规则口径：车马炮的阻挡、象的塞眼、兵的过河、将帅的九宫、士的斜线等，全部走 MoveCheck 的
 * 棋子级走法；**不做**"走后己方将/帅仍被攻击（含飞将/白脸将）"的王安全过滤。
 * 因此被将军时玩家仍能看到该棋子全部走点，既避免了只剩应将点的"变相提示"，
 * 也允许玩家主动送出将/帅（送将后由对方走完一步即算终局，风险自负）。
 *
 * 走子方限制仍然保留：非当前走棋方的棋子不返回落点（界面本就只允许选己方棋子）。
 */
export function getSelectableMoves(state: GameState, pieceId: number): boolean[][] {
  const empty = () => Array.from({ length: BOARD_COLS }, () => Array(BOARD_ROWS).fill(false));
  if (pieceId < 0 || pieceId > 31) return empty();
  const piece = state.pieces[pieceId];
  if (!piece.alive) return empty();

  // 只有走棋方的棋子才能移动
  const pieceSide = pieceId <= 15 ? BLACK_SIDE : RED_SIDE;
  if (pieceSide !== state.sideTag) return empty();

  const points = getPathPoints(pieceId, state.qiPan, toPiecePositions(state.pieces));
  // 排除自身位置
  points[piece.col][piece.row] = false;
  return points;
}

/**
 * 获取指定棋子的可落点（走法裁决口径，与 getSelectableMoves 同一套规则）
 *
 * 成熟规则：仅按棋子自身走法判定（车马炮阻挡、象眼、兵过河等），不过滤"走后己方被将军"。
 * 本函数是走子执行 / AI 走法 / 服务端校验的唯一口径，getValidMoves 与 getSelectableMoves
 * 的返回值始终一致——保留 getValidMoves 这个名字只为兼容既有调用点与 ruleEngine.cjs 导出。
 */
export function getValidMoves(state: GameState, pieceId: number): boolean[][] {
  return getSelectableMoves(state, pieceId);
}

/**
 * 检查是否被将军（走子**前**的局面）
 * @returns [被将军方(0=黑将,16=红帅,-1=无), 攻击棋子1(-1=无), 攻击棋子2(-1=无)]
 *
 * ============================================================================
 * 【唯一真源 / SINGLE SOURCE OF TRUTH】与 afterMoveStillJiangJun 同属三端
 * （UI / AI 引擎 / 服务端裁决）合法着法判定的唯一真源。
 * 任何修改必须同步三端，并跑 node _review/probe_diff_head.cjs 验证：
 * 「消失的可选点」为 0、「合法着法指纹差异」为 0、「终局判定差异」为 0。
 * 服务端产物 chinese-chess-server/ruleEngine.cjs 由
 * client/utils/chess/ruleEngine.bundle.ts 经 esbuild 重新打包生成，勿手改。
 *
 * 【特别注意 · 不得当作 bug 修掉的语义】本函数**不检查将帅照面**。
 * 下方两个循环只扫 5..15（红子，攻击红帅 16）与 21..31（黑子，攻击黑将 0）
 * 这些非将子，敌方将/帅不在扫描区间内 —— 所以"将帅照面"在这里不算被将军。
 * 照面由 afterMoveStillJiangJun 的飞将段单独判定（走子后），或由 AIEngine 的
 * areGeneralsFacing 判定。切勿在重构成统一走法生成函数时把照面并入本函数：
 * 引擎语义下"走完造成照面"的着法是**合法**的（实测走完后 isJiangJun=false、
 * hasAnyLegalMove=true），并进去会让一批合法着法凭空消失。
 *
 * 与 afterMoveStillJiangJun 的分工：
 *   · 本函数  = 静态判据，回答"当前这个局面谁在被将"。
 *   · after…  = 动态判据，回答"假设走了这步，己方是否还会被将"（含飞将段）。
 * AI 引擎的 isSideInCheck / isGeneralAttacked 必须同时覆盖这两段语义。
 * ============================================================================
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
 * 原地回退最近一步（历史回溯专用，避免 undoMove 的整状态克隆开销）
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

  // 长将长捉规则引擎（计数/禁着/判和判负，见 RuleEngine）：
  // 绝杀/困毙优先（方案 13：最后一步将死时其他阈值已到也判胜不判和）
  const ruleEvaluation = evaluateRuleAfterMove(state, newState, { pieceId, captured });
  newState.ruleState = ruleEvaluation.ruleState;
  if (!isGameOver && ruleEvaluation.gameOver) {
    isGameOver = true;
    gameOverReason = ruleEvaluation.gameOverReason;
    // 判负方明确 → 对方胜；无判负方 → 和棋
    newState.gameStatus = ruleEvaluation.loser === null
      ? 'draw'
      : ruleEvaluation.loser === RED_SIDE ? 'black_win' : 'red_win';
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

  if (isGameOver && newState.gameStatus === 'playing') {
    // gameStatus 仅允许 'playing' | 'red_win' | 'black_win' | 'draw'：
    // 依据终局原因换算出真正的获胜方，避免把 'juesha'/'kunbi' 等展示用原因
    // 强转进 gameStatus 造成类型违约与消费端误判
    const winnerTag = getWinnerSideTagFromReason(newState.sideTag, gameOverReason);
    newState.gameStatus = winnerTag === RED_SIDE ? 'red_win' : 'black_win';
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

  // 规则状态与回退后的 moveHistory 不再对应 → 从起点全量重放重建
  // （长将/长捉计数、禁着列表、自然限招窗口等全部恢复正确，方案 15.6）
  return recomputeRuleState(newState);
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
