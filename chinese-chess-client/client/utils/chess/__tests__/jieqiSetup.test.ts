/**
 * 揭棋 · 摆子 / 翻开 / id 冲突回归（jieqiSetup）
 *
 * 钉死四件事：
 *   1. 摆子：暗子数、占位 id 覆盖、洗牌多重集严格正确；
 *   2. **id 冲突回归**：早期设计曾用「占位 id 退役 + 真实 id 顶上」，
 *      实测 30/30 暗子的真实身份都会撞上另一个在盘暗子的 id —— 本文件钉死
 *      「盘面 id 永不因翻开而改变」这一修正后的不变量；
 *   3. 翻开：只写 revealedType / 清 hiddenMask，不触碰 pieces；
 *   4. 决策 A：吃暗子后吃子方不获得新子，且身份不外泄（铁律 A）。
 */

import {
  makeMove, cloneGameState, auditBoardConsistency, undoMove,
  getValidMoves, isMoveKingSafe,
} from '../GameEngine';
import {
  createJieqiInitialState, buildJieqiIdentity, makeSeededRand, makeShuffleRand,
  liveHiddenSlots, pieceTypeOf, hiddenIdentityPosterior, effectiveIdOf,
  crossRiverOf, __jieqiInternal, type JieqiPieceType,
} from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

const { ID_TYPE, HIDDEN_MULTISET_BY_SIDE, keyOf } = __jieqiInternal;

function slotsOf(side: typeof RED_SIDE | typeof BLACK_SIDE): number[] {
  return liveHiddenSlots(createJieqiInitialState(makeSeededRand(1)).state, side);
}

