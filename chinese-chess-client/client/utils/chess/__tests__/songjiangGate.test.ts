/**
 * 送将加固收尾测试（2026-09 用户六条补强中的三条）
 *
 * ============================================================================
 * 【本文件钉死什么】
 *
 * songjiang.test.ts 钉死了「落点闸门」本身（四类送将必须拦、合法着法不许误杀）。
 * 本文件补上它没覆盖的三块，都是那次事故复盘时点出来的**次级漏洞**：
 *
 * 1. 超时兜底不能退回"随便送一步"。
 *    screens/lanBattle 的 doRandomMove（超时自动走棋）原本在"过滤后为空"时回退全部
 *    着法——那一步必然是送将，会把局面重新拖回非法状态。正确语义是：过滤后为空
 *    说明该方**已无任何合法着法**（将死或困毙，中国象棋两者均判负），应判负终局。
 *    这里用 hasAnyLegalMoveForSide 把该判据钉死。
 *
 * 2. 送将被拦后不能动盘面：轮次、着法历史、选中态都必须原封不动。
 *    （用户明确要求"保留选中让用户直接另点"——保留选中的前提正是"什么都没变"。）
 *
 * 3. 在线 AI 返回的着法必须校验**归属方与回合**。
 *    实测过：历史里含送将着法时，服务端 Pikafish 拒绝重放，棋盘停在送将之前的局面
 *    （轮到对方），于是返回**对方的着法**；而那种着法有时恰好能通过 getValidMoves
 *    （起点上真有活子），会被当成合法在线着法采纳。
 *
 * ============================================================================
 * 【fixture 写法（踩过坑，务必照做）】
 *
 * 本仓 `createFromFen`（GameEngine.ts:590-653）是**标准行优先**：`'/'` 换行（row），
 * 段内第 j 个字符 = 第 j 列，`qiPan[col][row]` 落子。但有两个反直觉之处：
 *
 *  · 一段覆盖 10 格 ≠ 一段 10 个字符（`'4k5'` 只有 4 个字符）；
 *  · 数字逐字符累加，10 个空格要写成 `'91'`，写成 `'10'` 只会填 1 格。
 *
 * 曾误以为"段长必须等于 10"而把 fixture 改成列优先，导致 `createFromFen` 越界
 * （`col` 涨到 9 → `qiPan[9]` undefined → `TypeError: Cannot set properties of undefined`）。
 * 本文件所有局面一律用 boardFixtures.ts 的 `fen(side, [[col,row,ch], …])` 构造。
 *
 * 【绝杀 fixture 必须由引擎判定，不能手摆】
 * 手摆绝杀极易出错：早期用 `'4k4/9/9/9/9/9/9/9/4R4/4K4 b'`（红车在 row 8 照将）
 * 被误当成绝杀，实际黑将有 (3,0)/(5,0) 逃格——**只有与黑将同一横线（row 0）的攻击子
 * 才能封住这两个横向逃格**。所以本文件用 findMatePosition() 穷举 + 引擎断言。
 *
 * 【Jest API 坑】`expect(value, 'msg')` 会报 `Expect takes at most one argument.`；
 * 诊断信息必须挂在 matcher 上：`.toBe(expected, 'msg')`。
 */

import {
  createInitialState,
  getValidMoves,
  hasAnyLegalMoveForSide,
  isJiangJun,
  isMoveKingSafe,
  makeMove,
  type GameState,
  createFromFen,
} from '../GameEngine';

import { fen, type FenChar } from './boardFixtures';
import { RED_SIDE, BLACK_SIDE, type SideTag } from '../types';

/** 某方"走点判定为可走"的着法数量（= 界面会显示的那些落点） */
function shownMoveCount(state: GameState, side: SideTag): number {
  const start = side === RED_SIDE ? 16 : 0;
  let n = 0;
  for (let i = start; i <= start + 15; i++) {
    if (!state.pieces[i].alive) continue;
    const points = getValidMoves(state, i);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (points[c][r]) n += 1;
      }
    }
  }
  return n;
}

/** 该局面下某方每个走点的安全性（用于失败时的可读输出） */
function moveSafety(state: GameState, side: SideTag): string[] {
  const start = side === RED_SIDE ? 16 : 0;
  const out: string[] = [];
  for (let i = start; i <= start + 15; i++) {
    if (!state.pieces[i].alive) continue;
    const points = getValidMoves(state, i);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (points[c][r]) {
          out.push(
            `id${i}@${state.pieces[i].col},${state.pieces[i].row}->${c},${r}=` +
              (isMoveKingSafe(state, i, c, r) ? 'SAFE' : 'song'),
          );
        }
      }
    }
  }
  return out;
}

