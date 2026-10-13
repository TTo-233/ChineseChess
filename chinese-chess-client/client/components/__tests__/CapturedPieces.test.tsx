/**
 * 揭棋 · 被吃棋子槽内容测试
 *
 * 钉住五件最容易回归的事：
 *  1. 语义方向：side='mine'（上带右端）= 我方损失，side='theirs'（下带左端）= 对方损失。
 *     2026-10 实机反馈时这一点搞反过一次，是本文件存在的主要理由。
 *  2. 明/暗口径：暗子被吃只显示**背面图**（铁律 A），明子按 revealedType 的真实棋种取图。
 *  3. 同图合并 + 数量角标：仅 count > 1 时出角标。
 *  4. 象棋局面不渲染（返回 null），因此象棋界面不占位、不变化。
 *  5. **组件自身不含任何定位** —— 定位全交给宿主的角位带（BoardEdgeSlot）。
 *     这条是 2026-10 四轮实机反馈换来的：定位一旦内嵌在这里，
 *     「放到哪个角位」就会反过来改坏宿主那一行的布局契约。
 */

import React from 'react';
import { Image, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { CapturedPieces } from '@/components/CapturedPieces';
import { CAPTURED_ROW_GAP, capturedRowReservedHeight } from '@/utils/chess/jieqiCapturedLayout';
import { getFaceDownImage, getPieceImage } from '@/utils/chess/pieceImages';
import { getBoardStyle } from '@/utils/chess/boardStyles';
import { getBoardStyleId } from '@/utils/chess/boardStyleStore';
import { representativeId } from '@/utils/chess/jieqi';
import { BLACK_SIDE, RED_SIDE, type GameState } from '@/utils/chess/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// 起手揭棋局面：黑 0..15、红 16..31，其中揭棋档下大部分是暗子。
function jieqiFixture(): GameState {
  const pieces = Array.from({ length: 32 }, (_, id) => ({
    id,
    col: id % 9,
    row: id < 16 ? 0 : 9,
    alive: true,
  }));
  return {
    variant: 'jieqi',
    pieces,
    sideTag: RED_SIDE,
    gameStatus: 'playing',
    moveHistory: [],
    hiddenMask: pieces.map((p) => p.id !== 18 && p.id !== 19),
    revealedType: pieces.map((p) => (p.id === 18 ? ('ma' as const) : null)),
  } as unknown as GameState;
}

/** 把若干 id 标记为已被吃掉（沿用 makeMove 对暗子的处理：alive=false 且移出盘面） */
function kill(state: GameState, ids: number[]): GameState {
  const next = { ...state, pieces: state.pieces.map((p) => ({ ...p })) };
  for (const id of ids) {
    const p = next.pieces[id];
    p.alive = false;
    p.col = -1;
    p.row = -1;
  }
  return next;
}

function render(props: React.ComponentProps<typeof CapturedPieces>) {
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<CapturedPieces {...props} />);
  });
  return tree!;
}

/** 取某个 testID 宿主 View 的子树（只看真正的宿主 View，不含 composite 元素） */
function host(tree: TestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    (n) => n.type === View && n.props.testID === testID,
    { deep: true }
  )[0];
}

function imagesIn(node: TestRenderer.ReactTestInstance | null | undefined): unknown[] {
  return node ? node.findAllByType(Image).map((i) => i.props.source) : [];
}

function badgeTextsIn(node: TestRenderer.ReactTestInstance | null | undefined): string[] {
  return node
    ? node
        .findAllByType(Text)
        .map((t) => String(t.props.children))
        .filter((s) => /^\d+$/.test(s))
    : [];
}

