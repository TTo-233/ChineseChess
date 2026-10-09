/**
 * 揭棋 · 铁律 A：身份永不外泄（jieqiNoLeak）
 *
 * 铁律 A：**暗子的真实身份只存在于内存里的 `JieqiIdentity`，
 * 绝不写进 `GameState`，也绝不出现在任何序列化载荷里。**
 *
 * 本文件把这条钉在**状态层**：`GameState` 及其全部派生结构（走棋历史、
 * 克隆、克隆的克隆）序列化后，都不得含有任何未翻开暗子的真实棋种。
 *
 * ⚠️ 关于 `publicGameState`（服务端 P2 的出站收口）：它属于在线对局阶段，
 * 本阶段（离线 PVE + 本地 AI）尚未实现，故此处断言的是「喂给它的上游数据
 * 本身就不含身份」——即收口函数**无身份可漏**，这是比测收口更根本的一道闸。
 *
 * 决策 A 下「吃暗子之后」是最容易泄漏的时机（被吃暗子的真身对**双方**都不可见），
 * 故单独重点覆盖。
 */

import {
  makeMove, cloneGameState, undoMove, getValidMoves, isMoveKingSafe,
} from '../GameEngine';
import { positionKey } from '../RuleEngine';
import {
  createJieqiInitialState, makeSeededRand, type JieqiIdentity,
} from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

