/**
 * 揭棋 · 变体隔离铁闸（jieqiVariantIsolation）
 *
 * ============================================================================
 * 【本文件是整个揭棋改造最重要的一道闸】
 *
 * 揭棋是**加法式**改造：所有新逻辑都必须挂在 `variant === 'jieqi'` 分支里，
 * 象棋（含残局、人机、在线对局、复盘、存档）的行为必须**逐字节不变**。
 * 一旦某个 `getPathPoints(...)` 的调用点漏传第四参数、或者某个
 * `afterMoveStillJiangJun(...)` 漏传第七参数，象棋的合法着法集合就会静默改变，
 * 而这种改动在单元测试里"看起来只是多/少一个可选点"，很难一眼归因。
 *
 * 所以本文件不用"断言某个具体走点"的方式（太脆），而是**对同一批局面做
 * 两种运行的对拍**：
 *   · 真实实现（已接入揭棋分支）
 *   · 朴素实现（手工回退到象棋语义的独立计算）
 * 两者必须对同一批局面的**每一个格子**给出完全一致的走点/合法性判定。
 *
 * 覆盖面：初始局面 + 随机对弈采样的中局 + 揭棋中局（对照组，验证开关确实生效）。
 * ============================================================================
 */

import {
  createInitialState, getValidMoves, getSelectableMoves, isMoveKingSafe,
  isJiangJun, hasAnyLegalMove, makeMove, cloneGameState, toFenString,
} from '../GameEngine';
import { getPathPoints, afterMoveStillJiangJun } from '../MoveCheck';
import { positionKey, enumerateLegalMoves } from '../RuleEngine';
import { createJieqiInitialState, makeSeededRand, isJieqi } from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

/** 朴素走点计算：完全照抄象棋语义，第四参数一律不传 */
function naivePoints(state: GameState, id: number): boolean[][] {
  return getPathPoints(id, state.qiPan, state.pieces.map(p => ({ col: p.col, row: p.row, alive: p.alive })));
}

/**
 * 朴素版「棋子自身走法」参照：与 getSelectableMoves 同口径。
 *
 * ⚠️ 踩过的坑：直接拿 `getPathPoints` 当参照是不对的 —— getSelectableMoves
 * 会先做**走子方限制**（非走棋方的子返回全空），而 getPathPoints 不会。
 * 于是黑将 0 在红先局面下，用 getPathPoints 算出 4 个点、用 getValidMoves
 * 算出 0 个点，对拍立刻误报"象棋被污染"。参照系必须与被测函数同口径。
 */
function naiveSelectable(state: GameState, id: number): boolean[][] {
  const empty = () => Array.from({ length: BOARD_COLS }, () => new Array<boolean>(BOARD_ROWS).fill(false));
  const piece = state.pieces[id];
  if (!piece || !piece.alive) return empty();
  if (piece.col < 0 || piece.col >= BOARD_COLS || piece.row < 0 || piece.row >= BOARD_ROWS) return empty();
  const pieceSide = id <= 15 ? BLACK_SIDE : RED_SIDE;
  if (pieceSide !== state.sideTag) return empty();
  const points = naivePoints(state, id);
  points[piece.col][piece.row] = false;
  return points;
}

/** 朴素送将判定：第七参数一律不传 */
function naiveStillCheck(state: GameState, id: number, c: number, r: number): boolean {
  const p = state.pieces[id];
  return afterMoveStillJiangJun(id, p.col, p.row, c, r, state.qiPan, state.pieces.map(x => ({ col: x.col, row: x.row, alive: x.alive })));
}

