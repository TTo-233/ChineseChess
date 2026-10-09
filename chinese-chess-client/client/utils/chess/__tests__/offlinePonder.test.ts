/**
 * 本地引擎后台预计算（ponder）单测
 *
 * 迁移要点：提示已改由本地皮卡鱼出，旧 TS 的 precomputeHint 结果**不会被消费**，
 * 却仍要占 JS 主线程 2500ms。因此预计算必须改走本地引擎，否则是纯浪费。
 *
 * 这里覆盖三条不变量：
 *   1. 预计算以最低优先级入队（purpose='ponder'），可被 move/hint 抢占；
 *   2. 同一局面不重复启动（命中缓存直接跳过）；
 *   3. 取消/局面变化后结果不落缓存（不会把旧局面的着法用到新局面上）。
 */

import { createInitialState, makeMove } from '../GameEngine';
import { computeZobristHash } from '../AIEngine';
import { enumerateLegalMoves } from '../RuleEngine';
import { internalToUci } from '../pikafishUci';
import type { GameState } from '../GameEngine';

/** 让出事件循环若干拍，等预计算内部的 setTimeout(250) 走完 */
const flush = (ms = 400) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 打桩 getOfflineEngine：用假编排器替换真实引擎，无需 WASM/Worker。
 * ⚠️ 变量名必须以 `mock` 开头 —— jest.mock 工厂会被提升到文件顶部，
 *    引用普通外部变量会直接抛 "Invalid variable access"。
 */
const mockEngine = {
  search: jest.fn(),
  newGame: jest.fn(),
  stop: jest.fn(),
  warmup: jest.fn(),
  getStatus: jest.fn(() => ({ source: 'pikafish', capabilities: null, reason: null })),
};

jest.mock('../pikafish', () => ({
  getOfflineEngine: () => mockEngine,
}));

// 必须在 mock 之后再 import，确保被测模块拿到的是假引擎
import {
  precomputeOfflineHint,
  cancelOfflinePonder,
  takeOfflinePonder,
  requestOfflineMove,
} from '../offlineAiAdapter';

function freshState(): GameState {
  const s = createInitialState();
  s.zobristHash = computeZobristHash(s);
  return s;
}

/**
 * 让引擎桩回一个**由当前局面算出**的合法着法。
 *
 * 写死 `b2e2` 之类的常量并不安全：局面一变（测试里走了一步炮），
 * 那个落点可能已被占据/被堵，于是被三重守卫拒绝 → 适配层触发"去掉历史重试"
 * → 搜索次数从 2 变 3（这正是该用例先前失败的原因）。
 * 真实引擎是"按当前局面"出棋，桩也应如此。
 */
function legalMoveFor(state: GameState) {
  const moves = enumerateLegalMoves(state, state.sideTag);
  const m = moves[0];
  if (!m) throw new Error('局面没有合法着法，无法构造引擎桩');
  return {
    uci:
      internalToUci({
        fromCol: m.fromCol, fromRow: m.fromRow, toCol: m.toCol, toRow: m.toRow,
      }) ?? 'a0a1',
    depth: 8,
    timeMs: 1,
    fromCol: m.fromCol,
    fromRow: m.fromRow,
    toCol: m.toCol,
    toRow: m.toRow,
  };
}

/** 让 mockEngine.search 按传入 request 的局面返回合法着法 */
function stubLegalMove() {
  mockEngine.search.mockImplementation((r: { state: GameState }) =>
    Promise.resolve(legalMoveFor(r.state))
  );
}

describe('本地引擎后台预计算', () => {
  beforeEach(() => {
    jest.useRealTimers();
    mockEngine.search.mockReset();
    mockEngine.stop.mockReset();
    cancelOfflinePonder();
  });

  afterEach(() => {
    cancelOfflinePonder();
  });

  it('预计算以最低优先级 purpose=ponder 入队', async () => {
    stubLegalMove();
    const s = freshState();
    precomputeOfflineHint(s);
    await flush();

    expect(mockEngine.search).toHaveBeenCalledTimes(1);
    expect(mockEngine.search.mock.calls[0][0].purpose).toBe('ponder');
    expect(mockEngine.search.mock.calls[0][0].tier).toBe('hint');
  });

  it('同一局面重复调用不重复启动（命中缓存直接跳过）', async () => {
    stubLegalMove();
    const s = freshState();
    precomputeOfflineHint(s);
    await flush();
    precomputeOfflineHint(s); // 同一局面：应被忽略
    await flush();

    expect(mockEngine.search).toHaveBeenCalledTimes(1);
  });

  it('局面变化后重新启动预计算', async () => {
    stubLegalMove();
    const s = freshState();
    precomputeOfflineHint(s);
    await flush();

    // 走一步（炮二平五），局面指纹与历史长度都变了
    const after = makeMove(s, 23, 7, 4).newState;
    after.zobristHash = computeZobristHash(after);
    precomputeOfflineHint(after);
    await flush();

    expect(mockEngine.search).toHaveBeenCalledTimes(2);
  });

  it('取结果：已完成时立即返回（零等待）', async () => {
    stubLegalMove();
    const s = freshState();
    precomputeOfflineHint(s);
    await flush();

    const p = takeOfflinePonder(s);
    expect(p).not.toBeNull();
    const r = await p;
    expect(r?.toCol).toBe(4);
  });

  it('未预计算的局面 → 返回 null（调用方现场搜索）', () => {
    expect(takeOfflinePonder(freshState())).toBeNull();
  });

  it('取消后结果不落缓存（不会污染后续局面）', async () => {
    // 让预计算一直挂着（永不 settle），直到我们取消
    mockEngine.search.mockImplementation(
      () =>
        new Promise(() => {
          /* 故意不 resolve：模拟仍在搜索 */
        })
    );
    const s = freshState();
    precomputeOfflineHint(s);
    await flush();
    cancelOfflinePonder();

    expect(mockEngine.stop).toHaveBeenCalled();
    // 取消后 take 应拿不到任何东西
    expect(takeOfflinePonder(s)).toBeNull();
  });

  it('引擎报错时预计算静默失败，不抛出', async () => {
    mockEngine.search.mockRejectedValue(new Error('引擎不可用'));
    const s = freshState();
    precomputeOfflineHint(s);
    await flush();

    // 不应产生未处理的 rejection；take 走"未命中/失败"路径
    const p = takeOfflinePonder(s);
    if (p) await expect(p).resolves.toBeNull();
  });

  it('非 playing 局面不启动预计算', () => {
    const s = freshState();
    s.gameStatus = 'red_win';
    precomputeOfflineHint(s);
    expect(mockEngine.search).not.toHaveBeenCalled();
  });

  it('requestOfflineMove 传入 searchmoves 白名单（只让引擎搜合法着法）', async () => {
    stubLegalMove();
    const s = freshState();
    await requestOfflineMove(s, 'medium', 'move');

    const call = mockEngine.search.mock.calls[0][0];
    expect(Array.isArray(call.searchmoves)).toBe(true);
    expect(call.searchmoves.length).toBeGreaterThan(0);
    // 白名单必须是合法 UCI
    for (const u of call.searchmoves) {
      expect(u).toMatch(/^[a-i]\d[a-i]\d$/);
    }
  });
});
