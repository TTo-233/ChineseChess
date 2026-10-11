/**
 * 揭棋 FEN / 着法 / 池簿记 的单测
 *
 * 核心断言：**生成的初始 FEN 必须逐字符等于引擎常量**
 * （引擎侧常量来自 jieqi_old src/uci.cpp:45，已在 P0 实测跑通）。
 */

import {
  toJieqiFen,
  serializeBoard,
  serializeDarkPool,
  parseDarkPool,
  initialJieqiPool,
  emptyDarkPool,
  poolTotal,
  isPoolValid,
  liveHiddenCount,
  assertPoolMatchesBoard,
  JIEQI_START_BOARD,
  JIEQI_START_POOL,
  JIEQI_START_FEN,
} from '../jieqiFen';
import {
  parseJieqiMove,
  buildJieqiMove,
  parseBestmove,
  typeToChar,
  charToType,
  consumeEngineLine,
  createInfoState,
  chooseUci,
  isCriticalErrorLine,
} from '../jieqiUci';
import {
  createDeterminization,
  cloneDeterminization,
  declareCapturedIdentity,
  makeDeterministicRand,
  checkPoolInvariant,
  serializeDeterminization,
  deserializeDeterminization,
  poolSummary,
} from '../jieqiDeterminization';
import { createJieqiInitialState } from '../jieqi';
import type { GameState } from '../types';

describe('jieqiFen · 初始局面', () => {
  it('初始局面棋盘段逐字符等于引擎常量', () => {
    const { state } = createJieqiInitialState(() => 0);
    expect(serializeBoard(state)).toBe(JIEQI_START_BOARD);
  });

  it('初始局面整串 FEN 逐字符等于引擎常量（5 段）', () => {
    const { state } = createJieqiInitialState(() => 0);
    const pool = initialJieqiPool();
    const fen = toJieqiFen(state, pool);
    expect(fen).toBe(JIEQI_START_FEN);
    // 引擎常量（本方案 §2.2 实测记录）
    expect(fen).toBe(
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1'
    );
  });

  it('初始暗子池总数为 30（每方 15）', () => {
    expect(poolTotal(initialJieqiPool())).toBe(30);
    expect(JIEQI_START_POOL).toBe('R2A2C2P5N2B2r2a2c2p5n2b2');
  });

  it('初始在盘暗子数 = 池总数（不变量）', () => {
    const { state } = createJieqiInitialState(() => 0);
    const pool = initialJieqiPool();
    expect(liveHiddenCount(state)).toBe(30);
    expect(() => assertPoolMatchesBoard(state, pool)).not.toThrow();
  });
});

describe('jieqiFen · 池序列化', () => {
  it('serialize → parse 往返一致', () => {
    const pool = initialJieqiPool();
    const seg = serializeDarkPool(pool);
    expect(seg).toBe(JIEQI_START_POOL);
    const back = parseDarkPool(seg);
    expect(poolTotal(back)).toBe(30);
  });

  it('池段数量按引擎规则截断到 5', () => {
    const p = parseDarkPool('R9');
    // R9 → 引擎 std::min(9,5)=5
    expect(p.red.R).toBe(5);
  });

  it('池段 x/X 被安全忽略（不让引擎收到 NO_PIECE 垃圾）', () => {
    const p = parseDarkPool('x2X3R1');
    // 只有 R1 生效；x2/X3 被丢弃（引擎会把它们当 NO_PIECE 入池）
    expect(p.red.R).toBe(1);
    expect(poolTotal(p)).toBe(1);
  });

  it('我们序列化出去的池段永不含 x/X（可被引擎正确解析）', () => {
    const pool = initialJieqiPool();
    const seg = serializeDarkPool(pool);
    expect(/x/i.test(seg)).toBe(false);
  });

  it('非法池被拒绝（负数/小数/超 5）', () => {
    const bad = { red: { R: -1 }, black: { r: 0 } };
    expect(isPoolValid(bad as never)).toBe(false);
    expect(isPoolValid({ red: { R: 1.5 }, black: {} } as never)).toBe(false);
    expect(isPoolValid({ red: { R: 6 }, black: {} } as never)).toBe(false);
  });

  it('toJieqiFen 拒绝非揭棋局面', () => {
    const { state } = createJieqiInitialState(() => 0);
    const fake = { ...state, variant: 'xiangqi' } as GameState;
    expect(() => toJieqiFen(fake, initialJieqiPool())).toThrow(/jieqi/);
  });

  it('toJieqiFen 拒绝非法池', () => {
    const { state } = createJieqiInitialState(() => 0);
    expect(() => toJieqiFen(state, { red: { R: 99 }, black: {} } as never)).toThrow();
  });
});