describe('揭棋 · 摆子', () => {
  it('每方恰好 15 枚暗子，占位 id 覆盖该方全部非将帅 id', () => {
    const red = slotsOf(RED_SIDE);
    const black = slotsOf(BLACK_SIDE);
    expect(red).toHaveLength(15);
    expect(black).toHaveLength(15);
    expect([...red].sort((a, b) => a - b)).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect([...black].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('占位 id 的棋种分布即初始布局的棋位分布（暗子按棋位走）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(2));
    const red: Record<string, number> = {};
    for (const id of liveHiddenSlots(state, RED_SIDE)) {
      const t = pieceTypeOf(id)!;
      red[t] = (red[t] || 0) + 1;
    }
    expect(red).toEqual({ che: 2, ma: 2, pao: 2, shi: 2, xiang: 2, bing: 5 });
    const black: Record<string, number> = {};
    for (const id of liveHiddenSlots(state, BLACK_SIDE)) {
      const t = pieceTypeOf(id)!;
      black[t] = (black[t] || 0) + 1;
    }
    // 黑方是 5 卒而非 5 兵 —— 两侧棋种名不同，不能共用一张表
    expect(black).toEqual({ che: 2, ma: 2, pao: 2, shi: 2, xiang: 2, zu: 5 });
  });

  it('hiddenType 的棋种多重集严格等于该方初始 15 枚，且同方', () => {
    for (const side of [RED_SIDE, BLACK_SIDE] as const) {
      const { hiddenType } = buildJieqiIdentity(makeSeededRand(9));
      const slots = liveHiddenSlots(createJieqiInitialState(makeSeededRand(1)).state, side);
      const counts: Record<string, number> = {};
      for (const slot of slots) {
        const t = hiddenType[slot];
        expect(t).toBeTruthy();
        counts[t!] = (counts[t!] || 0) + 1;
      }
      const expected: Record<string, number> = {};
      for (const [t, n] of HIDDEN_MULTISET_BY_SIDE[keyOf(side)]) expected[t] = n;
      expect(counts).toEqual(expected);
    }
  });

  it('不同种子产出不同身份分布（洗牌真的在洗）；同种子完全可复现', () => {
    const seq = (seed: number) => {
      const { hiddenType } = buildJieqiIdentity(makeSeededRand(seed));
      return liveHiddenSlots(createJieqiInitialState(makeSeededRand(1)).state, RED_SIDE)
        .map(s => hiddenType[s]).join(',');
    };
    const all = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(seq));
    expect(all.size).toBeGreaterThan(1);
    // 可复现（悔棋/复盘/自战依赖）
    expect(seq(2024)).toBe(seq(2024));
  });

  it('makeShuffleRand 返回 [0,n) 且取值有变化', () => {
    const rand = makeShuffleRand();
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const v = rand(15);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(15);
      seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('初始局面棋盘自洽', () => {
    const { state } = createJieqiInitialState(makeSeededRand(13));
    expect(auditBoardConsistency(state)).toEqual([]);
  });
});

describe('揭棋 · 翻开（只记棋种，id 恒定）', () => {
  /**
   * 找一个能合法走一步的暗子着法。
   * onlyId 给定时只在该 id 上找（供「特定真实身份」的用例使用）。
   */
  function findAnyHiddenMove(state: GameState, onlyId?: number) {
    for (let id = 0; id < 32; id++) {
      if (onlyId !== undefined && id !== onlyId) continue;
      if (state.hiddenMask?.[id] !== true) continue;
      if ((id <= 15) !== (state.sideTag === BLACK_SIDE)) continue;
      const pts = getValidMoves(state, id);
      for (let c = 0; c < BOARD_COLS; c++) {
        for (let r = 0; r < BOARD_ROWS; r++) {
          if (pts[c][r] && isMoveKingSafe(state, id, c, r)) return { id, c, r };
        }
      }
    }
    return null;
  }

  it('暗子移动后：id 不变，revealedType 写入，hiddenMask 清位', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(21));
    const mv = findAnyHiddenMove(state);
    expect(mv).not.toBeNull();

    const slotId = mv!.id;
    const trueType = identity.hiddenType[slotId];
    expect(trueType).toBeTruthy();

    const fromCol = state.pieces[slotId].col;
    const fromRow = state.pieces[slotId].row;
    const res = makeMove(state, slotId, mv!.c, mv!.r, identity);
    const next = res.newState;

    // id 恒定：pieces 长度与每项 id 都不变
    expect(next.pieces).toHaveLength(32);
    for (let i = 0; i < 32; i++) expect(next.pieces[i].id).toBe(i);
    // 该子仍是活子，只换了坐标
    expect(next.pieces[slotId].alive).toBe(true);
    expect(next.pieces[slotId].col).toBe(mv!.c);
    expect(next.pieces[slotId].row).toBe(mv!.r);
    // 棋盘登记的仍是原 id
    expect(next.qiPan[mv!.c][mv!.r]).toBe(slotId);
    expect(next.qiPan[fromCol][fromRow]).toBe(-1);
    // 真实棋种写入 + 移出暗子集合
    expect(next.revealedType![slotId]).toBe(trueType);
    expect(next.hiddenMask![slotId]).toBe(false);
    // 历史记下真实棋种（供 UI 动画与精确 undo）
    const last = next.moveHistory[next.moveHistory.length - 1];
    expect(last.pieceId).toBe(slotId);
    expect(last.revealedType).toBe(trueType);

    expect(auditBoardConsistency(next)).toEqual([]);
  });

  it('id 冲突回归：盘面 id 永不因翻开而改变（早期设计 30/30 必撞）', () => {
    // 若有人把揭开改回「换 id」，下面「翻开前后 pieces 的 id 序列完全相同」立刻失败。
    for (let seed = 30; seed < 36; seed++) {
      const { state, identity } = createJieqiInitialState(makeSeededRand(seed));
      const mv = findAnyHiddenMove(state);
      if (!mv) continue;
      const before = state.pieces.map(p => p.id).join(',');
      const after = makeMove(state, mv.id, mv.c, mv.r, identity).newState
        .pieces.map(p => p.id).join(',');
      expect(after).toBe(before);
    }
  });

  it('翻开后的子按真实棋种走法（effectiveIdOf 给出同类代表 id）', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(22));
    // 找一个「真实身份是马」的暗子
    let slotId = -1, c = -1, r = -1;
    for (let id = 0; id < 32 && slotId < 0; id++) {
      if (state.hiddenMask?.[id] !== true) continue;
      if (identity.hiddenType[id] !== 'ma') continue;
      state.sideTag = id <= 15 ? BLACK_SIDE : RED_SIDE;
      const m = findAnyHiddenMove(state, id);
      if (m) { slotId = id; c = m.c; r = m.r; }
    }
    expect(slotId).toBeGreaterThanOrEqual(0);

    // 未翻开：effectiveIdOf 为 undefined（按盘面 id = 棋位棋种走）
    expect(effectiveIdOf(state, slotId)).toBeUndefined();

    const next = makeMove(state, slotId, c, r, identity).newState;
    // 已翻开：应映射到该方的马代表 id（黑 5 / 红 21）
    const rep = effectiveIdOf(next, slotId);
    expect(rep).toBe(slotId <= 15 ? 5 : 21);
    // 马不是士/象 → 无过河放宽
    expect(crossRiverOf(next, slotId)).toBeUndefined();
  });

  it('士/象翻开后获得过河放宽，未翻开的暗子不获得', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(33));
    let slotId = -1, c = -1, r = -1;
    for (let id = 0; id < 32 && slotId < 0; id++) {
      if (state.hiddenMask?.[id] !== true) continue;
      const t = identity.hiddenType[id];
      if (t !== 'shi' && t !== 'xiang') continue;
      state.sideTag = id <= 15 ? BLACK_SIDE : RED_SIDE;
      const m = findAnyHiddenMove(state, id);
      if (m) { slotId = id; c = m.c; r = m.r; }
    }
    expect(slotId).toBeGreaterThanOrEqual(0);
    expect(crossRiverOf(state, slotId)).toBe(false); // 未翻开 → 不放宽
    const next = makeMove(state, slotId, c, r, identity).newState;
    expect(crossRiverOf(next, slotId)).toBe(true);   // 已翻开 → 放宽
  });

  it('undoMove 精确还原「走子即翻开」', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(23));
    const mv = findAnyHiddenMove(state);
    expect(mv).not.toBeNull();

    const before = JSON.stringify({
      qiPan: state.qiPan, mask: state.hiddenMask,
      rev: state.revealedType, side: state.sideTag,
    });
    const moved = makeMove(state, mv!.id, mv!.c, mv!.r, identity).newState;
    const undone = undoMove(moved);
    expect(undone).not.toBeNull();

    expect(JSON.stringify({
      qiPan: undone!.qiPan, mask: undone!.hiddenMask,
      rev: undone!.revealedType, side: undone!.sideTag,
    })).toBe(before);
    expect(auditBoardConsistency(undone!)).toEqual([]);
    expect(undone!.hiddenMask![mv!.id]).toBe(true);
    expect(undone!.revealedType![mv!.id]).toBeNull();
  });

  /**
 * 【2026-10 审计 D1：行为已反转】
 *
 * 原用例名叫「未传 identity 时**不瞎猜**：暗子继续按棋位走，局面仍自洽」，
 * 它把「静默跳过翻开」当成正确行为固化了下来。但静默跳过本身就是缺陷：
 * 走过的暗子永远翻不开 ⇒ 直接违反规则 3，且 `hiddenMask[x]===true` 与
 * 「x 明明移动过」两个状态并存，后续任何按 hiddenMask 的扫描（攻击判定、
 * 引擎展开）都会把它当成没动过的暗子 —— **静默错局比崩溃更难发现**。
 *
 * `jieqiIdentity` 是可选参数，签名不会提醒调用方必须传（`replayPlayer/index.tsx`
 * 就曾漏传）。故现在改为**显式抛错**：宁可不走，也不走出一局假棋。
 */
  it('未传 identity 时报错：绝不允许「走过的暗子永远翻不开」（审计 D1）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(24));
    const mv = findAnyHiddenMove(state);
    expect(mv).not.toBeNull();
    // 不传 identity ⇒ 直接拒绝，绝不产出一个「看似正常」的错局
    expect(() => makeMove(state, mv!.id, mv!.c, mv!.r)).toThrow(/jieqiIdentity/);
  });

  it('正常传入 identity 时仍然走子即翻开（守住规则 3 不被上面的守卫误伤）', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(24));
    const mv = findAnyHiddenMove(state);
    const res = makeMove(state, mv!.id, mv!.c, mv!.r, identity);
    expect(res.newState.qiPan[mv!.c][mv!.r]).toBe(mv!.id);
    expect(res.newState.hiddenMask![mv!.id]).toBe(false);
    expect(res.newState.revealedType![mv!.id]).not.toBeNull();
    expect(auditBoardConsistency(res.newState)).toEqual([]);
  });

  it('象棋局面不受该守卫影响（无 identity 也能正常走）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(24));
    const xiangqi: GameState = {
      ...state,
      variant: 'xiangqi',
      hiddenMask: undefined,
      revealedType: undefined,
    };
    // 不能用 findAnyHiddenMove（它按 hiddenMask 过滤，象棋局面没有该字段），
    // 这里直接从走法表里找一步合法棋。
    let mv: { id: number; c: number; r: number } | null = null;
    for (let id = 0; id < 32 && !mv; id++) {
      if (!xiangqi.pieces[id].alive) continue;
      if ((id <= 15) !== (xiangqi.sideTag === BLACK_SIDE)) continue;
      const pts = getValidMoves(xiangqi, id);
      for (let c = 0; c < BOARD_COLS && !mv; c++) {
        for (let r = 0; r < BOARD_ROWS && !mv; r++) {
          if (pts[c][r] && isMoveKingSafe(xiangqi, id, c, r)) mv = { id, c, r };
        }
      }
    }
    expect(mv).not.toBeNull();
    expect(() => makeMove(xiangqi, mv!.id, mv!.c, mv!.r)).not.toThrow();
  });
});

