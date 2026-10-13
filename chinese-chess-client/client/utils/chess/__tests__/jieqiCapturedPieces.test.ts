/**
 * 揭棋 · 被吃棋子角角落实显（jieqiCaptured）
 *
 * ============================ 这个文件钉的四条规则 ============================
 * ① 暗子被吃 → **只显示背面图**，且红/黑两张背面图互不混用。
 *    揭棋规则：暗子被吃后双方都看不到它是什么棋，吃子方也不获得任何新子。
 *    所以这里一旦"按 id 猜"或"按真实身份显示"，就是直接泄露身份（铁律 A），
 *    单测必须能在**不接触 JieqiIdentity** 的前提下把这条钉死。
 * ② 明子被吃 → 显示**真实棋种**的正面图（按 revealedType 取代表 id），
 *    绝不按盘面 id 取（盘面 id 恒等于棋位棋种，按 id 取会把翻开的子显示成棋位棋子）。
 * ③ 同一张图的被吃子合并成一格 + count（角标只在 count > 1 时显示）。
 * ④ 象棋局面（无 variant/hiddenMask/revealedType）复用同一函数不出错：
 *    全部按正面图按 id 合并，行为与旧「被吃棋子」显示一致。
 *
 * 与 jieqiRevealIdentity.test.ts 同源：那边钉「在盘棋子翻开要换图」，
 * 这边钉「被吃棋子该显示哪张图」—— 两者都指向同一个坑（拿图口径写错）。
 */

import { capturedPiecesOfSide } from '../jieqiCaptured';
import { getPieceImage, getFaceDownImage } from '../pieceImages';
import { makeMove, getValidMoves, isMoveKingSafe, cloneGameState } from '../GameEngine';
import { createJieqiInitialState, makeSeededRand, representativeId } from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

/** 造一个"已被吃"的局面：把指定 id 标成阵亡（被吃子的 hiddenMask/revealedType 保持原样） */
function killPieces(state: GameState, ids: number[]): GameState {
  const next = cloneGameState(state);
  for (const id of ids) {
    next.pieces[id].alive = false;
    next.pieces[id].col = -1;
    next.pieces[id].row = -1;
  }
  return next;
}

