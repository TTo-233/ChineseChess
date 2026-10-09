/**
 * 揭棋 · 随机身份必须真的生效（jieqiRevealIdentity）
 *
 * ============================ 这个文件为什么存在 ============================
 * 首版实现里，引擎侧完全正确（身份表洗牌正常、`makeMove` 正常写入
 * `revealedType`、翻开即显形），全量 667 条测试也全绿 ——
 * 但真机上「翻开」看起来毫无变化，永远是普通象棋布局。
 *
 * 根因在**渲染层**：`getJieqiPieceImage` 对「已翻开的子」回落到
 * `getPieceImage(pieceId)`。而揭棋的盘面 id **恒等于棋位棋种**
 * （决策 A：id 永不因翻开而改变），所以翻开后取到的恰好是
 * 「该棋位本来的那张正面图」—— 于是棋盘上看起来就是普通象棋。
 *
 * 也就是说：**引擎全对、测试全绿、唯独界面少传了一个参数。**
 * 单测覆盖不到它，是因为没有任何测试断言「渲染用的图 = 真实棋种的图」。
 * 本文件就钉这一条。
 */

import {
  getJieqiPieceImage, getPieceImage, getFaceDownImage, getJieqiPieceName,
} from '../pieceImages';
import { makeMove, getValidMoves, isMoveKingSafe, cloneGameState } from '../GameEngine';
import { createJieqiInitialState, makeSeededRand, representativeId } from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS } from '../types';

describe('揭棋 · 翻开后必须显示真实棋种（不是棋位棋种）', () => {
  it('getJieqiPieceImage：已翻开的子按 revealedType 取图，且与按 id 取的**不同**', () => {
    // 走遍全部 30 个暗子占位：翻开后取到的图必须与「棋位图」不同
    let checked = 0;
    let differed = 0;
    for (const seed of [201, 202, 203, 204]) {
      const { state, identity } = createJieqiInitialState(makeSeededRand(seed));
      for (let id = 1; id < 32; id++) {
        if (state.hiddenMask![id] !== true) continue;
        const trueType = identity.hiddenType[id]!;

        const img = getJieqiPieceImage(id, false, trueType, id <= 15 ? 'black' : 'red');
        const placeholderImg = getPieceImage(id);

        // 真实棋种的代表 id 取到的图，必须与上面一致
        const rep = representativeId(trueType, id <= 15 ? BLACK_SIDE : RED_SIDE)!;
        expect(img).toBe(getPieceImage(rep));

        if (img !== placeholderImg) differed++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    // 30 个占位里约 4/5 的真实身份 ≠ 棋位棋种，故「图不同」应占绝大多数
    expect(differed / checked).toBeGreaterThan(0.7);
  });

  it('暗子取背面图；将/帅（revealedType 为 null）取自己的正面图', () => {
    // 将帅永远明面朝上，revealedType 为 null ⇒ 回落按 id 取（就是将/帅图）
    expect(getJieqiPieceImage(0, false, null, 'black')).toBe(getPieceImage(0));
    expect(getJieqiPieceImage(16, false, null, 'red')).toBe(getPieceImage(16));

    // 暗子一律背面，且红黑两张不同
    expect(getJieqiPieceImage(7, true, null, 'black')).toBe(getFaceDownImage(7));
    expect(getJieqiPieceImage(23, true, null, 'red')).toBe(getFaceDownImage(23));
    expect(getFaceDownImage(7)).not.toBe(getFaceDownImage(23));
  });

  it('端到端：翻开一枚暗子后，它显示的图必须与翻开前不同', () => {
    let flipsChecked = 0;
    for (const seed of [301, 302, 303]) {
      const init = createJieqiInitialState(makeSeededRand(seed));
      let state = init.state;
      const identity = init.identity;

      // 找一个真身 ≠ 棋位棋种的暗子走一步
      for (let id = 16; id < 32 && flipsChecked < 12; id++) {
        if (state.hiddenMask![id] !== true) continue;
        const trueType = identity.hiddenType[id]!;
        if (trueType === null) continue;
        // 若真实身份恰等于棋位棋种，跳过（那种情况两图本来就相同，测不出来）
        const rep = representativeId(trueType, RED_SIDE)!;
        if (getPieceImage(rep) === getPieceImage(id)) continue;

        state.sideTag = RED_SIDE;
        const pts = getValidMoves(state, id);
        let moved = false;
        for (let c = 0; c < BOARD_COLS && !moved; c++) {
          for (let r = 0; r < BOARD_ROWS && !moved; r++) {
            if (!pts[c][r] || !isMoveKingSafe(state, id, c, r)) continue;
            state = makeMove(state, id, c, r, identity).newState;
            moved = true;
          }
        }
        if (!moved) continue;

        // 引擎确实记录了真实棋种
        expect(state.hiddenMask![id]).toBe(false);
        expect(state.revealedType![id]).toBe(trueType);

        // 渲染取到的图 = 真实棋种的图 ≠ 棋位图
        const img = getJieqiPieceImage(id, false, state.revealedType![id], 'red');
        expect(img).toBe(getPieceImage(rep));
        expect(img).not.toBe(getPieceImage(id));
        flipsChecked++;
      }
    }
    expect(flipsChecked).toBeGreaterThan(0);
  });

  it('revealedType 决定名字：暗子不给名字（铁律 A）', () => {
    // 暗子：即使内部知道身份，UI 层也不得显示
    expect(getJieqiPieceName(23, true, null)).toBeNull();
    // 已翻开：显示真实棋种名
    expect(getJieqiPieceName(23, false, 'che')).toBe('车');
    expect(getJieqiPieceName(11, false, 'ma')).toBe('马');
    // 明子（将帅）按 id
    expect(getJieqiPieceName(16, false, null)).toBe('帅');
  });

  it('cloneGameState 保留 revealedType（渲染读的是它）', () => {
    const init = createJieqiInitialState(makeSeededRand(401));
    let state = init.state;
    let target = -1;
    for (let id = 16; id < 32; id++) {
      if (state.hiddenMask![id] !== true) continue;
      state.sideTag = RED_SIDE;
      const pts = getValidMoves(state, id);
      for (let c = 0; c < BOARD_COLS && target < 0; c++) {
        for (let r = 0; r < BOARD_ROWS && target < 0; r++) {
          if (!pts[c][r] || !isMoveKingSafe(state, id, c, r)) continue;
          state = makeMove(state, id, c, r, init.identity).newState;
          target = id;
        }
      }
      break;
    }
    expect(target).toBeGreaterThanOrEqual(0);

    const copy = cloneGameState(state);
    expect(copy.revealedType![target]).toBe(state.revealedType![target]);
    // 克隆是深拷贝，改一边不影响另一边
    copy.revealedType![target] = null;
    expect(state.revealedType![target]).not.toBeNull();
  });
});
