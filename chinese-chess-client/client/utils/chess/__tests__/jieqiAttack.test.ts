/**
 * 揭棋 · 暗子不是攻击者（jieqiAttack）
 *
 * 这是揭棋**最反直觉**的一条规则，也是漏实现后果最严重的一条：
 *
 *   暗子只有「移动」才会翻开，而移动前它从未动过，
 *   所以一个从未动过的暗子在物理上不可能产生攻击。
 *
 * 漏掉这条 ⇒ **开局即白脸将判负**：占位「车」与对方将帅同列照面，
 * 若不排除暗子，`afterMoveStillJiangJun` 会把它判成飞将，
 * 于是该方所有合法着法全部被判非法 → 开局即被判负。
 *
 * ⚠️ 初始局面里车在 (0,0)/(8,0) 角位、将帅在第 4 线，**开局本来就不照面**，
 * 所以本文件全部用例都手工摆一个「照面」的残局，而不是依赖开局。
 */

import { isJiangJun, isMoveKingSafe, makeMove, getValidMoves } from '../GameEngine';
import { afterMoveStillJiangJun, getPathPoints } from '../MoveCheck';
import { enumerateLegalMoves } from '../RuleEngine';
import { createJieqiInitialState, makeSeededRand } from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

/** 「king 是否被将」= isJiangJun 返回的归属方与 king 一致 */
const inCheckOf = (st: GameState, king: number) => isJiangJun(st, king)[0] === king;

/**
 * 精简局面：只有黑将(0)、红帅(16) 与一枚黑暗子(7)，其余全部阵亡。
 *
 * ⚠️ 摆位时必须**逐格清空整列**，不能只清「活子原位」：
 * 初始局面 (4,6) 上有红兵 29，若不清掉就会挡住 (4,3) 的车与 (4,9) 的帅，
 * 那样「照面」根本不成立，测试会变成假绿灯。
 */
function blankJieqi(): GameState {
  const { state } = createJieqiInitialState(makeSeededRand(5));
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) state.qiPan[c][r] = -1;
  }
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 7 || id === 16) continue;
    state.pieces[id].alive = false;
    state.pieces[id].col = -1;
    state.pieces[id].row = -1;
  }
  const put = (id: number, c: number, r: number) => {
    state.pieces[id].col = c;
    state.pieces[id].row = r;
    state.qiPan[c][r] = id;
  };
  put(0, 0, 0);    // 黑将
  put(16, 4, 9);   // 红帅
  put(7, 4, 3);    // 占位「车」暗子，正对红帅，同列无遮挡
  return state;
}

const posOf = (st: GameState) => st.pieces.map(p => ({ col: p.col, row: p.row, alive: p.alive }));

