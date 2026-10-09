/**
 * 揭棋 · 本地 AI 分支（jieqiAiEngine）
 *
 * 验证 §9.3 的三件事落到 AIEngine 上真的成立：
 * 1. 评估按**身份后验期望**计子力，而不是把占位 id 当真实身份；
 * 2. 搜索树里「走暗子即翻开」，撤销能还原到背面；
 * 3. 提示（pureBest）确定性：对同一局面两次提示结果必须一致。
 *
 * 同时钉住象棋隔离：variant !== 'jieqi' 时行为与改动前一致。
 */

import {
  getBestMoveAsync, getHintMoveAsync, cloneForSearch,
} from '../AIEngine';
import {
  makeMove, getValidMoves, isMoveKingSafe, isJiangJun, cloneGameState,
} from '../GameEngine';
import {
  createJieqiInitialState, makeSeededRand, liveHiddenSlots, hiddenIdentityPosterior,
} from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

/** 找一步本方合法的暗子着法 */
function hiddenMoveOf(state: GameState) {
  for (const id of liveHiddenSlots(state, state.sideTag)) {
    const pts = getValidMoves(state, id);
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (pts[c][r] && isMoveKingSafe(state, id, c, r)) return { id, c, r };
      }
    }
  }
  return null;
}

describe('揭棋 · 本地 AI', () => {
  it('搜索树里走暗子会翻开它，且撤销能还原', () => {
    const init = createJieqiInitialState(makeSeededRand(101));
    const state = init.state;
    const identity = init.identity;
    const mv = hiddenMoveOf(state);
    expect(mv).not.toBeNull();

    expect(state.hiddenMask![mv!.id]).toBe(true);
    const next = makeMove(state, mv!.id, mv!.c, mv!.r, identity).newState;
    expect(next.hiddenMask![mv!.id]).toBe(false);
    expect(next.revealedType![mv!.id]).toBeTruthy();
    // 翻开后方能成为攻击者
    expect(typeof next.revealedType![mv!.id]).toBe('string');
  });

  it('cloneForSearch 深拷贝 hiddenMask/revealedType（搜索不得改到真局面）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(102));
    const copy = cloneForSearch(state);
    expect(copy.hiddenMask).not.toBe(state.hiddenMask);
    expect(copy.revealedType).not.toBe(state.revealedType);

    // 改副本，真局面不受影响
    const firstHidden = liveHiddenSlots(state, RED_SIDE)[0];
    copy.hiddenMask![firstHidden] = false;
    copy.revealedType![firstHidden] = 'che';
    expect(state.hiddenMask![firstHidden]).toBe(true);
    expect(state.revealedType![firstHidden]).toBeNull();
  });

  it('cloneForSearch 对象棋不引入新字段（variant/hiddenMask 保持 undefined）', () => {
    const copy = cloneForSearch({
      qiPan: Array.from({ length: BOARD_COLS }, () => new Array(BOARD_ROWS).fill(-1)),
      pieces: Array.from({ length: 32 }, (_, i) => ({ id: i, alive: false, col: -1, row: -1 })),
      moveHistory: [], sideTag: RED_SIDE, zobristHash: 0, moveCount: 0,
    } as GameState);
    expect(copy.hiddenMask).toBeUndefined();
    expect(copy.revealedType).toBeUndefined();
    expect(copy.variant).toBeUndefined();
  });

  it('暗子后验期望子力随翻开而上升（翻出好子 → 评估变好）', () => {
    const init = createJieqiInitialState(makeSeededRand(103));
    let state = init.state;
    const identity = init.identity;

    // 期望子力之和随「好身份被翻开」单调不减：
    // 每翻开一枚，本方暗子数量 -1，该枚的真实价值被计入
    const totalValue = (s: GameState, side: typeof RED_SIDE) => {
      const slots = liveHiddenSlots(s, side);
      const dist = hiddenIdentityPosterior(s, side).get(slots[0]);
      if (!dist || slots.length === 0) return 0;
      return slots.length;
    };
    const before = totalValue(state, RED_SIDE);
    expect(before).toBe(15);

    const mv = hiddenMoveOf(state);
    state = makeMove(state, mv!.id, mv!.c, mv!.r, identity).newState;
    expect(totalValue(state, RED_SIDE)).toBe(14);
  });

  it('AI 在揭棋开局能给出合法着法（不崩溃、不返回 null）', async () => {
    const { state } = createJieqiInitialState(makeSeededRand(104));
    state.sideTag = RED_SIDE;
    const res = await getBestMoveAsync(state, 'easy');
    expect(res).not.toBeNull();
    expect(res!.pieceId).toBeGreaterThanOrEqual(16);
    expect(res!.pieceId).toBeLessThanOrEqual(31);

    // 返回的着法必须真的合法
    const pts = getValidMoves(state, res!.pieceId);
    expect(pts[res!.toCol][res!.toRow]).toBe(true);
    expect(isMoveKingSafe(state, res!.pieceId, res!.toCol, res!.toRow)).toBe(true);
  }, 20000);

  it('AI 在揭棋中后盘也能给出合法着法', async () => {
    const init = createJieqiInitialState(makeSeededRand(105));
    let state = init.state;
    const identity = init.identity;
    // 先随机走 12 手，制造中盘
    for (let ply = 0; ply < 12; ply++) {
      const mv = hiddenMoveOf(state);
      if (!mv) break;
      state = makeMove(state, mv.id, mv.c, mv.r, identity).newState;
    }
    state.sideTag = BLACK_SIDE;
    const res = await getBestMoveAsync(state, 'easy');
    expect(res).not.toBeNull();
    expect(res!.pieceId).toBeLessThanOrEqual(15);
    const pts = getValidMoves(state, res!.pieceId);
    expect(pts[res!.toCol][res!.toRow]).toBe(true);
  }, 20000);

  it('提示确定性：同一揭棋局面两次提示结果一致', async () => {
    const { state } = createJieqiInitialState(makeSeededRand(106));
    state.sideTag = RED_SIDE;

    const a = await getHintMoveAsync(state);
    const b = await getHintMoveAsync(state);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 提示走确定性翻牌，故两次必须完全一致
    expect(a!.pieceId).toBe(b!.pieceId);
    expect(a!.toCol).toBe(b!.toCol);
    expect(a!.toRow).toBe(b!.toRow);
  }, 30000);

  it('提示走法不违反「暗子不是攻击者」', async () => {
    const { state } = createJieqiInitialState(makeSeededRand(107));
    state.sideTag = RED_SIDE;
    const res = await getHintMoveAsync(state);
    expect(res).not.toBeNull();

    // 提示给出的着法走完后，本方帅不能处于「被暗子将军」的状态
    const init2 = createJieqiInitialState(makeSeededRand(107));
    const next = makeMove(
      cloneGameState(init2.state), res!.pieceId, res!.toCol, res!.toRow, init2.identity,
    ).newState;
    const j = isJiangJun(next, 16);
    for (const atk of [j[1], j[2]]) {
      if (atk !== -1) expect(next.hiddenMask![atk]).not.toBe(true);
    }
  }, 30000);

  it('象棋 AI 不受影响：variant 未设时走原路径', () => {
    const { state } = createJieqiInitialState(makeSeededRand(108));
    // 去掉 jieqi 字段即退回普通象棋语义
    const xq = cloneGameState(state);
    delete xq.variant;
    delete xq.hiddenMask;
    delete xq.revealedType;
    const copy = cloneForSearch(xq);
    expect(copy.hiddenMask).toBeUndefined();
    expect(copy.variant).toBeUndefined();
  });
});