describe('揭棋 · 决策 A：吃暗子后吃子方不获得新子', () => {
  const countAlive = (st: GameState, side: typeof RED_SIDE | typeof BLACK_SIDE) => {
    let n = 0;
    for (let id = 0; id < 32; id++) {
      if (id === 0 || id === 16) continue;
      if ((id <= 15) !== (side === BLACK_SIDE)) continue;
      if (st.pieces[id].alive) n++;
    }
    return n;
  };

  it('吃暗子：黑方少一枚、红方不增枚；身份不落到盘上也不进序列化', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(31));

    // 把红车 23 从底线挪走，制造一次吃暗子
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (state.qiPan[c][r] === 23) state.qiPan[c][r] = -1;
      }
    }
    state.sideTag = RED_SIDE;
    let targetId = -1;
    let tc = -1, tr = -1;
    for (let c = 0; c < BOARD_COLS && targetId < 0; c++) {
      for (let r = 0; r < BOARD_ROWS && targetId < 0; r++) {
        const id = state.qiPan[c][r];
        if (id >= 1 && id <= 15 && state.hiddenMask![id]) {
          targetId = id; tc = c; tr = r;
        }
      }
    }
    expect(targetId).toBeGreaterThan(0);

    const blackBefore = countAlive(state, BLACK_SIDE);
    const redBefore = countAlive(state, RED_SIDE);

    const eatenType = identity.hiddenType[targetId];
    const next = makeMove(state, 23, tc, tr, identity).newState;

    // 被吃的暗子下线且退役
    expect(next.pieces[targetId].alive).toBe(false);
    expect(next.pieces[targetId].col).toBe(-1);
    // 决策 A：红方子数不变（不吃回一枚新暗子），黑方少一枚
    expect(countAlive(next, RED_SIDE)).toBe(redBefore);
    expect(countAlive(next, BLACK_SIDE)).toBe(blackBefore - 1);
    // 被吃暗子的真实棋种不得写进任何存活子的 revealedType
    for (let id = 0; id < 32; id++) {
      if (!next.pieces[id].alive) continue;
      expect(next.revealedType![id]).not.toBe(eatenType);
    }
    // 铁律 A：序列化结果里不含身份表的任何痕迹
    const dumped = JSON.stringify({
      qiPan: next.qiPan, pieces: next.pieces,
      hiddenMask: next.hiddenMask, revealedType: next.revealedType,
    });
    expect(dumped).not.toContain('hiddenType');
    expect(auditBoardConsistency(next)).toEqual([]);
  });

  it('随机对弈 6 局 × 60 步：无 id 冲突、无悬空活子', () => {
    for (let game = 0; game < 6; game++) {
      const init = createJieqiInitialState(makeSeededRand(100 + game));
      let state = init.state;
      const identity = init.identity;
      for (let ply = 0; ply < 60; ply++) {
        const seen = new Set<number>();
        for (let c = 0; c < BOARD_COLS; c++) {
          for (let r = 0; r < BOARD_ROWS; r++) {
            const id = state.qiPan[c][r];
            if (id === -1) continue;
            if (seen.has(id)) throw new Error(`第${game}局第${ply}步：id ${id} 同时占据多格`);
            seen.add(id);
          }
        }
        expect(auditBoardConsistency(state)).toEqual([]);

        let done = false;
        for (let id = 0; id < 32 && !done; id++) {
          const p = state.pieces[id];
          if (!p.alive) continue;
          if ((id <= 15) !== (state.sideTag === BLACK_SIDE)) continue;
          const pts = getValidMoves(state, id);
          for (let c = 0; c < BOARD_COLS && !done; c++) {
            for (let r = 0; r < BOARD_ROWS && !done; r++) {
              if (!pts[c][r] || !isMoveKingSafe(state, id, c, r)) continue;
              state = makeMove(state, id, c, r, identity).newState;
              done = true;
            }
          }
        }
        if (!done) break;
      }
    }
  });

  it('揭棋后验：初始归一化正确，黑方不含红方专属棋种', () => {
    const { state } = createJieqiInitialState(makeSeededRand(41));
    const post = hiddenIdentityPosterior(state, BLACK_SIDE);
    const slots = liveHiddenSlots(state, BLACK_SIDE);
    expect(post.size).toBe(slots.length);
    for (const [, dist] of post) {
      let sum = 0;
      for (const t of Object.keys(dist) as JieqiPieceType[]) sum += dist[t];
      expect(sum).toBeCloseTo(1, 10);
      expect(dist.bing).toBe(0);
      expect(dist.zu).toBeCloseTo(5 / 15, 10);
    }
  });

  it('cloneGameState 深拷贝 hiddenMask / revealedType（不共享引用）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(51));
    const clone = cloneGameState(state);
    expect(clone.hiddenMask).not.toBe(state.hiddenMask);
    expect(clone.revealedType).not.toBe(state.revealedType);
    clone.hiddenMask![27] = false;
    clone.revealedType![27] = 'ma';
    expect(state.hiddenMask![27]).toBe(true);
    expect(state.revealedType![27]).toBeNull();
  });

  it('ID_TYPE 覆盖全部非将帅 id（棋种解析不留空洞）', () => {
    for (let id = 0; id < 32; id++) {
      if (id === 0 || id === 16) continue;
      expect(ID_TYPE[id]).toBeDefined();
    }
  });
});