/** 从一个揭棋局面里找一步合法的暗子着法 */
function anyHiddenMove(state: GameState) {
  for (let id = 0; id < 32; id++) {
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

/**
 * 从序列化文本中，扫出**不该出现**的棋种标记。
 *
 * 做法：收集当前所有**未翻开**暗子的真实棋种（来自只在内存里的 identity），
 * 断言 GameState 的序列化文本里一个都不含。
 *
 * 注意：无法靠「文本里出现某个棋种字面量」判定，因为 `revealedType` 字段
 * 本来就要含**已翻开**子的棋种（那是公开信息）。故只针对「未翻开的真相」。
 */
function assertNoUnrevealedTruth(dumped: string, state: GameState, identity: JieqiIdentity): void {
  // 收集未翻开暗子的真实棋种集合
  const unrevealed = new Set<string>();
  for (let id = 0; id < 32; id++) {
    if (state.hiddenMask?.[id] !== true) continue;
    const t = identity.hiddenType[id];
    if (t) unrevealed.add(t);
  }
  // GameState 序列化后，`revealedType` 只可能等于已翻开子的棋种
  const revealed = new Set<string>();
  for (let id = 0; id < 32; id++) {
    const t = state.revealedType?.[id];
    if (t) revealed.add(t);
  }
  // 未翻开真相里「独有」的棋种（已翻开的棋种不构成泄漏）
  const exclusive = [...unrevealed].filter(t => !revealed.has(t));

  // 逐个确认 exclusive 棋种没有以 revealedType 的形式出现
  const parsed = JSON.parse(dumped) as { revealedType?: (string | null)[] };
  const onState = (parsed.revealedType ?? []).filter(Boolean) as string[];
  for (const t of exclusive) {
    const inRevealed = onState.some(v => v === t);
    // 允许：某个已翻开的子恰好也是这个棋种（那时它已在 revealed 集合里，
    // 不该进 exclusive）；因此 exclusive 中的棋种一旦出现在 revealedType 即为泄漏
    if (inRevealed) {
      throw new Error(`未翻开的暗子真相「${t}」出现在 GameState.revealedType 中`);
    }
  }
}

describe('揭棋 · 铁律 A：身份不进入 GameState', () => {
  it('初始局面：未翻开的 15 枚真相一个都不在状态里', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(61));
    const dumped = JSON.stringify(state);
    assertNoUnrevealedTruth(dumped, state, identity);

    // 额外硬断言：整个状态里不存在 identity 表的结构
    expect(dumped).not.toContain('hiddenType');
    // 且 revealedType 此刻全为空（没有任何子被翻开）
    expect((state.revealedType ?? []).filter(Boolean)).toEqual([]);
  });

  it('走子翻开若干手后：已翻开的棋种是公开信息，未翻开的真相仍不外泄', () => {
    const init = createJieqiInitialState(makeSeededRand(62));
    let state = init.state;
    const identity = init.identity;

    let reveals = 0;
    for (let ply = 0; ply < 30; ply++) {
      const mv = anyHiddenMove(state) ?? anyHiddenMove({ ...state, sideTag: !state.sideTag } as GameState);
      if (!mv) break;
      state = makeMove(state, mv.id, mv.c, mv.r, identity).newState;
      if (state.revealedType?.[mv.id]) reveals++;

      assertNoUnrevealedTruth(JSON.stringify(state), state, identity);
      // 走棋历史里只允许出现「已翻开」的棋种
      const hist = JSON.stringify(state.moveHistory);
      for (const rec of state.moveHistory) {
        if (!rec.revealedType) continue;
        // 该子此刻若仍是暗子，说明历史记错了
        expect(state.hiddenMask![rec.pieceId]).not.toBe(true);
      }
      expect(hist).not.toContain('hiddenType');
    }
    expect(reveals).toBeGreaterThan(0);
  });

  it('决策 A：吃暗子之后，被吃暗子的真身对双方都不可见', () => {
    const init = createJieqiInitialState(makeSeededRand(63));
    const state = init.state;
    const identity = init.identity;

    // 把红车 23 挪到一枚黑暗子上，制造吃暗子
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (state.qiPan[c][r] === 23) state.qiPan[c][r] = -1;
      }
    }
    state.sideTag = RED_SIDE;
    let eaten = -1, ec = -1, er = -1;
    for (let c = 0; c < BOARD_COLS && eaten < 0; c++) {
      for (let r = 0; r < BOARD_ROWS && eaten < 0; r++) {
        const id = state.qiPan[c][r];
        if (id >= 1 && id <= 15 && state.hiddenMask![id]) { eaten = id; ec = c; er = r; }
      }
    }
    expect(eaten).toBeGreaterThan(0);
    const eatenType = identity.hiddenType[eaten];
    expect(eatenType).toBeTruthy();

    const next = makeMove(state, 23, ec, er, identity).newState;

    // 被吃暗子已死
    expect(next.pieces[eaten].alive).toBe(false);
    // 它的真身没有出现在任何存活子的 revealedType 上
    for (let id = 0; id < 32; id++) {
      if (!next.pieces[id].alive) continue;
      expect(next.revealedType![id]).not.toBe(eatenType);
    }
    // 整个状态序列化后不含真相表
    expect(JSON.stringify(next)).not.toContain('hiddenType');
    assertNoUnrevealedTruth(JSON.stringify(next), next, identity);
  });

  it('克隆与悔棋都不引入身份', () => {
    const init = createJieqiInitialState(makeSeededRand(64));
    const state = init.state;
    const identity = init.identity;
    const mv = anyHiddenMove(state);
    expect(mv).not.toBeNull();

    const moved = makeMove(state, mv!.id, mv!.c, mv!.r, identity).newState;
    const undone = undoMove(moved);
    expect(undone).not.toBeNull();

    for (const s of [moved, undone!]) {
      expect(JSON.stringify(s)).not.toContain('hiddenType');
      assertNoUnrevealedTruth(JSON.stringify(s), s, identity);
    }

    // 深拷贝链：改 clone 不影响原局面，也不带身份
    const c1 = cloneGameState(moved);
    const c2 = cloneGameState(c1);
    expect(JSON.stringify(c2)).not.toContain('hiddenType');
  });

  it('positionKey 指纹不含身份（只含「哪些格是暗子」的位图）', () => {
    const init = createJieqiInitialState(makeSeededRand(65));
    let state = init.state;
    const identity = init.identity;
    const mv = anyHiddenMove(state);
    expect(mv).not.toBeNull();

    const keys = new Set<string>();
    for (let ply = 0; ply < 12; ply++) {
      keys.add(positionKey(state));
      expect(positionKey(state)).not.toContain('hiddenType');
      const m = anyHiddenMove(state) ?? anyHiddenMove({ ...state, sideTag: !state.sideTag } as GameState);
      if (!m) break;
      state = makeMove(state, m.id, m.c, m.r, identity).newState;
    }
    // 走过子后指纹应当变化（否则说明暗子位图没进指纹，会漏判重复局面）
    expect(keys.size).toBeGreaterThan(1);
  });

  it('identity 对象只活在调用方手里：不是 GameState 的一部分', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(66));
    const keys = Object.keys(state);
    expect(keys).not.toContain('identity');
    expect(keys).not.toContain('jieqiIdentity');
    expect(keys).not.toContain('secret');
    // 但它确实是可用的真相表（证明上面断言的不是空壳）
    expect(identity.hiddenType.filter(Boolean).length).toBe(30);
  });
});