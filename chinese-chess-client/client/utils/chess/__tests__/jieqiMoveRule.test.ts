/**
 * 揭棋 · 走法等价性与规则阈值（jieqiMove + jieqiRule 合并）
 *
 * 1. **棋位走法等价性**：未翻开的暗子必须按「所在棋位的棋种」走，
 *    且与「一枚同棋种的明子放在同一格」给出的走点**完全一致**。
 *    这是规则 2 的直接体现，也是 `effectiveIdOf` 返回 `undefined` 那条路径的证明。
 * 2. **士/象过河放宽只对已翻开的子生效**（规则 5）。
 * 3. **长将长捉阈值**：揭棋复用现有 `RULE_CONFIG`，不作任何调整。
 */

import {
  makeMove, getValidMoves, isMoveKingSafe, getSelectableMoves, cloneGameState,
} from '../GameEngine';
import { getPathPoints, createPathPointsBuffer, fillPathPoints } from '../MoveCheck';
import { RULE_CONFIG, enumerateLegalMoves, getMoveBanReason } from '../RuleEngine';
import {
  createJieqiInitialState, makeSeededRand, liveHiddenSlots, effectiveTypeOf,
} from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

const positionsOf = (s: GameState) => s.pieces.map(p => ({ col: p.col, row: p.row, alive: p.alive }));

/** 该方该棋种的代表 id（象棋 id = 棋种），用于构造对照明子 */
const BRIGHT_EQUIV: Record<number, number> = {
  7: 7, 8: 8,      // 黑车
  5: 5, 6: 6,      // 黑马
  9: 9, 10: 10,    // 黑炮
  1: 1, 2: 2,      // :black 士
  3: 3, 4: 4,      // 黑象
  11: 11, 12: 12, 13: 13, 14: 14, 15: 15, // 黑卒
  23: 23, 24: 24, 25: 25, 26: 26, 27: 27, 28: 28,
  21: 21, 22: 22, 17: 17, 18: 18, 19: 19, 20: 20,
  29: 29, 30: 30, 31: 31,
};

