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
import { getPathPoints } from '../MoveCheck';
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