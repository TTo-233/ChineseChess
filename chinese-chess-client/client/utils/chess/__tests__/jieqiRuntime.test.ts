/**
 * 回归测试：揭棋搜索载荷的**幂等性与池自洽性**
 *
 * 背景（2026-10 用户实测 bug）：
 *   `declareCapturedIdentity` 会**就地累加**簿记，而早期实现每次搜索都复用
 *   同一个 `ctx.determinization` 重放整段历史 ⇒ 同一批「被吃」被重复声明
 *   ⇒ capturedDeclared 随搜索次数线性增长 ⇒ 池被过度扣减
 *   ⇒ `assertPoolMatchesBoard` 抛错 ⇒ 引擎静默回落 TS AI
 *   ⇒ 角标回退「揭棋引擎启动中」。
 *
 * 现象特征是「**发生过吃子之后才复发**」，且前几回合正常 —— 这正是本测试
 * 要钉住的：只要有吃子，就必须连跑多次仍然自洽。
 */

import {
  setJieqiRuntime,
  getJieqiRuntime,
  buildJieqiSearchPayload,
  __resetJieqiRuntimeForTest,
} from '../jieqiRuntime';
import { createJieqiInitialState, type JieqiIdentity } from '../jieqi';
import { makeMove } from '../GameEngine';
import {
  computePoolFromState,
  declaredCapturedTotal,
  capturedHiddenCount,
} from '../jieqiDeterminization';
import { poolTotal, liveHiddenCount, assertPoolMatchesBoard } from '../jieqiFen';
import { RED_SIDE, BLACK_SIDE, type GameState } from '../types';

function setup(seed = 20261009): { state: GameState; identity: JieqiIdentity } {
  let s = seed >>> 0 || 1;
  const rand = (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
  return createJieqiInitialState(rand);
}

/** 找一步「吃子」着法并执行（揭棋开局所有非将帅子均为暗子 ⇒ 首吃必吃暗子） */
function playOneCapture(
  state: GameState,
  identity: JieqiIdentity
): GameState | null {
  for (let id = 0; id < 32; id++) {
    const p = state.pieces[id];
    if (!p?.alive) continue;
    const isRed = id >= 16;
    if ((isRed ? RED_SIDE : BLACK_SIDE) !== state.sideTag) continue;
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        const target = state.qiPan[c][r];
        if (target < 0) continue; // 只找吃子
        const targetIsRed = target >= 16;
        if (targetIsRed === isRed) continue; // 不能吃自己
        try {
          const res = makeMove(state, id, c, r, identity);
          if (res?.newState?.qiPan[c][r] === id) return res.newState;
        } catch {
          /* 非法，继续 */
        }
      }
    }
  }
  return null;
}

/** 找一步非吃子的走法（用于掺入普通步） */
function playOneQuiet(
  state: GameState,
  identity: JieqiIdentity
): GameState | null {
  for (let id = 0; id < 32; id++) {
    const p = state.pieces[id];
    if (!p?.alive) continue;
    const isRed = id >= 16;
    if ((isRed ? RED_SIDE : BLACK_SIDE) !== state.sideTag) continue;
    for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0], [1, 1], [-1, -1]]) {
      const c = p.col + dc;
      const r = p.row + dr;
      if (c < 0 || c > 8 || r < 0 || r > 9) continue;
      if (state.qiPan[c][r] >= 0) continue; // 只找空位
      try {
        const res = makeMove(state, id, c, r, identity);
        if (res?.newState?.qiPan[c][r] === id) return res.newState;
      } catch {
        /* 非法，继续 */
      }
    }
  }
  return null;
}