/** 对拍：象棋局面在每一格上的走点与合法性必须与朴素实现完全一致 */
function assertXiangqiUnchanged(state: GameState, label: string): void {
  for (let id = 0; id < 32; id++) {
    const piece = state.pieces[id];
    if (!piece.alive) continue;
    if (piece.col < 0 || piece.col >= BOARD_COLS || piece.row < 0 || piece.row >= BOARD_ROWS) continue;

    // ① 走点必须与朴素实现一致（用同口径的 naiveSelectable，见其注释）
    const real = getValidMoves(state, id);
    const naive = naiveSelectable(state, id);
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (real[c][r] !== naive[c][r]) {
          throw new Error(`${label}: 棋子 ${id} 走点 (${c},${r}) 变了 —— 象棋行为被污染\n  真实=${real[c][r]} 朴素=${naive[c][r]}`);
        }
      }
    }

    // ② 每个走点的送将判定必须与朴素一致
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (!naive[c][r]) continue;
        const realSafe = isMoveKingSafe(state, id, c, r);
        const naiveSafe = !naiveStillCheck(state, id, c, r);
        if (realSafe !== naiveSafe) {
          throw new Error(`${label}: 棋子 ${id} 落点 (${c},${r}) 合法性变了 —— 象棋行为被污染\n  真实=${realSafe} 朴素=${naiveSafe}`);
        }
      }
    }
  }

  // ③ 指纹必须不含揭棋后缀
  const key = positionKey(state);
  if (key.includes('|h')) {
    throw new Error(`${label}: 象棋局面指纹混入了暗子位图后缀：${key}`);
  }

  // ④ 不得把暗子误判为攻击者（象棋没有暗子，判定应与朴素扫描一致）
  for (const kingId of [0, 16]) {
    const real = isJiangJun(state, kingId);
    const king = state.pieces[kingId];
    if (!king.alive) continue;
    let naive = false;
    const start = kingId === 16 ? 5 : 21;
    const end = kingId === 16 ? 16 : 32;
    for (let id = start; id < end; id++) {
      if (!state.pieces[id].alive) continue;
      const pts = naivePoints(state, id);
      if (pts[king.col][king.row]) { naive = true; break; }
    }
    if ((real[0] !== -1) !== naive) {
      throw new Error(`${label}: 将帅 ${kingId} 的被将判定与朴素实现不一致`);
    }
  }
}

/** 随机走一步（优先合法且不送将），返回新局面或 null 表示无棋可走 */
function randomWalk(state: GameState, rand: () => number): GameState | null {
  const candidates: Array<[number, number, number]> = [];
  for (let id = 0; id < 32; id++) {
    const p = state.pieces[id];
    if (!p.alive) continue;
    if ((id <= 15) === (state.sideTag === BLACK_SIDE)) continue; // 非走子方
    const pts = getValidMoves(state, id);
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (pts[c][r] && isMoveKingSafe(state, id, c, r)) candidates.push([id, c, r]);
      }
    }
  }
  if (candidates.length === 0) return null;
  const [id, c, r] = candidates[Math.floor(rand() * candidates.length)];
  const res = makeMove(state, id, c, r);
  return res.newState;
}

describe('揭棋 · 变体隔离铁闸（象棋必须逐字节不变）', () => {
  it('初始局面：所有走点/合法性/指纹与朴素实现完全一致', () => {
    assertXiangqiUnchanged(createInitialState(RED_SIDE), '初始局面(红先)');
    assertXiangqiUnchanged(createInitialState(BLACK_SIDE), '初始局面(黑先)');
  });

  it('随机对弈 40 局 × 每局 24 步，全程不污染象棋行为', () => {
    let s = 0x1234567;
    const rand = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return (s % 100000) / 100000;
    };

    for (let game = 0; game < 40; game++) {
      let st: GameState = createInitialState(game % 2 === 0 ? RED_SIDE : BLACK_SIDE);
      for (let ply = 0; ply < 24; ply++) {
        assertXiangqiUnchanged(st, `第${game}局 第${ply}步`);
        const next = randomWalk(st, rand);
        if (!next) break;
        st = next;
      }
    }
  });

  it('cloneGameState 不共享 hiddenMask 引用（否则改写会污染旧局面）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(42));
    const clone = cloneGameState(state);
    expect(clone.hiddenMask).not.toBe(state.hiddenMask);
    // 深拷贝：改一个不影响另一个
    clone.hiddenMask![27] = false;
    expect(state.hiddenMask![27]).toBe(true);
  });

  it('象棋 cloneGameState 的 variant/hiddenMask 仍为 undefined（不凭空引入字段值）', () => {
    const st = createInitialState(RED_SIDE);
    expect(st.variant).toBeUndefined();
    expect(st.hiddenMask).toBeUndefined();
    const clone = cloneGameState(st);
    expect(clone.variant).toBeUndefined();
    expect(clone.hiddenMask).toBeUndefined();
    // 指纹不受影响
    expect(positionKey(st)).toBe(positionKey(clone));
  });

  it('象棋 FEN 往返不受揭棋字段影响', () => {
    const st = createInitialState(RED_SIDE);
    expect(toFenString(st)).not.toContain('|h');
    expect(toFenString(st)).toBe(toFenString(cloneGameState(st)));
  });
});