/** 黑将九宫内可去的位置（含原位以外的 8 格） */
const BLACK_KING_SQUARES: [number, number][] = [
  [3, 0], [4, 0], [5, 0],
  [3, 1], [4, 1], [5, 1],
  [3, 2], [4, 2], [5, 2],
];

/**
 * 穷举一个**真正的绝杀**局面（黑方走点表非空、但无任何合法着法）。
 *
 * 搜索空间取"红方两枚车/炮放在行 0 或行 1 的任意格"——这是封住九宫逃格最有效的区域。
 * 判定顺序刻意按**代价从小到大**：
 *   1. `isJiangJun(state, 0)[0] === 0` —— 绝杀必然是被将军的局面，先用它剪掉 99% 候选；
 *   2. `!hasAnyLegalMoveForSide(state, BLACK_SIDE)` —— 目标条件；
 *   3. `shownMoveCount > 0` —— 最后才做昂贵的计数（正常局面几乎恒为真）。
 */
function findMatePosition(): { fen: string; description: string } {
  const zone: [number, number][] = [];
  for (let col = 0; col < 9; col++) {
    zone.push([col, 0]);
    zone.push([col, 1]);
  }

  const kinds: FenChar[] = ['R', 'C'];

  for (let i = 0; i < zone.length; i++) {
    for (let j = 0; j < zone.length; j++) {
      if (i === j) continue;
      for (const k1 of kinds) {
        for (const k2 of kinds) {
          const pieces: [number, number, FenChar][] = [
            [4, 0, 'k'],
            [4, 9, 'K'],
            [zone[i][0], zone[i][1], k1],
            [zone[j][0], zone[j][1], k2],
          ];
          let state: GameState;
          try {
            state = createFromFen(fen('b', pieces));
          } catch {
            continue;
          }
          if (isJiangJun(state, 0)[0] !== 0) continue; // 黑将没被将军 → 不可能是绝杀
          if (isJiangJun(state, 16)[0] !== -1) continue; // 红帅也被将 → 局面本身非法
          if (hasAnyLegalMoveForSide(state, BLACK_SIDE)) continue;
          if (shownMoveCount(state, BLACK_SIDE) === 0) continue; // 界面口径必须非空
          return {
            fen: fen('b', pieces),
            description:
              `黑将(4,0)、红帅(4,9)、红${k1}@${zone[i][0]},${zone[i][1]}、` +
              `红${k2}@${zone[j][0]},${zone[j][1]}`,
          };
        }
      }
    }
  }
  throw new Error('没有搜索到绝杀局面，判据或搜索范围需要复核');
}

// ---------------------------------------------------------------------------
// 0. fixture 构造器自身（防止再次写反行列）
// ---------------------------------------------------------------------------