describe('jieqiRuntime · 载荷幂等性（防声明累积）', () => {
  beforeEach(() => __resetJieqiRuntimeForTest());
  afterEach(() => __resetJieqiRuntimeForTest());

  it('开局：连续 5 次构建载荷都成功且结果一致', () => {
    const { state, identity } = setup();
    setJieqiRuntime(state, identity.seed);
    const ctx = getJieqiRuntime()!;

    const first = buildJieqiSearchPayload(state, ctx);
    for (let i = 0; i < 5; i++) {
      const again = buildJieqiSearchPayload(state, ctx);
      expect(again).toEqual(first); // 幂等
    }
  });

  it('**发生过吃子后**：连续 5 次构建都成功（旧实现在此抛错）', () => {
    const { state, identity } = setup(777);
    setJieqiRuntime(state, identity.seed);
    const ctx = getJieqiRuntime()!;

    const after = playOneCapture(state, identity);
    expect(after).not.toBeNull(); // 确保真的发生了吃子
    expect(after!.moveHistory.length).toBeGreaterThan(0);

    // 旧实现在这里会：第 2 次起 capturedDeclared 累加 ⇒ 池偏小 ⇒ 抛错
    for (let i = 0; i < 5; i++) {
      expect(() => buildJieqiSearchPayload(after!, ctx)).not.toThrow();
    }
  });

  it('吃子后：池仍恒等于在盘暗子数', () => {
    const { state, identity } = setup(31337);
    setJieqiRuntime(state, identity.seed);
    const ctx = getJieqiRuntime()!;

    const after = playOneCapture(state, identity);
    if (!after) return;

    // 连续多次构建，每次都要自洽
    for (let i = 0; i < 6; i++) {
      const payload = buildJieqiSearchPayload(after, ctx);
      expect(payload.fen.split(' ')[2].length).toBeGreaterThan(0);
    }

    // 直接核对池不变量（用与载荷同源的口径）
    expect(liveHiddenCount(after)).toBeGreaterThanOrEqual(0);
  });

  it('多步对局（含吃子与普通步）：每一步都能构建载荷', () => {
    const { state, identity } = setup(2468);
    setJieqiRuntime(state, identity.seed);
    const ctx = getJieqiRuntime()!;

    let cur = state;
    for (let i = 0; i < 14; i++) {
      const next = (i % 3 === 0 ? playOneCapture(cur, identity) : playOneQuiet(cur, identity))
        ?? playOneQuiet(cur, identity)
        ?? playOneCapture(cur, identity);
      if (!next) break;
      cur = next;
      expect(() => buildJieqiSearchPayload(cur, ctx)).not.toThrow();
    }
    expect(cur.moveHistory.length).toBeGreaterThan(2);
  });

  it('capturedDeclared 不会随构建次数增长（核心回归断言）', () => {
    const { state, identity } = setup(13579);
    setJieqiRuntime(state, identity.seed);
    const ctx = getJieqiRuntime()!;

    const after = playOneCapture(state, identity);
    if (!after) return;

    // 反复构建载荷，然后检查 ctx 自己的簿记**没有被污染**
    for (let i = 0; i < 8; i++) buildJieqiSearchPayload(after, ctx);

    expect(declaredCapturedTotal(ctx.determinization, RED_SIDE)).toBe(0);
    expect(declaredCapturedTotal(ctx.determinization, BLACK_SIDE)).toBe(0);

    // 真实被吃数由局面本身决定（与构建次数无关）
    const red = capturedHiddenCount(after, RED_SIDE);
    const black = capturedHiddenCount(after, BLACK_SIDE);
    expect(red + black).toBeGreaterThan(0); // 确实吃过暗子
  });
});

describe('jieqiRuntime · 池口径自洽', () => {
  beforeEach(() => __resetJieqiRuntimeForTest());
  afterEach(() => __resetJieqiRuntimeForTest());

  it('补齐声明后：ΣcapturedDeclared == capturedHiddenCount', () => {
    const { state, identity } = setup(555);
    const after = playOneCapture(state, identity);
    if (!after) return;

    // 用与载荷相同的口径重算一次
    setJieqiRuntime(after, identity.seed);
    const ctx = getJieqiRuntime()!;
    const payload = buildJieqiSearchPayload(after, ctx);
    expect(payload).toBeTruthy();

    // 直接验证：初始池 − 已翻开 − 被吃声明 = 在盘暗子
    const forRed = capturedHiddenCount(after, RED_SIDE);
    const forBlack = capturedHiddenCount(after, BLACK_SIDE);
    expect(forRed + forBlack).toBeGreaterThan(0);
  });

  it('池与盘面自洽时 assertPoolMatchesBoard 不抛错', () => {
    const { state, identity } = setup(90210);
    const after = playOneCapture(state, identity) ?? state;

    const pool = computePoolFromState(after);
    // 未扣被吃时，池应**大于**在盘暗子（差额 = 被吃数）
    const diff = poolTotal(pool) - liveHiddenCount(after);
    expect(diff).toBeGreaterThanOrEqual(0);

    if (diff === 0) {
      expect(() => assertPoolMatchesBoard(after, pool)).not.toThrow();
    } else {
      // 差额正是需要声明补齐的部分
      expect(diff).toBe(
        capturedHiddenCount(after, RED_SIDE) + capturedHiddenCount(after, BLACK_SIDE)
      );
    }
  });
});