describe('CapturedPieces · 方向语义', () => {
  it("side='mine' 取我方（红）损失：红暗子被吃只出背面图", () => {
    const state = kill(jieqiFixture(), [18, 20]);
    const tree = render({
      gameState: state,
      playerSide: 'red',
      side: 'mine',
      maxBoardHeight: 700,
    });
    // 红暗子 → 红方背面图（红暗子被吃，明子 18 翻开成马也出背面）
    expect(imagesIn(tree.root)).toContain(getFaceDownImage(16));
  });

  it('side 切换只换阵营、不换明暗口径：theirs 取黑方损失', () => {
    const state = kill(jieqiFixture(), [18, 20]);
    const tree = render({
      gameState: state,
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 700,
    });
    // 这两颗都是红子 ⇒ 对方（黑）本槽没有内容 ⇒ 不渲染任何棋子
    expect(imagesIn(tree.root)).not.toContain(getFaceDownImage(16));
    expect(imagesIn(tree.root)).toHaveLength(0);

    const blackState = kill(jieqiFixture(), [3]);
    const tree2 = render({
      gameState: blackState,
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 700,
    });
    // 黑暗子 → 黑方背面图，绝不出现红方背面图
    expect(imagesIn(tree2.root)).toContain(getFaceDownImage(0));
    expect(imagesIn(tree2.root)).not.toContain(getFaceDownImage(16));
  });

  it('playerSide 换成黑，两端内容互换', () => {
    const state = kill(jieqiFixture(), [3]);
    const mine = render({ gameState: state, playerSide: 'black', side: 'mine', maxBoardHeight: 700 });
    const theirs = render({ gameState: state, playerSide: 'black', side: 'theirs', maxBoardHeight: 700 });
    expect(imagesIn(mine.root)).toContain(getFaceDownImage(0));
    expect(imagesIn(theirs.root)).not.toContain(getFaceDownImage(0));
  });
});

describe('CapturedPieces · 明暗与合并', () => {
  it('已翻开的明子按 revealedType 的真实棋种取正面图（不是盘面 id）', () => {
    // 16 号是「帅」位（本来就是明子），这里把 18 号「仕」位翻成「马」来验证：
   // 若按盘面 id 取图会显示成「仕」，按真实棋种取才是「马」。
    const base = jieqiFixture();
    expect(getPieceImage(representativeId('ma', RED_SIDE))).toEqual(expect.anything());
    const state = {
      ...base,
      revealedType: base.revealedType.map((t, id) => (id === 18 ? ('ma' as const) : t)),
    } as GameState;
    const tree = render({ gameState: kill(state, [18]), playerSide: 'red', side: 'mine', maxBoardHeight: 700 });
    const imgs = imagesIn(tree.root);
    expect(imgs).toContain(getPieceImage(representativeId('ma', RED_SIDE)));
       // 18 号盘面是「仕」，不能按 id 取到仕的图
    expect(imgs).not.toContain(getPieceImage(18));
  });

  it('同图合并成一个格子，数量 > 1 时才出数字角标', () => {
    // 黑方 1/2 号暗子都是同一张黑背面图，被吃 2 枚应合成 1 格 + 角标「2」
    const tree = render({
      gameState: kill(jieqiFixture(), [1, 2]),
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 700,
      testID: 'captured-theirs',
    });
    const h = host(tree, 'captured-theirs');
    expect(imagesIn(h)).toEqual([getFaceDownImage(0)]);
    expect(badgeTextsIn(h)).toEqual(['2']);
  });

  it('只被吃 1 枚时不显示角标', () => {
    const tree = render({
      gameState: kill(jieqiFixture(), [1]),
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 700,
      testID: 'captured-theirs',
    });
    const h = host(tree, 'captured-theirs');
    expect(imagesIn(h)).toEqual([getFaceDownImage(0)]);
    expect(badgeTextsIn(h)).toEqual([]);
  });
});

describe('CapturedPieces · 不渲染的场景', () => {
  it('无被吃子（开局）不渲染', () => {
    const tree = render({ gameState: jieqiFixture(), playerSide: 'red', side: 'mine', maxBoardHeight: 700 });
    expect(tree.toJSON()).toBeNull();
  });

  it('象棋局面不渲染', () => {
    const base = jieqiFixture();
    const xiangqi = {
      ...base,
      variant: 'xiangqi',
      hiddenMask: base.pieces.map(() => false),
      revealedType: base.pieces.map(() => null),
    } as GameState;
    const tree = render({
      gameState: kill(xiangqi, [1, 2]),
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 700,
    });
    expect(tree.toJSON()).toBeNull();
  });
});

/**
 * 「组件自身不含定位」是这次重构的核心约定：
 * 定位全交给宿主的角位带（BoardEdgeSlot），否则「放到哪个角位」会反过来改坏宿主那一行
 * —— 2026-10 四轮实机反馈全都栽在这上面。
 */
