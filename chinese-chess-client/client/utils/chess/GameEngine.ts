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
 * 也让"落点为什么点不动"由落子阶段给出明确原因（见 isMoveKingSafe）。
 *
 * ⚠️ 本函数只回答「这个点符不符合棋子的走法」，**不代表这步棋可以走**：
 * 走后己方将/帅仍被攻击（送将/照面）的着法在这里仍是 true，必须由落子阶段
 * 用 isMoveKingSafe 拦截。四类送将（暴露阻挡、被牵制子、将帅照面、走将入攻击格）
 * 的实际拦截点见 screens/game 与 screens/lanBattle 的 executeMove。
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
 * 判断一手棋是否「走后己方将/帅仍被攻击」——即送将（含将帅照面/白脸将）。
 *
 * ============================================================================
 * 【为什么需要这个判据 · 2026-09 线上事故】
 *
 * 送将在任何象棋规则下都是**非法着法**（等同于把己方将帅送给对方吃），
 * 但 4ccdae5「合法落点不做王安全过滤」之后，它变成了一步"能走"的棋：
 *   · 本地引擎会照常走完并切换走棋方，盘面上留下一个「正被攻击却无人应招」的将/帅；
 *   · 服务端 Pikafish **永远不会去吃将/帅**。实测（hint，depth 8）5/5 局面都是
 *     对方将/帅就摆在一步可吃的位置，引擎仍去走别的着法（如红车 (4,5) 面对
 *     黑将 (4,0) 却返回 (4,5)->(4,8)）。原因是象棋引擎的合法着法生成本就
 *     不含"吃将"，它把被将视作己方要承担的代价、而不是可以收割的战利品。
 *   · 于是「送将 → 对方杀将终结」这条依赖对方配合的收尾路径并不成立，
 *     对局会停在一个非法局面里：双方把将/帅晾在盘上，绝杀/困毙判据
 *     （isJueSha / isKunBi 都基于 hasAnyLegalMove，而对方走法充足）也不会触发。
 *
 * 因此送将必须在**落子阶段**拦掉，而不是指望"对方走一步就终局"。
 * 该判据直接复用 afterMoveStillJiangJun —— 与 hasAnyLegalMove / isJueSha /
 * isKunBi 以及 AIEngine 的 isSideInCheck 完全同一口径，保证：
 *   盘上永远不会出现"该方被将且轮到该方"的局面，绝杀/困毙判定与引擎搜索一致，
 *   在线引擎也不会再收到它拒绝重放的历史（见 buildEngineHistory）。
 *
 * 四类必须拦截的情况（均有单测覆盖，见 __tests__/songjiang.test.ts）：
 *   1. 暴露阻挡：移开挡在己方将/帅与敌子之间的子（discovered check）；
 *   2. 被牵制子：钉子（pinned piece）离开线路；
 *   3. 将帅照面：移开两将/帅之间的唯一阻挡子（飞将/白脸将）；
 *   4. 走将入攻击格：将/帅自己走进敌子控制范围。
 *
 * @returns true = 该着法安全（合法）；false = 送将，必须拦截
 * ============================================================================
 */