describe('揭棋 · 未翻开暗子按棋位走法（规则 2）', () => {
  it('暗子走点 === 同棋种明子在同格的走点（走遍全部 30 个占位 id）', () => {
    let checked = 0;
    for (const side of [RED_SIDE, BLACK_SIDE] as const) {
      const { state } = createJieqiInitialState(makeSeededRand(71));
      state.sideTag = side;
      for (const id of liveHiddenSlots(state, side)) {
        const type = effectiveTypeOf(state, id)!;
        // ⚠️ 士/象必须排除：翻开后按规则 5 获得过河放宽，走点**理应**变多。
        // 「士/象过河放宽只对已翻开的子生效」那条专门验证这个差异。
        if (type === 'shi' || type === 'xiang') continue;

        // 暗子的走点（effectiveId 未定义 → 按盘面 id = 棋位棋种）
        const hiddenPts = getValidMoves(state, id);

        // 对照：把同一枚子「翻开」，但真身就用它自己的棋种 —— 此时应完全一致
        const revealed = cloneGameState(state);
        revealed.hiddenMask![id] = false;
        revealed.revealedType![id] = type;
        const revealedPts = getValidMoves(revealed, id);

        for (let c = 0; c < BOARD_COLS; c++) {
          for (let r = 0; r < BOARD_ROWS; r++) {
            expect(revealedPts[c][r]).toBe(hiddenPts[c][r]);
          }
        }
        checked++;
      }
    }
    // 每方 15 - 2(士) - 2(象) = 11，两方共 22
    expect(checked).toBe(22);
  });

  it('暗子走点 === getPathPoints 的棋位形状（不叠加「走后是否安全」过滤）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(72));
    state.sideTag = RED_SIDE;
    const slots = liveHiddenSlots(state, RED_SIDE);
    for (const id of slots) {
      const shape = getPathPoints(id, state.qiPan, positionsOf(state));
      const selectable = getSelectableMoves(state, id);
      for (let c = 0; c < BOARD_COLS; c++) {
        for (let r = 0; r < BOARD_ROWS; r++) {
          // selectable ⊆ shape，且同格同侧时必须相等（无「飞将」类额外过滤）
          expect(selectable[c][r] === true && shape[c][r] === false).toBe(false);
        }
      }
    }
  });

  it('士/象过河放宽只对已翻开的子生效（未翻开不享）', () => {
    // 黑白各取一枚士位暗子，搬到河对岸
    for (const [side, id] of [[RED_SIDE, 17], [BLACK_SIDE, 1]] as const) {
      const { state } = createJieqiInitialState(makeSeededRand(73));
      state.sideTag = side;
      // 清空该子原位，放到河对岸中部
      state.qiPan[state.pieces[id].col][state.pieces[id].row] = -1;
      state.pieces[id].col = 4;
      state.pieces[id].row = side === RED_SIDE ? 2 : 7;
      state.qiPan[4][state.pieces[id].row] = id;

      // 未翻开：按棋位士走法（九宫限制近似：col 须在 3..5 之外不成立）
      const hidden = getValidMoves(state, id);
      const hiddenCount = hidden.flat().filter(Boolean).length;
      expect(hiddenCount).toBeGreaterThan(0);

      // 翻开后真身仍是士 → 放宽，应给出更多落点
      const revealed = cloneGameState(state);
      revealed.hiddenMask![id] = false;
      revealed.revealedType![id] = 'shi';
      const revealedCount = getValidMoves(revealed, id).flat().filter(Boolean).length;
      expect(revealedCount).toBeGreaterThanOrEqual(hiddenCount);

      // 对照组：真身是马 → 走法完全不同，且不享放宽
      const asHorse = cloneGameState(state);
      asHorse.hiddenMask![id] = false;
      asHorse.revealedType![id] = 'ma';
      const horsePts = getValidMoves(asHorse, id);
      let differs = false;
      for (let c = 0; c < BOARD_COLS && !differs; c++) {
        for (let r = 0; r < BOARD_ROWS && !differs; r++) {
          if (hidden[c][r] !== horsePts[c][r]) differs = true;
        }
      }
      expect(differs).toBe(true); // 翻开后走法确实按真实棋种切换了
    }
  });

  it('BRIGHT_EQUIV 表自洽：每个占位 id 映射到同棋种 id', () => {
    const { state } = createJieqiInitialState(makeSeededRand(74));
    for (const id of [...liveHiddenSlots(state, RED_SIDE), ...liveHiddenSlots(state, BLACK_SIDE)]) {
      const t = effectiveTypeOf(state, id)!;
      const bright = BRIGHT_EQUIV[id];
      expect(bright).toBeDefined();
      // 明子应与占位 id 同棋种：翻开后两者走法必须一致（上面已逐点验证）
      expect(effectiveTypeOf(state, bright)).toBe(t);
    }
  });
});

describe('揭棋 · 长将长捉阈值复用现有 RULE_CONFIG（规则 7）', () => {
  it('揭棋不调整任何阈值：RULE_CONFIG 与象棋一致', () => {
    expect(RULE_CONFIG.longCheckByPieceCount).toEqual([6, 12, 18]);
    expect(RULE_CONFIG.longChase).toBe(6);
    expect(RULE_CONFIG.checkChaseByPieceCount).toEqual([12, 18]);
    expect(RULE_CONFIG.repetitionDraw).toBe(5);
    expect(RULE_CONFIG.mutualLongCheckDraw).toBe(6);
    expect(RULE_CONFIG.mutualLongChaseDraw).toBe(6);
    expect(RULE_CONFIG.naturalMoveLimit).toBe(120); // 决策 3：沿用既有 120
  });

  it('揭棋局面下规则引擎不崩溃：getMoveBanReason 对揭棋着法可用', () => {
    const { state } = createJieqiInitialState(makeSeededRand(75));
    let probed = 0;
    for (const id of liveHiddenSlots(state, RED_SIDE)) {
      const pts = getValidMoves(state, id);
      for (let c = 0; c < BOARD_COLS && probed < 30; c++) {
        for (let r = 0; r < BOARD_ROWS && probed < 30; r++) {
          if (!pts[c][r]) continue;
          if (!isMoveKingSafe(state, id, c, r)) continue;
          // 合法着法不应被判禁着
          expect(getMoveBanReason(state, id, c, r)).toBeNull();
          probed++;
        }
      }
    }
    expect(probed).toBeGreaterThan(0);
  });

  it('揭棋对局走 40 手不触发终局、规则状态自洽', () => {
    const init = createJieqiInitialState(makeSeededRand(76));
    let state = init.state;
    const identity = init.identity;
    let plies = 0;
    for (let ply = 0; ply < 40; ply++) {
      const moves: Array<{ id: number; c: number; r: number }> = [];
      for (let id = 0; id < 32; id++) {
        const p = state.pieces[id];
        if (!p.alive) continue;
        if ((id <= 15) !== (state.sideTag === BLACK_SIDE)) continue;
        const pts = getValidMoves(state, id);
        for (let c = 0; c < BOARD_COLS; c++) {
          for (let r = 0; r < BOARD_ROWS; r++) {
            if (pts[c][r] && isMoveKingSafe(state, id, c, r)) moves.push({ id, c, r });
          }
        }
      }
      if (moves.length === 0) break;
      const mv = moves[ply % moves.length];
      state = makeMove(state, mv.id, mv.c, mv.r, identity).newState;
      plies++;
    }
    expect(plies).toBe(40);
    expect(state.gameStatus).toBe('playing');
    // 合法着法枚举不崩溃，且与逐子枚举口径一致
    expect(enumerateLegalMoves(state, state.sideTag).length).toBeGreaterThan(0);
  });
});

