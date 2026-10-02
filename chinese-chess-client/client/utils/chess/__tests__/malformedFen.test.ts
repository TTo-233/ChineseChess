/**
 * 【R-1 / R-2 回归测试】畸形 FEN 不得让引擎抛 TypeError
 *
 * 这两条曾是可以被任意残局串触发的 P0 崩溃：
 *   R-1  createFromFen 对 `qiPan[col][row]` 的写入没有行宽/行数守卫，
 *        `'9k8/…'`（第一行 10 列）会把 col 推到 9，而 qiPan 外层只按 BOARD_COLS 建
 *        → `qiPan[9][0] = 0` 抛 `TypeError: Cannot set properties of undefined`。
 *   R-2  缺将/缺帅的局面里 pieces[16].col/.row 是 -1，isJiangJun 与
 *        afterMoveStillJiangJun 用它索引 pathPoints[x][y]
 *        → `thisPoints[-1][-1]` 抛 `TypeError: Cannot read properties of undefined`。
 *
 * 修复后的约定（见 GameEngine.ts / MoveCheck.ts 内注释）：
 *   · createFromFen 入口先过 isFenBoardWidthValid，不合法就返回「空棋盘」而不是抛错
 *     ——大量调用方没有 try/catch，抛错会把页面整个打挂。
 *   · isJiangJun / afterMoveStillJiangJun 对缺席或坐标越界的将帅按「未被将」处理。
 * 同时这里钉住**合法 FEN 的解析结果不受影响**（开局 32 子、且不被判将）。
 */
import { createFromFen, isFenBoardWidthValid, isJiangJun, hasAnyLegalMove } from '../GameEngine';
import { afterMoveStillJiangJun } from '../MoveCheck';
import { RED_SIDE, BLACK_SIDE } from '../types';

const aliveCount = (fen: string) => createFromFen(fen).pieces.filter((p) => p.alive).length;
const toPositions = (fen: string) =>
  createFromFen(fen).pieces.map((p) => ({ col: p.col, row: p.row, alive: p.alive }));

describe('R-1：createFromFen 的 FEN 形状校验', () => {
  it.each([
    ['行宽越界（第一行 10 列）', '9k8/9/9/9/9/9/9/9/9/9 w'],
    ['行宽越界（行中数字超界）', '4k4/9/9/9/12/9/9/9/9/9 w'],
    ['行数不足', '4k4/9/9 w'],
    ['行数超出', '9/9/9/9/9/9/9/9/9/9/9/9 w'],
    ['空串', ''],
  ])('%s 不抛异常且退化为空棋盘', (_name, fen) => {
    expect(isFenBoardWidthValid(fen)).toBe(false);
    expect(() => createFromFen(fen)).not.toThrow();
    expect(aliveCount(fen)).toBe(0);
  });

  it('非法字符按宽度计入但不会被当成棋子（既有行为，不崩溃）', () => {
    // 'x' 被 isFenBoardWidthValid 的 [a-z]/i 分支计入 1 列，所以行宽仍是 9 的整数倍、
    // 校验通过；createFromFen 里 usedFen.indexOf('x') === -1 把它静默跳过。
    // 因为非法字符照样让 col++，col 仍在 [0,9) 内 —— 这正是 R-1 不再崩溃的原因。
    const fen = '4k4/9/9/9/4x4/9/9/9/9/9 w';
    expect(isFenBoardWidthValid(fen)).toBe(true);
    expect(() => createFromFen(fen)).not.toThrow();
    expect(aliveCount(fen)).toBe(1); // 只有黑将 k 被解析出来；第 4 行的 'x' 不是棋子
    expect(createFromFen(fen).pieces.some((p) => p.alive && p.row === 4 && p.col === 4)).toBe(false);
  });

  it('合法 FEN 不受守卫影响：开局 32 子齐全', () => {
    const start = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';
    expect(isFenBoardWidthValid(start)).toBe(true);
    expect(aliveCount(start)).toBe(32);
    // 棋子 id == 下标不变式：黑将 0 在 (4,0)、红帅 16 在 (4,9)
    const state = createFromFen(start);
    expect(state.pieces[0]).toMatchObject({ col: 4, row: 0, alive: true });
    expect(state.pieces[16]).toMatchObject({ col: 4, row: 9, alive: true });
    expect(state.sideTag).toBe(RED_SIDE);
    expect(createFromFen(`${start.replace(/ w$/, ' b')}`).sideTag).toBe(BLACK_SIDE);
  });
});

describe('R-2：缺将/缺帅局面按「未被将」处理而不是崩溃', () => {
  // 复现用例：只有黑将（无红帅）+ 一辆黑车，坐标 -1 的 pieces[16] 曾被拿去索引
  const noShuai = '4k4/9/9/9/4r4/9/9/9/9/9 w';

  it('isJiangJun 对缺席的红帅返回 [-1,-1,-1]', () => {
    const state = createFromFen(noShuai);
    expect(state.pieces[16].col).toBe(-1);
    expect(state.pieces[16].alive).toBe(false);
    expect(() => isJiangJun(state, 16)).not.toThrow();
    expect(isJiangJun(state, 16)).toEqual([-1, -1, -1]);
    // 在盘的黑将照常判定（黑车 r 在 (4,0)，红方只有黑将自己 → 未被将）
    expect(isJiangJun(state, 0)).toEqual([-1, -1, -1]);
    // 缺将的局面仍然可判红方是否有棋可走（黑车是黑方的）
    expect(hasAnyLegalMove(state, BLACK_SIDE)).toBe(true);
  });

  it('afterMoveStillJiangJun 对缺席的将帅不崩溃', () => {
    const state = createFromFen(noShuai);
    expect(() =>
      afterMoveStillJiangJun(21, 4, 9, 4, 5, state.qiPan, toPositions(noShuai)),
    ).not.toThrow();
  });

  it('hasAnyLegalMove 不因缺帅而崩溃', () => {
    expect(() => hasAnyLegalMove(createFromFen(noShuai), RED_SIDE)).not.toThrow();
  });

  it('正常开局仍可判将、可行棋', () => {
    const start = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';
    const state = createFromFen(start);
    expect(isJiangJun(state, 16)).toEqual([-1, -1, -1]);
    expect(hasAnyLegalMove(state, RED_SIDE)).toBe(true);
  });
});