describe('揭棋 · 被吃棋子显示（明子正面 / 暗子背面）', () => {
  it('开局没有任何被吃子 → 两方都是空数组（不渲染角位）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(11));
    expect(capturedPiecesOfSide(state, RED_SIDE)).toEqual([]);
    expect(capturedPiecesOfSide(state, BLACK_SIDE)).toEqual([]);
  });

  it('暗子被吃 → 显示背面图，且数量合并成一格', () => {
    const { state } = createJieqiInitialState(makeSeededRand(12));
    // 随便吃掉 3 枚红方暗子（开局除帅外全是暗子）
    const dead = [17, 21, 27].map(id => {
      expect(state.hiddenMask![id]).toBe(true);
      return id;
    });
    const groups = capturedPiecesOfSide(killPieces(state, dead), RED_SIDE);

    // 3 枚暗子只有红/黑两张背面图 → 必然合并成 1 格
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].hidden).toBe(true);
    expect(groups[0].side).toBe(RED_SIDE);
    // 背面图按**方**取：红暗子用红背面，绝不能因为 id 不同而出现多格或黑背面
    expect(groups[0].source).toBe(getFaceDownImage(16));
  });

  it('红/黑暗子被吃 → 两张背面图互不混用', () => {
    const { state } = createJieqiInitialState(makeSeededRand(13));
    const red = capturedPiecesOfSide(killPieces(state, [18, 25]), RED_SIDE);
    const black = capturedPiecesOfSide(killPieces(state, [5, 9]), BLACK_SIDE);
    expect(red[0].source).toBe(getFaceDownImage(16));
    expect(black[0].source).toBe(getFaceDownImage(0));
    expect(red[0].source).not.toBe(black[0].source);
  });

  it('已翻开的明子被吃 → 按 revealedType 的真实棋种显示正面图（不是棋位棋种）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(14));
    // 模拟"走子即翻开"后的明子：棋位是马位(21)，真实身份是车
    const next = cloneGameState(state);
    next.hiddenMask![21] = false;
    next.revealedType![21] = 'che';
    next.pieces[21].alive = false;
    next.pieces[21].col = -1;
    next.pieces[21].row = -1;

    const groups = capturedPiecesOfSide(next, RED_SIDE);
    expect(groups).toHaveLength(1);
    expect(groups[0].hidden).toBe(false);
    expect(groups[0].count).toBe(1);
    // 红车代表 id = 23，必须取红车图
    expect(groups[0].source).toBe(getPieceImage(representativeId('che', RED_SIDE)!));
    // 关键回归：不能是棋位（马）的图
    expect(groups[0].source).not.toBe(getPieceImage(21));
  });

  it('同一棋种吃多个 → 合并成一格 + count>1；不同棋种各占一格', () => {
    const { state } = createJieqiInitialState(makeSeededRand(15));
    const next = cloneGameState(state);
    // 红方被吃：2 车（23/24 翻开车）、1 马（21 翻开车）、1 炮（25 翻开车）
    for (const id of [23, 24, 21, 25]) {
      next.hiddenMask![id] = false;
      next.pieces[id].alive = false;
      next.pieces[id].col = -1;
      next.pieces[id].row = -1;
    }
    next.revealedType![23] = 'che';
    next.revealedType![24] = 'che';
    next.revealedType![21] = 'che'; // 棋位是马、真实是车 → 应并进车的格子
    next.revealedType![25] = 'pao';

    const groups = capturedPiecesOfSide(next, RED_SIDE);
    expect(groups).toHaveLength(2);

    const che = groups.find(g => g.source === getPieceImage(23))!;
    expect(che.count).toBe(3);       // 两枚车位 + 一枚马位上的车
    expect(che.hidden).toBe(false);

    const pao = groups.find(g => g.source === getPieceImage(25))!;
    expect(pao.count).toBe(1);       // 单独一格，角标不显示
  });

  it('明子与暗子被吃 → 各自成格（正面图 / 背面图互不合并）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(16));
    const next = cloneGameState(state);
    // 明子：帅(16，恒明子 revealedType=null)
    next.pieces[16].alive = false;
    next.pieces[16].col = -1;
    next.pieces[16].row = -1;
    // 暗子：红相位(19)
    next.pieces[19].alive = false;
    next.pieces[19].col = -1;
    next.pieces[19].row = -1;

    const groups = capturedPiecesOfSide(next, RED_SIDE);
    expect(groups).toHaveLength(2);
    expect(groups.filter(g => g.hidden)).toHaveLength(1);
    expect(groups.filter(g => !g.hidden)).toHaveLength(1);
    // 明子（帅）按 id 取正面图
    expect(groups.find(g => !g.hidden)!.source).toBe(getPieceImage(16));
  });

  it('端到端：真吃一枚暗子后，角位显示背面图；暗子身份不可见', () => {
    const init = createJieqiInitialState(makeSeededRand(17));
    let state = init.state;
    let targetId = -1;

    // 找一步能吃子（或至少走子翻开）的手，落到红方一枚暗子上
    outer:
    for (let id = 16; id < 32 && targetId < 0; id++) {
      if (state.hiddenMask![id] !== true) continue;
      state.sideTag = RED_SIDE;
      const pts = getValidMoves(state, id);
      for (let c = 0; c < BOARD_COLS; c++) {
        for (let r = 0; r < BOARD_ROWS; r++) {
          if (!pts[c][r] || !isMoveKingSafe(state, id, c, r)) continue;
          // 只接受"这步能吃到一个黑子"的着法，用于验证 capture 链路
          const eaten = state.qiPan[c][r];
          if (eaten < 0 || eaten >= 16) continue;
          const eatenWasHidden = state.hiddenMask![eaten] === true;
          state = makeMove(state, id, c, r, init.identity).newState;
          // 被吃的暗子：hiddenMask 保持 true（铁律 A：身份既不上盘也不暴露）
          if (eatenWasHidden && !state.pieces[eaten].alive) {
            const groups = capturedPiecesOfSide(state, BLACK_SIDE);
            expect(groups.length).toBeGreaterThan(0);
            const eatenGroup = groups.find(g => g.hidden)!;
            expect(eatenGroup.count).toBe(1);
            // 黑暗子被吃 → 黑背面图
            expect(eatenGroup.source).toBe(getFaceDownImage(0));
            // 绝不能是按 id 或真实身份取的正面图
            expect(eatenGroup.source).not.toBe(getPieceImage(eaten));
          }
          targetId = id;
          break outer;
        }
      }
    }
    expect(targetId).toBeGreaterThanOrEqual(0);
  });

  it('象棋局面（无揭棋字段）复用同一函数：按正面图按 id 合并，不出错', () => {
    const state: GameState = {
      qiPan: Array.from({ length: BOARD_COLS }, () => new Array<number>(BOARD_ROWS).fill(-1)),
      // 默认全部"在盘"，只把下面 killPieces 点名的标成被吃
      pieces: Array.from({ length: 32 }, (_, i) => ({ id: i, col: 0, row: 0, alive: true })),
      sideTag: RED_SIDE,
      moveHistory: [],
      gameStatus: 'playing',
      isCheck: false,
      checkMessage: '',
      zobristHash: 0,
    };
    // 黑方被吃：两车(7,8)、两马(5,6)、一卒(11)；其余棋子仍在盘
    const next = killPieces(state, [7, 8, 5, 6, 11]);
    const redGroups = capturedPiecesOfSide(next, BLACK_SIDE);
    expect(redGroups).toHaveLength(3);
    // 两个车 id 共一张图 → 合并
    expect(redGroups.find(g => g.source === getPieceImage(7))!.count).toBe(2);
    expect(redGroups.find(g => g.source === getPieceImage(5))!.count).toBe(2);
    expect(redGroups.find(g => g.source === getPieceImage(11))!.count).toBe(1);
    // 没有暗子分组
    expect(redGroups.every(g => !g.hidden)).toBe(true);
  });
});