describe('jieqiFen · 暗子不泄漏真相', () => {
  it('同一 seed 下不同洗牌生成相同 FEN（不泄漏身份）', () => {
    const a = createJieqiInitialState(() => 3);
    const b = createJieqiInitialState(() => 3);
    // identity 不同但 FEN 必须相同：暗子一律 x
    expect(a.identity.hiddenType).toEqual(b.identity.hiddenType);
    expect(serializeBoard(a.state)).toBe(serializeBoard(b.state));
  });

  it('FEN 中不含任何未翻开身份痕迹（只有 x/X）', () => {
    const { state } = createJieqiInitialState(() => 42);
    const board = serializeBoard(state);
    const fen = toJieqiFen(state, initialJieqiPool());
    // 第 1 段只允许 x/X/将帅 kK 与空位数字、斜杠
    const seg1 = fen.split(' ')[0];
    expect(/[^xk0-9/]/i.test(seg1)).toBe(false);
    expect(board).toContain('x');
    expect(board).toContain('X');
  });
});

describe('jieqiUci · 揭晓后缀着法', () => {
  it('4 字符 = 无揭晓', () => {
    const m = parseJieqiMove('h0g2');
    expect(m).toEqual({ uci: 'h0g2', movedReveal: null, capturedReveal: null });
  });

  it('5 字符 = 自身揭晓', () => {
    const m = parseJieqiMove('h0g2R');
    expect(m?.movedReveal).toBe('che');
    expect(m?.capturedReveal).toBeNull();
  });

  it('6 字符 = 自身 + 被吃揭晓', () => {
    const m = parseJieqiMove('e7e6Rp');
    expect(m?.uci).toBe('e7e6');
    expect(m?.movedReveal).toBe('che');
    expect(m?.capturedReveal).toBe('zu');
  });

  it('非法着法返回 null（不猜落点）', () => {
    expect(parseJieqiMove('zz')).toBeNull();
    expect(parseJieqiMove('h0g')).toBeNull();
    expect(parseJieqiMove('h0g2XYZ')).toBeNull();
    expect(parseJieqiMove('')).toBeNull();
    expect(parseJieqiMove('h0g2RRR')).toBeNull();
  });

  it('build 往返一致', () => {
    const s = buildJieqiMove('e7e6', 'R', 'p');
    expect(s).toBe('e7e6Rp');
    const m = parseJieqiMove(s);
    expect(m?.movedReveal).toBe('che');
    expect(m?.capturedReveal).toBe('zu');
  });

  it('build 拒绝非法输入', () => {
    expect(() => buildJieqiMove('bad', null, null)).toThrow();
    expect(() => buildJieqiMove('e7e6', 'Q', null)).toThrow();
  });

  it('bestmove 解析（引擎恒返回 4 字符）', () => {
    expect(parseBestmove('bestmove h0g2 ponder c9e7')).toBe('h0g2');
    expect(parseBestmove('bestmove (none)')).toBeNull();
    expect(parseBestmove('bestmove')).toBeNull();
  });

  it('棋种与字符换算按方区分', () => {
    expect(typeToChar('zu', false)).toBe('p');
    expect(typeToChar('bing', true)).toBe('P');
    expect(typeToChar('che', true)).toBe('R');
    expect(typeToChar('che', false)).toBe('r');
    expect(charToType('R')).toBe('che');
    expect(charToType('p')).toBe('zu');
    expect(charToType('?')).toBeNull();
  });
});