describe('CapturedPieces · 自身不含任何定位', () => {
  function styleOf(tree: TestRenderer.ReactTestRenderer, testID: string) {
    const raw = host(tree, testID)!.props.style;
    const arr = Array.isArray(raw) ? raw : [raw];
    return Object.assign({}, ...arr.filter(Boolean)) as Record<string, unknown>;
  }

  it('没有行高 / 外边距 / 对齐 / 宽度：这些一律由宿主的角位带决定', () => {
    const tree = render({
      gameState: kill(jieqiFixture(), [20]),
      playerSide: 'red',
      side: 'mine',
      maxBoardHeight: 700,
      testID: 'captured-mine',
    });
    const s = styleOf(tree, 'captured-mine');
    expect(s.height).toBeUndefined();
    expect(s.minHeight).toBeUndefined();
    expect(s.marginTop).toBeUndefined();
    expect(s.marginBottom).toBeUndefined();
    expect(s.justifyContent).toBeUndefined();
    expect(s.alignSelf).toBeUndefined();
    expect(s.width).toBeUndefined();
  });

  it('不干扰落子：pointerEvents="none"', () => {
    const tree = render({
      gameState: kill(jieqiFixture(), [20]),
      playerSide: 'red',
      side: 'mine',
      maxBoardHeight: 700,
      testID: 'captured-mine',
    });
    expect(host(tree, 'captured-mine')!.props.pointerEvents).toBe('none');
  });

  it('无内容时返回 null（宿主带据此不占位，棋盘留白不突变）', () => {
    const tree = render({
      gameState: jieqiFixture(),
      playerSide: 'red',
      side: 'mine',
      maxBoardHeight: 700,
    });
    expect(tree.toJSON()).toBeNull();
  });
});

/**
 * 预留高度必须与**实际渲染**同源，否则棋盘边缘会被这排棋子压住。
 *
 * 注意两处口径都必须与组件内部一致：
 *   · 尺寸口径：组件用 useBoardStyle()（当前选择的样式），不是硬编码 classic；
 *   · 屏宽：组件内部用 useWindowDimensions()，jest-expo 下为 750。
 * 任何一处不同源，这个断言就变成在比两个不相干的数字。
 */
describe('CapturedPieces · 预留高度与实际渲染同源', () => {
  function pieceSizeOf(tree: TestRenderer.ReactTestRenderer, testID: string) {
    return host(tree, testID)!.findAllByType(Image)[0].props.style.width as number;
  }

  it('无内容时预留高度为 0（象棋界面不占位）', () => {
    const style = getBoardStyle(getBoardStyleId());
    expect(capturedRowReservedHeight(750, style, false)).toBe(0);
  });

  it('纯按宽度换算时，预留高度 = 实际棋子边长 + 间隙（精确相等）', () => {
    const style = getBoardStyle(getBoardStyleId());
    const reserved = capturedRowReservedHeight(750, style, true);
    // maxBoardHeight 传 0 = 纯按宽度换算，与预留高度同一口径
    const tree = render({
      gameState: kill(jieqiFixture(), [1]),
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 0,
      testID: 'captured-theirs',
    });
    // 预留 = 棋子边长 + CAPTURED_ROW_GAP（间隙由角位带的 gap 承担，组件自身不含 margin）
    expect(pieceSizeOf(tree, 'captured-theirs') + CAPTURED_ROW_GAP).toBe(reserved);
  });

  it('纵向受限时棋子变小，实际占用 ≤ 预留（只多留白，绝不压到棋盘）', () => {
    const style = getBoardStyle(getBoardStyleId());
    const reserved = capturedRowReservedHeight(750, style, true);
    const tree = render({
      gameState: kill(jieqiFixture(), [1]),
      playerSide: 'red',
      side: 'theirs',
      maxBoardHeight: 300, // 纵向吃紧：棋子按高度缩小
      testID: 'captured-theirs',
    });
    expect(pieceSizeOf(tree, 'captured-theirs') + CAPTURED_ROW_GAP).toBeLessThanOrEqual(reserved);
  });
});