export function isMoveKingSafe(
  state: GameState,
  pieceId: number,
  toCol: number,
  toRow: number
): boolean {
  const piece = state.pieces[pieceId];
  if (!piece || !piece.alive) return false;
  return !afterMoveStillJiangJun(
    pieceId,
    piece.col,
    piece.row,
    toCol,
    toRow,
    state.qiPan,
    toPiecePositions(state.pieces)
  );
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
 * 【R-10 · 原注释此处曾写"引擎语义下走完造成照面的着法是合法的
 * （实测走完后 isJiangJun=false、hasAnyLegalMove=true）"，是错的，已改】
 * 照面着法在全仓一律按**非法**处理并被拦下：
 *   · MoveCheck.ts afterMoveStillJiangJun 的飞将段判 true；
 *   · GameEngine.ts hasAnyLegalMove / isMoveKingSafe 据此不认；
 *   · 服务端 ruleEngine.bundle.ts 的 getValidMoves 逐点 isMoveKingSafe 过滤掉；
 *   · songjiang.test.ts 与 ruleEngineParity.test.ts 各有用例钉死。
 * 原文那句"hasAnyLegalMove=true"只在"照面着法**已经落盘之后**、轮到这个局面的人
 * 重新求着法"时才成立，与"这着着法本身合法"是两回事 —— 照面段属于
 * afterMoveStillJiangJun，不属于本函数。
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

  // 【R-2 · P0 崩溃防护】被查的将/帅必须"在盘上"：createFromFen 对缺席子初始化
  // { col: -1, row: -1, alive: false }，而下面用 col/row 去索引 thisPoints[x][y]
  // 会变成 thisPoints[-1][-1] → TypeError: Cannot read properties of undefined。
  // 畸形/缺将的残局 FEN（如 '4k4/9/9/9/4r4/9/9/9/9/9 w'）只要走到这里就会崩。
  // 缺将局面没有"被将军"的语义，直接按未被将处理。
  const target = state.pieces[jiangOrShuai];
  if (!target || !target.alive) return result;
  if (target.col < 0 || target.col >= BOARD_COLS || target.row < 0 || target.row >= BOARD_ROWS) {
    return result;
  }

  const positions = toPiecePositions(state.pieces);

  if (jiangOrShuai === 16) {
    // 检查红帅是否被黑方棋子攻击
    for (let qizi = 5; qizi <= 15; qizi++) {
      if (!state.pieces[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, state.qiPan, positions);
      const x = target.col;
      const y = target.row;
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
      const x = target.col;
      const y = target.row;
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
 * 指定一方是否还有**合法**着法（走后己方将/帅不被攻击）。
 *
 * 与 isMoveKingSafe 同一判据（都基于 afterMoveStillJiangJun），因此：
 *   hasAnyLegalMoveForSide(state, side) === false
 *   等价于「该方无论走哪一步都会送将」，即该方已被将死或困毙——
 *   中国象棋两者均判负。
 *
 * 用途：超时兜底着法选择（screens/lanBattle 的 doRandomMove）需要先确认
 * 「真的还有不送将的棋可走」再随机；否则应直接判负，绝不能退回"随便走一步"
 * ——那一步必然是送将，会把局面重新拖回非法状态。
 */
export function hasAnyLegalMoveForSide(state: GameState, side: SideTag): boolean {
  return hasAnyLegalMove(state, side);
}

/**
 * 原地回退最近一步（历史回溯专用，避免 undoMove 的整状态克隆开销）
 *
 * ⚠️ 正确性要点（曾导致在线 AI 全程回落本地 AI，见 buildEngineHistory 的说明）：
 * 1. 清空落点必须用**着法记录的坐标**（toCol/toRow），不能用棋子当前坐标 —— 棋子当前坐标
 *    在历史回溯过程中可能已被后续着法改写，用它清格会误清此刻正放着别的活子的格子。
 * 2. 被吃子必须**放回落点并登记到 qiPan**。只恢复 alive 而不放回，会留下一枚
 *    「alive=true 但不在棋盘上」的悬空子：它既不出现在 toFenString 里（表现为棋子凭空消失），
 *    又会让后续回退在错误坐标上清格。
 * 两点共同保证来回任意次数，回退得到的局面与按同一序列正向走出来的局面完全一致。
 */
function undoInPlace(state: GameState): MoveRecord | null {
  const last = state.moveHistory.pop();
  if (!last) return null;

  // 1. 用记录坐标清空落点（不用 piece.col/row）
  state.qiPan[last.toCol][last.toRow] = -1;

  // 2. 恢复移动子到起点
  const piece = state.pieces[last.pieceId];
  piece.col = last.fromCol;
  piece.row = last.fromRow;
  state.qiPan[last.fromCol][last.fromRow] = last.pieceId;

  // 3. 被吃子放回落点并登记到棋盘（只置 alive 会留下悬空子）
  if (last.capturedPieceId !== -1) {
    const captured = state.pieces[last.capturedPieceId];
    captured.alive = true;
    captured.col = last.toCol;
    captured.row = last.toRow;
    state.qiPan[last.toCol][last.toRow] = captured.id;
  }

  state.sideTag = !state.sideTag;
  return last;
}

/**
 * 棋盘一致性自检：qiPan 与 pieces[].alive/坐标是否严格互相对应。
 *
 * 用于 buildEngineHistory 回退后的兜底校验——只要存在以下任一情况就判定不自洽：
 * - qiPan 上登记了一个不存在的子、或已死亡的子；
 * - qiPan 上的坐标与该子记录的坐标不一致；
 * - 某个活子在它自己声明的坐标上不是棋盘登记的子（即"悬空活子"）。
 * 返回不一致的描述列表（空数组 = 一致）。
 */
export function auditBoardConsistency(state: GameState): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();

  for (let col = 0; col < BOARD_COLS; col++) {
    for (let row = 0; row < BOARD_ROWS; row++) {
      const id = state.qiPan[col]?.[row];
      if (id === undefined || id === -1) continue;
      const piece = state.pieces[id];
      if (!piece) {
        problems.push(`qiPan@(${col},${row})=${id}：不存在此子`);
        continue;
      }
      if (!piece.alive) {
        problems.push(`qiPan@(${col},${row})=${id}：该子已死亡却仍在棋盘上`);
        continue;
      }
      if (piece.col !== col || piece.row !== row) {
        problems.push(`qiPan@(${col},${row})=${id}：该子记录坐标为 (${piece.col},${piece.row})`);
        continue;
      }
      if (seen.has(id)) {
        problems.push(`棋子 ${id}：在棋盘上出现了多次`);
      }
      seen.add(id);
    }
  }

  for (const piece of state.pieces) {
    if (!piece || !piece.alive) continue;
    if (piece.col < 0 || piece.row < 0) {
      problems.push(`棋子 ${piece.id}：alive 但没有合法坐标 (${piece.col},${piece.row})`);
      continue;
    }
    if (state.qiPan[piece.col]?.[piece.row] !== piece.id) {
      problems.push(`棋子 ${piece.id}：alive 于 (${piece.col},${piece.row}) 但棋盘该格登记的是 ${state.qiPan[piece.col]?.[piece.row]}`);
    }
  }

  return problems;
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

  // 【R-1 · P0 崩溃防护】下面两处 `qiPan[col][row]` 只在「行宽恰为 9、行数恰为 10」时
  // 才安全（qiPan 外层按 BOARD_COLS 建、内层按 BOARD_ROWS 建，越界后写的是 undefined，
  // 直接抛 `TypeError: Cannot set properties of undefined`）。畸形 FEN（'9k8/…' 之类
  // 行宽越界、或行数不足/超出）会让 col 冲到 9 或 row 冲到 10 而崩，故先做一次整体校验：
  //   · 不合法 → 直接返回「全空 + 红先」的初始状态，不抛异常（大量调用方没有 try/catch）。
  //     这里选择退化而不是抛错，是为了与既有「非法字符被静默跳过」的行为保持一致，
  //     调用方若要区分，请自行先调 isFenBoardWidthValid 预检。
  //   · 合法   → 逐字符解析，此时 col/row 天然落在 [0,9) / [0,10) 内。
  // 该校验此前只有 aiDispatcher.ts:349（发往服务端前自检）一个调用方，
  // 引擎自身入口不自检 —— 任何把外部 FEN 直接喂进 createFromFen 的路径都会崩。
  if (!isFenBoardWidthValid(boardStr)) {
    return {
      qiPan,
      pieces,
      sideTag: fenParts[1] === 'b' ? BLACK_SIDE : RED_SIDE,
      moveHistory: [],
      gameStatus: 'playing',
      isCheck: false,
      checkMessage: '',
      zobristHash: 0,
    };
  }

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

/**
 * 校验 FEN 棋盘段的每一行是否恰好 9 列。
 *
 * 防御性：服务端把 FEN 直接交给皮卡鱼 WASM，行宽异常（多/少于一列）会让引擎
 * 写出越界内存并报 `memory access out of bounds`，把整个 worker 池打崩
 * （/api/v1/ai/stats 的 ready 从 4 掉到 3，后续请求 500）。客户端在发出前
 * 自检，宁可本地报错也不要拖垮服务端。
 */
export function isFenBoardWidthValid(fen: string): boolean {
  const board = fen.trim().split(/\s+/)[0];
  if (!board) return false;
  const rows = board.split('/');
  if (rows.length !== 10) return false;
  return rows.every((row) => {
    let width = 0;
    for (const ch of row) {
      if (ch >= '0' && ch <= '9') {
        const n = Number(ch);
        if (n === 0) return false; // '0' 是空位数 0，非法写法
        width += n;
      } else if (/[a-z]/i.test(ch)) {
        width += 1;
      } else {
        return false; // 出现非棋子、非数字字符
      }
      if (width > 9) return false;
    }
    return width === 9;
  });
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
 * ⚠️ 关键前提：**服务端在 moves 非空时会完全忽略请求里的 fen**（见
 * chinese-chess-server/ai/pikafishWorker.cjs 的 position 命令组装），只按
 * `startFen + moves` 重建局面。因此 startFen/moves 只要有一处不准，引擎就会在
 * 另一个局面里搜索，返回的走法在真实局面里非法，被调度器的本地守卫静默拒掉，
 * 表现为"明明网络正常却一直走本地 AI"。
 *
 * 兜底（两层）：
 *  1. auditBoardConsistency：回退得到的棋盘必须与棋子数组严格对应，
 *     防 undoInPlace 之类的回退 bug 复发（曾导致凭空少子、服务端在错局面搜索）。
 *     不过则直接返回 null（连"从当前局面重放"都不可信）。
 *  2. buildReplayableSegment：历史必须能被引擎逐步重放，防「自将/照面」口径不一致
 *     导致引擎把棋盘停在半路（见该函数说明）。引擎一旦在某一步 K 拒绝应用，该步
 *     **及其后所有步**都不能再发——服务端是顺序重放，断了就全废。此时不整条丢弃，
 *     而是**保留最长的"引擎可重放后缀"**：startFen 换成走完第 K 手后的局面、
 *     moves 只发其后半段，保住最近一段的重复局面感知。断点落在最后一手时才返回
 *     null，调用方据此**只发 fen、不发历史**。
 *
 * 注意：回退在克隆体上进行，不修改传入状态。
 */
export function buildEngineHistory(state: GameState): { startFen: string; moves: string[] } | null {
  const probe = cloneGameState(state);
  while (probe.moveHistory.length > 0) {
    undoInPlace(probe);
  }
  // 兜底 1：回退得到的棋盘必须与棋子数组严格对应（防 undoInPlace 类回退 bug 复发）
  const boardProblems = auditBoardConsistency(probe);
  if (boardProblems.length > 0) {
    console.warn(
      `[buildEngineHistory] 回退局面自检失败，降级为只发 fen（${boardProblems.length} 处不一致）：${boardProblems[0]}`
    );
    return null;
  }
  if (state.moveHistory.length === 0) {
    return { startFen: toFenString(probe), moves: [] };
  }
  return buildReplayableSegment(probe, state.moveHistory);
}

/**
 * 从历史起点逐步重放，求「最长的引擎可重放片段」并组装在线引擎请求载荷。
 *
 * ⚠️ 这是「明明网络正常却全程走本地 AI」的**第二根因**（第一根因是 undoInPlace 的
 * 回退缺陷，已修）。机制如下：
 *
 * 客户端的走法生成 `getSelectableMoves` **故意不过滤**「走完后己方将/帅仍被攻击
 * （含照面/飞将段）」——这是产品语义（允许玩家主动送将、照面），见本文件 isJiangJun
 * 上方注释与 MoveCheck.afterMoveStillJiangJun 注释。而皮卡鱼的
 * `position fen <startFen> moves ...` 重放**会**过滤这条：一旦某步走完己方仍被将，
 * 引擎就拒绝应用该步，棋盘永远停在上一步（K-1）。于是：
 *   · 后续所有着法都在错误局面上产生 → 客户端本地守卫（isOnlineMoveLegal /
 *     isOnlineMoveRuleSafe）逐条静默拒掉 → 每步都回落本地 AI；
 *   · 这类失败被记为 OnlineAiInvalidMoveError，**既不熔断也不重试**，
 *     getOnlineAiStatus() 仍返回 'online'，用户只看到「一直本地AI」而没有「重连中」。
 *
 * 实测（_review/probe_pikafish_selfcheck.cjs，12/12 断点，且引擎 `go perft 1`
 * 均不收录该着法）：每个断点都恰好是「走完该步后己方仍被将」；在生成对局时加上
 * 同一过滤后（_review/probe_pikafish_hypothesis.cjs，20/20 局）引擎全程一致。
 *
 * 判据直接复用 `hasAnyLegalMove` 的底层函数 `afterMoveStillJiangJun`，在**发出请求前**
 * 判定历史是否引擎可重放。
 *
 * 降级策略：引擎在第 K 步拒绝应用时，该步**及其后所有步**都不能发（服务端顺序重放，
 * 断一处后面全废）。此时不整条丢弃，而是把 startFen 换成「客户端走完第 K 手后的局面」、
 * moves 只发 K+1 之后的后缀，保住最近一段的重复局面感知。只有当断点落在最后一手
 * （没有可用后缀）时，才彻底降级为只发 fen（返回 null）。
 */
function buildReplayableSegment(
  start: GameState,
  all: MoveRecord[]
): { startFen: string; moves: string[] } | null {
  const uciOf = (mv: MoveRecord) => `${toUci(mv.fromCol, mv.fromRow)}${toUci(mv.toCol, mv.toRow)}`;

  // 逐手重放，记录**最后一个**引擎会拒绝的步号 lastBad。
  // 必须取最后一个而不是第一个：引擎在第 K 步停下后，K 之后所有着法都是在错局面上
  // 产生的，若只记第一个就照样会断在中途（实测在线率从 100% 掉到 68%）。
  let cur = start;
  let lastBad = -1;
  let reason = '';
  let fenAfterLastBad: string | null = null;
  let broken = false;

  for (let i = 0; i < all.length; i++) {
    // 将/帅已被吃掉的局面无法重放（isJiangJun 会读到 col/row = -1 而越界）。
    // 正常对局在绝杀/困毙时即结束走子流程，走不到这里；此处仅作防御性短路。
    if (!cur.pieces[0].alive || !cur.pieces[16].alive) {
      console.warn(
        `[buildEngineHistory] 第 ${i} 步之前将/帅已被吃掉，历史无法重放，降级为只发 fen`
      );
      return null;
    }
    const mv = all[i];
    if (broken) break;
    const piece = cur.pieces[mv.pieceId];
    if (!piece || !piece.alive) {
      // 起始子不存在/已死：无法确定这一步之后的局面，放弃后缀方案
      lastBad = i;
      reason = '起始子不存在或已死';
      fenAfterLastBad = null;
      break;
    }
    if (afterMoveStillJiangJun(
      mv.pieceId, mv.fromCol, mv.fromRow, mv.toCol, mv.toRow,
      cur.qiPan, toPiecePositions(cur.pieces)
    )) {
      lastBad = i;
      reason = '走完后己方将/帅仍被攻击（含照面），引擎会拒绝重放该步';
    }
    const res = makeMove(cur, mv.pieceId, mv.toCol, mv.toRow);
    if (!res || !res.newState) {
      if (lastBad < 0) { lastBad = i; reason = '客户端引擎也不接受该步'; }
      fenAfterLastBad = null;
      broken = true;
      break;
    }
    cur = res.newState;
    if (lastBad === i) fenAfterLastBad = toFenString(cur);
  }

  if (lastBad < 0) {
    return { startFen: toFenString(start), moves: all.map(uciOf) };
  }

  const tailStart = lastBad + 1;
  if (fenAfterLastBad === null || tailStart >= all.length) {
    console.warn(
      `[buildEngineHistory] 第 ${lastBad} 步（${uciOf(all[lastBad])}）无法被在线引擎重放且无可用后缀，` +
      `降级为只发 fen：${reason}`
    );
    return null;
  }
  const tail = all.slice(tailStart);
  console.warn(
    `[buildEngineHistory] 第 ${lastBad} 步（${uciOf(all[lastBad])}）无法被在线引擎重放：${reason}；` +
    `改发其后 ${tail.length} 步，保留最近一段重复局面感知`
  );
  return { startFen: fenAfterLastBad, moves: tail.map(uciOf) };
}