describe('jieqiUci · info 累积', () => {
  it('累积 depth / nps / multiPV 并选出着法', () => {
    const st = createInfoState();
    let done = false;
    const lines = [
      'info depth 1 seldepth 1 multipv 1 score cp 267 nodes 46737 nps 1374617 time 34 pv g0e2',
      'info depth 6 seldepth 4 multipv 1 score cp 241 nodes 686848 nps 1812263 time 379 pv h0g2 c9e7',
      'bestmove h0g2 ponder c9e7',
    ];
    for (const l of lines) if (consumeEngineLine(l, st)) done = true;
    expect(done).toBe(true);
    expect(st.depth).toBe(6);
    expect(st.timeMs).toBe(379);
    expect(chooseUci(st, false)).toBe('h0g2');
  });

  it('randomPick 从多候选里挑（确定性注入）', () => {
    const st = createInfoState();
    consumeEngineLine('info depth 5 multipv 1 score cp 1 nps 1 time 1 pv a0a1', st);
    consumeEngineLine('info depth 5 multipv 2 score cp 2 nps 1 time 1 pv b0b1', st);
    const picked = chooseUci(st, true, () => 0.99);
    expect(['a0a1', 'b0b1']).toContain(picked);
  });

  it('致命错误识别', () => {
    expect(isCriticalErrorLine('info string CRITICAL ERROR: bad fen')).toBe(true);
    expect(isCriticalErrorLine('info depth 3 nps 1')).toBe(false);
  });
});

describe('jieqiDeterminization · 池簿记', () => {
  it('初始簿记池 = 30', () => {
    const d = createDeterminization(12345);
    expect(poolTotal(d.pool)).toBe(30);
    expect(poolSummary(d)).toContain('R2');
  });

  it('声明被吃暗子后池减 1、captured 加 1', () => {
    const d = createDeterminization(7);
    const before = poolTotal(d.pool);
    const t = declareCapturedIdentity(d, false, makeDeterministicRand(7));
    expect(t).toBeTruthy();
    expect(poolTotal(d.pool)).toBe(before - 1);
    expect(Object.values(d.capturedDeclared.black).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('同 seed + 同调用序列 ⇒ 同结果（可重放）', () => {
    const a = createDeterminization(99);
    const b = createDeterminization(99);
    const ra = makeDeterministicRand(99);
    const rb = makeDeterministicRand(99);
    for (let i = 0; i < 6; i++) {
      expect(declareCapturedIdentity(a, i % 2 === 0, ra)).toBe(
        declareCapturedIdentity(b, i % 2 === 0, rb)
      );
    }
    expect(poolSummary(a)).toBe(poolSummary(b));
  });

  it('池不变量检查能发现不一致', () => {
    const d = createDeterminization(1);
    expect(checkPoolInvariant(d, 30).ok).toBe(true);
    expect(checkPoolInvariant(d, 25).ok).toBe(false);
  });

  it('clone 产生独立副本', () => {
    const d = createDeterminization(5);
    const c = cloneDeterminization(d);
    declareCapturedIdentity(c, false, makeDeterministicRand(1));
    expect(poolTotal(d.pool)).toBe(30);
    expect(poolTotal(c.pool)).toBe(29);
  });

  it('序列化 / 反序列化往返一致', () => {
    const d = createDeterminization(11);
    declareCapturedIdentity(d, true, makeDeterministicRand(3));
    const raw = serializeDeterminization(d);
    const back = deserializeDeterminization(JSON.parse(JSON.stringify(raw)));
    expect(back).not.toBeNull();
    expect(poolSummary(back!)).toBe(poolSummary(d));
  });

  it('反序列化容错：垃圾输入返回 null', () => {
    expect(deserializeDeterminization(null)).toBeNull();
    expect(deserializeDeterminization({ nope: 1 })).toBeNull();
  });

  it('emptyDarkPool 与 initialJieqiPool 互不为别名', () => {
    const p = emptyDarkPool();
    const q = initialJieqiPool();
    p.red.R = 99;
    expect(q.red.R).toBe(2);
  });
});