describe('揭棋 · 暗子不是攻击者', () => {
  it('暗子与将帅照面也不构成将军（残局：占位车在 (4,3) 对着 (4,9) 的红帅）', () => {
    const state = blankJieqi();
    expect(state.qiPan[4][3]).toBe(7);
    expect(state.hiddenMask![7]).toBe(true);
    expect(state.qiPan[4][9]).toBe(16);

    // 前提守卫：占位车的走点**形状**必须真的覆盖红帅所在格，
    // 否则本用例会退化成「因为走不到所以没被将」的假绿灯。
    const shape = getPathPoints(7, state.qiPan, posOf(state));
    expect(shape[4][9]).toBe(true);

    // 将军判定必须跳过它
    expect(isJiangJun(state, 16)[0]).toBe(-1);
    expect(inCheckOf(state, 16)).toBe(false);
    // 红帅因此仍有合法着法（若误判飞将，这里会接近 0）
    expect(enumerateLegalMoves(state, RED_SIDE).length).toBeGreaterThan(0);
  });

  it('同一枚子翻开后立刻恢复攻击身份', () => {
    const next = blankJieqi();
    next.revealedType![7] = 'che';   // 真身是车
    next.hiddenMask![7] = false;     // 已翻开 → 不再是暗子

    const j = isJiangJun(next, 16);
    expect(j[0]).toBe(16);
    expect(j[1]).toBe(7);
    expect(inCheckOf(next, 16)).toBe(true);
  });

  it('afterMoveStillJiangJun：暗子不算飞将，翻开后立刻算', () => {
    // 红帅 (4,9) → (4,8)；黑暗子占位车在 (4,3)，同列无遮挡
    const hidden = blankJieqi();
    expect(afterMoveStillJiangJun(
      16, 4, 9, 4, 8, hidden.qiPan, posOf(hidden),
      (id: number) => hidden.hiddenMask![id] === true,
    )).toBe(false);

    // 对照组：同样局面，但把那枚车翻开 → 必须判为「走了仍被将」
    const revealed = blankJieqi();
    revealed.revealedType![7] = 'che';
    revealed.hiddenMask![7] = false;
    expect(afterMoveStillJiangJun(
      16, 4, 9, 4, 8, revealed.qiPan, posOf(revealed),
      (id: number) => revealed.hiddenMask![id] === true,
    )).toBe(true);
  });

  it('暗子不进攻击者名单（isJiangJun 的两个攻击者槽位均非暗子）', () => {
    for (const seed of [5, 6, 7]) {
      const init = createJieqiInitialState(makeSeededRand(seed));
      const state = init.state;
      const king = state.sideTag === RED_SIDE ? 16 : 0;
      const j = isJiangJun(state, king);
      for (const a of [j[1], j[2]]) {
        if (a !== -1) expect(state.hiddenMask![a]).not.toBe(true);
      }
    }
  });

  it('整局随机对弈：任何时刻被判将的攻击者都不含暗子', () => {
    let checked = 0;
    // 优先吃子：纯走位很难在有限步数里造出将军，吃子能显著提高覆盖率
    let rng = 0x2f6e2b1;
    const rand = () => {
      rng ^= rng << 13; rng >>>= 0;
      rng ^= rng >>> 17;
      rng ^= rng << 5; rng >>>= 0;
      return rng / 0x100000000;
    };

    for (let seed = 200; seed < 210; seed++) {
      const init = createJieqiInitialState(makeSeededRand(seed));
      let state = init.state;
      const identity = init.identity;
      for (let ply = 0; ply < 80; ply++) {
        const king = state.sideTag === RED_SIDE ? 16 : 0;
        const inCheck = inCheckOf(state, king);
        const j = isJiangJun(state, king);
        if (inCheck) {
          checked++;
          expect(j[0]).toBe(king);
          for (const a of [j[1], j[2]]) {
            if (a !== -1) expect(state.hiddenMask![a]).not.toBe(true);
          }
        } else {
          expect(j[0]).toBe(-1);
        }

        // 收集本方全部合法着法；若有吃子则只在吃子中随机（否则全盘随机）
        const captures: Array<{ id: number; c: number; r: number }> = [];
        const all: Array<{ id: number; c: number; r: number }> = [];
        for (let id = 0; id < 32; id++) {
          const p = state.pieces[id];
          if (!p.alive) continue;
          if ((id <= 15) !== (state.sideTag === BLACK_SIDE)) continue;
          const pts = getValidMoves(state, id);
          for (let c = 0; c < BOARD_COLS; c++) {
            for (let r = 0; r < BOARD_ROWS; r++) {
              if (!pts[c][r] || !isMoveKingSafe(state, id, c, r)) continue;
              const mv = { id, c, r };
              all.push(mv);
              if (state.qiPan[c][r] !== -1) captures.push(mv);
            }
          }
        }
        const pool = captures.length > 0 ? captures : all;
        if (pool.length === 0) break;
        const mv = pool[Math.floor(rand() * pool.length) % pool.length];
        state = makeMove(state, mv.id, mv.c, mv.r, identity).newState;
      }
    }
    expect(checked).toBeGreaterThan(0); // 确保这条用例真的覆盖到「被将」的时刻
  });
});