describe('揭棋 · 开关确实生效（对照组：证明隔离不是"恰好什么都没做"）', () => {
  it('createJieqiInitialState 产出 variant=jieqi 且暗子标记正确', () => {
    const { state } = createJieqiInitialState(makeSeededRand(7));
    expect(isJieqi(state)).toBe(true);
    expect(state.variant).toBe('jieqi');
    // 将帅恒明子
    expect(state.hiddenMask![0]).toBe(false);
    expect(state.hiddenMask![16]).toBe(false);
    // 其余 30 格全暗（红黑各 15）
    let hidden = 0;
    for (let i = 0; i < 32; i++) if (state.hiddenMask![i]) hidden++;
    expect(hidden).toBe(30);
  });

  it('暗子不是攻击者：开局基线不得判成白脸将 / 不得把明子判成被将', () => {
    const { state } = createJieqiInitialState(makeSeededRand(11));
    // 两将帅同在 col 4，中间隔着暗子（兵位等）——不能算照面
    // 更关键：底线的暗子占位 id 是车号，但它们不是攻击者
    expect(isJiangJun(state, 16)[0]).toBe(-1);
    expect(isJiangJun(state, 0)[0]).toBe(-1);
    // 开局双方都还有大量合法着法（若暗子被误当攻击者，这里会迅速枯竭）
    expect(hasAnyLegalMove(state, RED_SIDE)).toBe(true);
    expect(hasAnyLegalMove(state, BLACK_SIDE)).toBe(true);
    expect(enumerateLegalMoves(state, RED_SIDE).length).toBeGreaterThan(10);
  });

  it('揭棋指纹带暗子位图后缀，象棋不带', () => {
    const { state } = createJieqiInitialState(makeSeededRand(3));
    expect(positionKey(state)).toMatch(/\|h[0-9a-z]+$/);
    expect(positionKey(createInitialState(RED_SIDE))).not.toContain('|h');
  });

  it('「士/象可过河」在揭棋中确实被放宽', () => {
    // 把红仕 17 放到 (3,5)：红方九宫是 row 7-9，故 (3,5) 在九宫外。
    //
    // ⚠️ 这里**不能**断言"象棋走法为 0"：calcShi 的九宫限制是靠
    //   `row !== 9-side` / `row !== 7-side` 与 `col > 3` / `col < 5`
    // 这两组宽松条件近似表达的，并没有真正校验「起点在九宫内」。
    // 例如 col=0 时 `col < 5` 成立，仍会产出九宫外的落点。
    // 这是既有引擎的既定行为（初始局面下不可见），且改动它会波及象棋残局，
    // 故此处不去"修正"，改用**相对断言**：直接比对两套走点集合。
    const { state } = createJieqiInitialState(makeSeededRand(5));
    state.sideTag = RED_SIDE; // getValidMoves 有走子方限制
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (state.qiPan[c][r] === 17) state.qiPan[c][r] = -1;
      }
    }
    state.pieces[17].col = 3;
    state.pieces[17].row = 5;
    state.qiPan[3][5] = 17;

    const hiddenPts = getValidMoves(state, 17);
    const xiangqiPts = naiveSelectable(state, 17);

    // 未翻开的暗子：按棋位棋种走，且**不享**过河放宽
    // （规则 5 原文是「揭开后的士、象可以过河」，此处刻意用相对断言钉死这一点）
    expect(hiddenPts[2][4]).toBe(false);

    // 翻开后（revealedType[17] = 'shi'）才放宽：(2,4) 变成可走
    const revealed = cloneGameState(state);
    revealed.revealedType![17] = 'shi';
    revealed.hiddenMask![17] = false;
    const revealedPts = getValidMoves(revealed, 17);
    expect(xiangqiPts[2][4]).toBe(false);
    expect(revealedPts[2][4]).toBe(true);

    // 放宽只增加走点，不得减少（不得把原本合法的落点也弄丢）
    const jieqiPts = revealedPts;
    let jieqiCount = 0;
    let xiangqiCount = 0;
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (jieqiPts[c][r]) jieqiCount++;
        if (xiangqiPts[c][r]) xiangqiCount++;
        if (xiangqiPts[c][r] && !jieqiPts[c][r]) {
          throw new Error(`放宽后丢失了原本合法的落点 (${c},${r})`);
        }
      }
    }
    expect(jieqiCount).toBeGreaterThan(xiangqiCount);
  });
});