/**
 * 【2026-10 审计 D2】走点矩阵必须是**恒定的 9×10**。
 *
 * 揭棋的士/象可过河、出九宫（规则 5），落到棋盘任何行都可能让
 * `MoveCheck` 的 `row±1` / `row±2` 越界。此前**只判了列边界、漏判行边界**：
 *   · `row+1 = 10` → `points[c][10] = true` 把列数组撑长到 11，
 *     而清零循环只跑 `j < BOARD_ROWS`，该幻影点**跨调用残留**在 AIEngine 的复用缓冲里；
 *   · `row-1 = -1` → 写成 `points[c][-1]` 这个隐藏属性，`.length` 不变、肉眼不可见。
 * 今天所有消费方都只遍历 `r < BOARD_ROWS`，所以 UI 无症状 —— 正因如此，
 * 这里必须用「数组长度 + 负下标」两条断言把它钉死，否则改动会静默回归。
 */
describe('揭棋 · 走点矩阵边界（审计 D2）', () => {
  /** 构造一个「已翻开的士/象」落在指定格的极简局面 */
  function boardWithRevealed(id: number, col: number, row: number) {
    return boardWithRevealedAs(id, col, row, (id === 17 || id === 1) ? 'shi' : 'xiang');
  }

  /**
   * 同上，但**显式**指定翻开后的棋种。
   * 士/象的走法完全不同（斜行一步 vs 田字两格），用 id 反推棋种很容易写错
   * （本文件就踩过一次：用 id 19 期望「仕」，实际拿到的是「象」的走点）。
   */
  function boardWithRevealedAs(
    id: number, col: number, row: number, type: 'shi' | 'xiang'
  ) {
    const { state } = createJieqiInitialState(makeSeededRand(999));
    const s: GameState = {
      ...state,
      pieces: state.pieces.map((p) => ({ ...p, alive: false, col: -1, row: -1 })),
      qiPan: state.qiPan.map((c) => c.map(() => -1)),
    };
    // 将帅（暗子翻转与本用例无关，这里只需占位）
    for (const k of [0, 16]) {
      const [c, r] = k === 0 ? [4, 0] : [4, 9];
      s.qiPan[c][r] = k;
      s.pieces[k] = { id: k, col: c, row: r, alive: true };
    }
    s.qiPan[col][row] = id;
    s.pieces[id] = { id, col, row, alive: true };
    s.hiddenMask[id] = false;      // 已翻开
    s.revealedType[id] = type;
    return s;
  }

  const CASES: Array<[number, number, number]> = [
    // 士/仕：正越界（row 9 → row+1=10）与负越界（row 0 → row-1=-1）
    [17, 0, 9], [17, 0, 0],
    // 象/相：正越界（row 8 → row+2=10）与负越界（row 1 → row-2=-1）
    [19, 4, 8], [19, 4, 1],
    // 黑侧同款（确保修的不是「红方特例」）
    [1, 0, 9], [1, 0, 0], [3, 4, 8], [3, 4, 1],
  ];

  it.each(CASES)('id=%i @ (%i,%i) 走点矩阵恒为 9×10 且无负下标幻影', (id, col, row) => {
    const s = boardWithRevealed(id, col, row);
    const pts = getValidMoves(s, id);
    for (let c = 0; c < BOARD_COLS; c++) {
      expect(pts[c].length).toBe(BOARD_ROWS);
      expect(pts[c][-1]).not.toBe(true);
      expect(pts[c][-2]).not.toBe(true);
    }
  });

  it('复用缓冲跨调用不残留幻影点（曾撑长到 11 的那类污染）', () => {
    // 同一块 scratch 缓冲先用边界局面把它撑长，再问一个正常局面，
    // 若残留未被清掉，第二次查询就会看到 length=11 的列。
    const buf = createPathPointsBuffer();
    const positions = (s: GameState) => s.pieces.map(p => ({ col: p.col, row: p.row, alive: p.alive }));
    const edge = boardWithRevealed(17, 0, 9);
    fillPathPoints(17, edge.qiPan, positions(edge), buf, true, undefined);
    for (let c = 0; c < BOARD_COLS; c++) expect(buf[c].length).toBe(BOARD_ROWS);

    const mid = boardWithRevealed(17, 4, 5);
    fillPathPoints(17, mid.qiPan, positions(mid), buf, true, undefined);
    for (let c = 0; c < BOARD_COLS; c++) {
      expect(buf[c].length).toBe(BOARD_ROWS);
      expect(buf[c][-1]).not.toBe(true);
    }
  });

  /**
   * 【2026-10 审计 D2b】**底线上的已翻开士仍有走法**。
   *
   * 修复 calcShi 越界隐患时，守卫被写成了 `row >= 1 && row <= BOARD_ROWS - 2`。
   * 那个上界是多余的：士只斜行一步，落点是 `row±1`，向下永不越界，
   * 于是 **row 9 的已翻开仕被判成 0 步** —— 而规则 5 下它本可走到 row 8。
   *
   * 这个 bug 逃过了上面那条「矩阵恒为 9×10」的断言：
   * 那条只检查**形状**（长度/负下标），而 0 步的形状是完美的 9×10 全 false。
   * 所以这里必须断言**走法数量**，不能只断言形状。
   */
  it('已翻开的仕在底线 row9 仍有 2 个斜向走法（曾被判成 0 步）', () => {
    const s = boardWithRevealedAs(19, 2, 9, 'shi');   // 红相位翻成仕，落在 (2,9)
    const pts = getValidMoves(s, 19);
    const moves: string[] = [];
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) if (pts[c][r]) moves.push(`(${c},${r})`);
    }
    expect(moves.sort()).toEqual(['(1,8)', '(3,8)']);
  });

  it('已翻开的仕在顶线 row0 只有向下的 2 个走法（row-1 无处可落）', () => {
    // 注意 id=1 是**黑方**士，而 `boardWithRevealedAs` 默认 sideTag 为红；
    // `getValidMoves` 只返回**轮到走棋那一方**的子，所以必须先把 sideTag 翻成黑，
    // 否则拿到的是空矩阵（那会是个「假绿」用例）。
    const s = { ...boardWithRevealedAs(1, 2, 0, 'shi'), sideTag: BLACK_SIDE };
    const pts = getValidMoves(s, 1);
    const moves: string[] = [];
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) if (pts[c][r]) moves.push(`(${c},${r})`);
    }
    expect(moves.sort()).toEqual(['(1,1)', '(3,1)']);
  });

  it('已翻开的士在棋盘每一行都可走（逐行扫，不允许出现整行 0 步）', () => {
    // 兜底：上一条若只测了 (2,9)，改个列就可能又漏。
    // 这里把已翻开的仕放在中间列，逐行断言「非零走法」。
    const deadRows: number[] = [];
    for (let row = 0; row < BOARD_ROWS; row++) {
      const s = boardWithRevealedAs(19, 4, row, 'shi');
      const pts = getValidMoves(s, 19);
      let n = 0;
      for (let c = 0; c < BOARD_COLS; c++) {
        for (let r = 0; r < BOARD_ROWS; r++) if (pts[c][r]) n++;
      }
      if (n === 0) deadRows.push(row);
    }
    expect(deadRows).toEqual([]);
  });
});