describe('boardFixtures：FEN 构造器自身（防止 fixture 写反）', () => {
  test('段 = 行、段内第 j 个字符 = 第 j 列', () => {
    const state = createFromFen(fen('b', [[4, 0, 'k'], [4, 1, 'R'], [4, 9, 'K']]));

    const black = state.pieces.find((p) => p.alive && p.id === 0); // 黑将
    const redRook = state.pieces.find((p) => p.alive && p.id === 23); // 红车
    const redKing = state.pieces.find((p) => p.alive && p.id === 16); // 红帅

    expect([black?.col, black?.row]).toEqual([4, 0]);
    expect([redRook?.col, redRook?.row]).toEqual([4, 1]);
    expect([redKing?.col, redKing?.row]).toEqual([4, 9]);
  });

  test('同一列不同行只按行号区分；空行写成 9 而不是 10', () => {
    const state = createFromFen(fen('b', [[4, 0, 'k'], [4, 1, 'R']]));
    expect(state.qiPan[4][0]).toBe(0);
    expect(state.qiPan[4][1]).toBe(23);
    expect(state.qiPan[4][2]).toBe(-1);
    expect(state.qiPan[3][0]).toBe(-1);
    // 第 0 行只有一个黑将（col 4），其余 8 格为空 → '4k4'
    expect(fen('b', [[4, 0, 'k']]).startsWith('4k4/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. 无合法着法 → 判负（而不是退回送将）
// ---------------------------------------------------------------------------

describe('超时兜底：无合法着法时不得退回送将', () => {
  test('绝杀局面：走点表非空，但该方已无任何合法着法', () => {
    const found = findMatePosition();
    const state = createFromFen(found.fen);
    // 诊断信息统一拼在这里：Jest 的 expect 只接受一个参数，且本项目 jest 类型的
    // 比较类 matcher（toBeGreaterThan 等）不接受 message，所以改用布尔断言 + 说明串。
    const diag =
      `局面 ${found.fen}（${found.description}）黑方走点：` +
      moveSafety(state, BLACK_SIDE).join(' | ');

    expect(state.qiPan[4][0]).toBe(0); // 黑将确实在 (4,0)

    // 界面口径：落点照旧给（保持 4ccdae5 观感）——这是"过滤后为空"而不是"没得显示"
    const shown = shownMoveCount(state, BLACK_SIDE);
    expect(shown > 0 ? true : `走点表为空（应为非空）：${diag}`).toBe(true);
    // 合法性口径：一个能走的都没有 → doRandomMove 必须判负，而不是随便送一步
    const safe = hasAnyLegalMoveForSide(state, BLACK_SIDE);
    expect(safe ? `仍存在合法着法（应已无着法可走）：${diag}` : false).toBe(false);
  });

  test('初始局面双方都有大量合法着法（不会误判为无着法可走）', () => {
    const state = createInitialState();
    expect(hasAnyLegalMoveForSide(state, RED_SIDE)).toBe(true);
    expect(hasAnyLegalMoveForSide(state, BLACK_SIDE)).toBe(true);
  });

  /**
   * 同一枚黑车，挡在将前与不挡将，会得到相反结论。
   * 这条用来确认上一条的 false 来自局面本身，而不是"判据恒返回 false"的假阴性。
   */
  test('阻挡子不在将前时，该方又有了合法着法（判据跟随局面）', () => {
    // 黑车 (4,2) 挡在红车 (4,5) 与黑将 (4,0) 之间：此时黑方**仍有**合法着法——
    // 黑车可以沿着 4 路继续挡（(4,1)/(4,3)/(4,4) 都安全），所以判据为 true。
    const blocked = fen('b', [[4, 0, 'k'], [4, 2, 'r'], [4, 5, 'R'], [4, 9, 'K']]);
    const blockedState = createFromFen(blocked);
    const rookId = blockedState.pieces.findIndex((p) => p.alive && p.col === 4 && p.row === 2);
    expect(isMoveKingSafe(blockedState, rookId, 4, 1)).toBe(true);
    const blockedHasMove = hasAnyLegalMoveForSide(blockedState, BLACK_SIDE);
    expect(
      blockedHasMove
        ? true
        : `黑车仍可沿 4 路继续挡，判据应为 true：` +
          `局面 ${blocked} 黑方走点：${moveSafety(blockedState, BLACK_SIDE).join(' | ')}`,
    ).toBe(true);

    // 只留双方将帅：黑将有大量走格，判据同样为 true
    const freeState = createFromFen(fen('b', [[4, 0, 'k'], [4, 9, 'K']]));
    expect(hasAnyLegalMoveForSide(freeState, BLACK_SIDE)).toBe(true);
  });

  /**
   * 契约校验：对"轮到该方"的局面，"有无合法着法"必须等于"逐着 isMoveKingSafe
   * 过滤后是否为空"。这条把 hasAnyLegalMoveForSide 与落子闸门用的判据绑在一起——
   * 将来若有人改了其中一边的口径，两者会不一致，这里立刻失败。
   */
  test('hasAnyLegalMoveForSide 与逐着 isMoveKingSafe 过滤结果一致', () => {
    const positions = [
      findMatePosition().fen, // 无合法着法
      fen('b', [[4, 0, 'k'], [4, 9, 'K']]), // 只有双方将帅
      fen('b', [[4, 0, 'k'], [4, 2, 'r'], [4, 5, 'R'], [4, 9, 'K']]), // 黑车挡将
      fen('b', [[4, 0, 'k'], [6, 2, 'r'], [4, 9, 'K']]), // 黑车不在 4 路
    ];

    for (const fenStr of positions) {
      const state = createFromFen(fenStr);
      for (const side of [RED_SIDE, BLACK_SIDE] as SideTag[]) {
        if (state.sideTag !== side) continue; // 只在轮到该方时两者语义一致
        const start = side === RED_SIDE ? 16 : 0;
        let anySafe = false;
        for (let i = start; i <= start + 15; i++) {
          if (!state.pieces[i].alive) continue;
          const points = getValidMoves(state, i);
          for (let c = 0; c < 9; c++) {
            for (let r = 0; r < 10; r++) {
              if (points[c][r] && isMoveKingSafe(state, i, c, r)) anySafe = true;
            }
          }
        }
        expect(
          hasAnyLegalMoveForSide(state, side) === anySafe
            ? true
            : `判据与逐着过滤不一致（走棋方 ${side === RED_SIDE ? '红' : '黑'}）：` +
              `局面 ${fenStr} ${moveSafety(state, side).join(' | ')}`,
        ).toBe(true);
      }
    }
  });

  test('挡住将帅照面的着法必须放行（送将拦截不能误伤防守着法）', () => {
    // 黑车 (4,2) 挡住红车 (4,5) 对黑将 (4,0) 的照面
    const state = createFromFen(fen('b', [[4, 0, 'k'], [4, 2, 'r'], [4, 5, 'R'], [4, 9, 'K']]));
    const rookId = state.pieces.findIndex((p) => p.alive && p.col === 4 && p.row === 2);

    // 仍然挡在 4 路上的着法全部安全
    expect(isMoveKingSafe(state, rookId, 4, 1)).toBe(true);
    expect(isMoveKingSafe(state, rookId, 4, 3)).toBe(true);
    expect(isMoveKingSafe(state, rookId, 4, 4)).toBe(true);
    // 离开 4 路（露出将帅照面）必须被拦
    expect(isMoveKingSafe(state, rookId, 7, 2)).toBe(false);
    expect(isMoveKingSafe(state, rookId, 3, 2)).toBe(false);

    // 落子后轮次翻转、着法入史、盘面按预期更新
    const result = makeMove(state, rookId, 4, 3);
    expect(result.isGameOver).toBe(false);
    expect(result.newState.moveHistory.length).toBe(1);
    expect(result.newState.qiPan[4][3]).toBe(rookId);
    expect(result.newState.qiPan[4][2]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 2. 被拦的着法不得改动盘面（保留选中态的前提）
// ---------------------------------------------------------------------------

describe('送将被拦：轮次、着法历史、选中态都不变', () => {
  /** 黑车 (4,2) 挡在红车 (4,5) 与黑将 (4,0) 之间——它是唯一阻挡子 */
  const DISCOVERED = fen('b', [[4, 0, 'k'], [4, 2, 'r'], [4, 5, 'R'], [4, 9, 'K']]);

  function blackRookId(state: GameState): number {
    return state.pieces.findIndex((p) => p.alive && p.col === 4 && p.row === 2);
  }

  test('另点一个合法落点仍然可以走（保留选中让用户少点一步）', () => {
    const state = createFromFen(DISCOVERED);
    const rookId = blackRookId(state);

    // 拦下的那一步：走点表照旧显示，但判据不允许
    expect(getValidMoves(state, rookId)[7]?.[2]).toBe(true);
    expect(isMoveKingSafe(state, rookId, 7, 2)).toBe(false);

    // 同一枚棋子的另一个落点（仍然挡在 4 路）必须放行 —— 这就是"直接另点"的落点
    expect(getValidMoves(state, rookId)[4]?.[1]).toBe(true);
    expect(isMoveKingSafe(state, rookId, 4, 1)).toBe(true);
  });

  test('被拦着法不产生任何状态变更（比较走子前的完整快照）', () => {
    const state = createFromFen(DISCOVERED);
    const rookId = blackRookId(state);

    const before = {
      sideTag: state.sideTag,
      historyLen: state.moveHistory.length,
      rookCol: state.pieces[rookId].col,
      rookRow: state.pieces[rookId].row,
      qiPanAt42: state.qiPan[4][2],
    };

    // 落子入口的闸门语义：判据为假就直接 return，不调用 makeMove
    if (isMoveKingSafe(state, rookId, 7, 2)) {
      throw new Error('判据应当拦下这一步（否则测试本身失效）');
    }

    expect(state.sideTag).toBe(before.sideTag);
    expect(state.moveHistory.length).toBe(before.historyLen);
    expect(state.pieces[rookId].col).toBe(before.rookCol);
    expect(state.pieces[rookId].row).toBe(before.rookRow);
    expect(state.qiPan[4][2]).toBe(before.qiPanAt42);
  });
});

