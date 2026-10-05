/**
 * 棋盘纵向预算：在线对局横向留白必须与人机对战一致（【C-81】，2026-10 实机问题）
 *
 * 现象：同一台设备上，在线对局的棋盘比人机对战窄一圈，屏幕两侧留白更宽。
 *
 * 机制：棋盘宽度并非直接等于「屏宽 - BOARD_H_PADDING」，而是先被纵向预算封顶
 * （ChessBoard.tsx:237-240）：
 *   widthScale = (screenWidth - BOARD_H_PADDING) / boardStyle.scaleBaseWidth
 *   scale      = maxBoardHeight > 0 ? min(widthScale, maxBoardHeight / scaleBaseHeight) : widthScale
 *   渲染宽度   = imgWidth * scale
 * 一旦 maxBoardHeight 被纵向压低，棋盘就按高度缩小，两侧留白随之被放大。
 *
 * 两条预算路径唯一的结构性差异：
 *   人机对战 useGameBoardLayout.ts:105-106  topFlow 30, bottomFlow 0
 *   在线对局 lanBattle/index.tsx:362-363    topFlow 30, bottomFlow 30
 * 在线对局多渲染了「我方名称角标行」（棋盘下方一行），它被计入纵向封顶，
 * 于是棋盘被按高度缩小——**横向留白被下方一行角标顺带放大**，这正是实机现象。
 *
 * 为什么不是简单地把 bottomFlowHeight 改成 0：那一行必须占位，否则会压到底栏。
 * 正确修法是声明「棋盘下方那段确实空着的间距」（底栏上边距 dynamicGap），
 * 让下方那一行可以借用它（belowHostSlack），借用量恰好等于封顶溢出量，
 * 因此最坏情况只是内容贴到底栏上沿，绝不会压到底栏。
 *
 * 本文件钉住三条口径：
 *   1. 纵向充裕（竖屏手机）：两页本就同宽，不得被回归成不一致；
 *   2. 纵向吃紧（横屏/平板）：在线对局与���机对战的每侧留白差必须小到肉眼不可辨；
 *   3. 借用不得越界：内容底边永远不超过「宿主 + 声明的空白」，即不压底栏。
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));

import {
  computeBoardLayoutBudget,
  capHostHeightToViewport,
  DEFAULT_MIN_BOARD_HEIGHT,
  type BoardLayoutBudgetResult,
} from '@/utils/chess/boardLayoutBudget';
import { BOARD_H_PADDING, type BoardStyle } from '@/utils/chess/boardStyles';

/** 经典样式几何（boardStyles.ts 中的 classic） */
const classicStyle = {
  id: 'classic',
  imgWidth: 633,
  imgHeight: 699,
  scaleBaseWidth: 631,
  scaleBaseHeight: 699,
  pieceDiameter: 66,
} as BoardStyle;

const NAME_ROW_FLOW_HEIGHT = 30; // height 26 + marginBottom 4
const BOTTOM_BAR_HEIGHT = 62; // GameBottomBar.BOTTOM_BAR_HEIGHT（不 import 组件，避免拖入 RN 依赖）
const VIEWPORT_H = 800;

/** 底栏与棋盘的间距：max(屏宽*3%, 8) */
function gapOf(screenWidth: number): number {
  return Math.max(Math.round(screenWidth * 0.03), 8);
}

/**
 * 复刻两页各自的预算调用。除 bottomFlowHeight / belowHostSlack 外参数完全一致。
 * slack = 0 即修复前的旧行为，可用于对照。
 */
function budget(
  screenWidth: number,
  viewportHeight: number,
  bottomFlowHeight: number,
  slack: number,
  topInset = 0,
  bottomInset = 0
): BoardLayoutBudgetResult {
  const hostHeight = capHostHeightToViewport(
    viewportHeight, // 宿主实测值给足，只让视口封顶生效（Screen 的 flexGrow 会把 flex:1 宿主撑开）
    viewportHeight,
    topInset, // measuredTop
    topInset,
    bottomInset,
    BOTTOM_BAR_HEIGHT + gapOf(screenWidth)
  );
  return computeBoardLayoutBudget(
    {
      hostHeight,
      screenWidth,
      topFlowHeight: NAME_ROW_FLOW_HEIGHT,
      bottomFlowHeight,
      belowHostSlack: slack,
    },
    classicStyle
  );
}

/** 棋盘渲染宽度（与 ChessBoard.tsx:237-240 + 256 同口径） */
function renderedWidth(maxBoardHeight: number | undefined, screenWidth: number): number {
  const widthScale = (screenWidth - BOARD_H_PADDING) / classicStyle.scaleBaseWidth;
  const scale =
    maxBoardHeight && maxBoardHeight > 0
      ? Math.min(widthScale, maxBoardHeight / classicStyle.scaleBaseHeight)
      : widthScale;
  return classicStyle.imgWidth * scale;
}

/** 屏幕每侧留白 */
function sideGap(renderedBoardWidth: number, screenWidth: number): number {
  return (screenWidth - renderedBoardWidth) / 2;
}

describe('棋盘横向留白：在线对局 = 人机对战（【C-81】）', () => {
  const pve = (w: number, h: number) => budget(w, h, 0, 0);
  const lan = (w: number, h: number) => budget(w, h, NAME_ROW_FLOW_HEIGHT, gapOf(w));
  const lanLegacy = (w: number, h: number) => budget(w, h, NAME_ROW_FLOW_HEIGHT, 0);

  it('竖屏（纵向充裕）两页本就同宽，且不被回归成不一致', () => {
    for (const [w, h] of [
      [360, 800],
      [393, 852],
      [414, 896],
    ] as const) {
      const a = renderedWidth(pve(w, h).maxBoardHeight, w);
      const b = renderedWidth(lan(w, h).maxBoardHeight, w);
      expect(b).toBeCloseTo(a, 6);
      expect(sideGap(b, w)).toBeCloseTo(sideGap(a, w), 6);
    }
  });

  it('纵向吃紧（横屏/平板）时，每侧留白差肉眼不可辨（≤3px）', () => {
    for (const [w, h] of [
      [852, 393],
      [800, 360],
      [1024, 768],
      [915, 412],
    ] as const) {
      const pveGap = sideGap(renderedWidth(pve(w, h).maxBoardHeight, w), w);
      const lanGap = sideGap(renderedWidth(lan(w, h).maxBoardHeight, w), w);
      expect(Math.abs(lanGap - pveGap)).toBeLessThanOrEqual(3);
    }
  });

  it('回归钉子：还原修复前的口径（不传 belowHostSlack），横屏每侧会差 13.6px', () => {
    // 说明这条用例的意义：旧算法下同一设备两侧留白差 13.6px，正是实机看到的现象。
    const w = 852;
    const h = 393;
    const pveGap = sideGap(renderedWidth(pve(w, h).maxBoardHeight, w), w);
    const legacyGap = sideGap(renderedWidth(lanLegacy(w, h).maxBoardHeight, w), w);
    expect(legacyGap - pveGap).toBeCloseTo(13.6, 0);
    // 修复后必须显著优于旧口径
    const fixedGap = sideGap(renderedWidth(lan(w, h).maxBoardHeight, w), w);
    expect(Math.abs(fixedGap - pveGap)).toBeLessThan(Math.abs(legacyGap - pveGap));
  });

  it('借用空白不得越界：内容底边不超过「宿主 + 声明的空白」，即绝不压到底栏', () => {
    for (const [w, h] of [
      [360, 800],
      [852, 393],
      [1024, 768],
      [393, 520],
    ] as const) {
      const slack = gapOf(w);
      const hostHeight = capHostHeightToViewport(
        h,
        VIEWPORT_H,
        0,
        0,
        0,
        BOTTOM_BAR_HEIGHT + slack
      );
      const r = computeBoardLayoutBudget(
        {
          hostHeight,
          screenWidth: w,
          topFlowHeight: NAME_ROW_FLOW_HEIGHT,
          bottomFlowHeight: NAME_ROW_FLOW_HEIGHT,
          belowHostSlack: slack,
        },
        classicStyle
      );
      const contentHeight = NAME_ROW_FLOW_HEIGHT + (r.maxBoardHeight ?? 0) + NAME_ROW_FLOW_HEIGHT;
      const contentBottom = r.paddingTop + contentHeight;
      expect(contentBottom).toBeLessThanOrEqual(hostHeight + slack + 1e-6);
    }
  });

  it('默认 belowHostSlack=0 时行为与旧实现逐位一致（其余三页不受影响）', () => {
    const w = 1024;
    const h = 768;
    const explicit = computeBoardLayoutBudget(
      { hostHeight: 400, screenWidth: w, topFlowHeight: 30, bottomFlowHeight: 30 },
      classicStyle
    );
    const omitted = computeBoardLayoutBudget(
      { hostHeight: 400, screenWidth: w, topFlowHeight: 30, bottomFlowHeight: 30, belowHostSlack: 0 },
      classicStyle
    );
    expect(omitted).toEqual(explicit);
  });

  it('宿主未测得时不封顶，两页都由宽度独尊', () => {
    const w = 852;
    const measured = budget(w, 393, NAME_ROW_FLOW_HEIGHT, gapOf(w));
    expect(measured.maxBoardHeight).toBeGreaterThan(0);

    // hostHeight = 0（尚未 onLayout 实测）时不封顶，直接交给宽度
    expect(
      computeBoardLayoutBudget(
        {
          hostHeight: 0,
          screenWidth: w,
          topFlowHeight: NAME_ROW_FLOW_HEIGHT,
          bottomFlowHeight: NAME_ROW_FLOW_HEIGHT,
          belowHostSlack: gapOf(w),
        },
        classicStyle
      )
    ).toEqual({ maxBoardHeight: undefined, paddingTop: 0 });

    // 未封顶时棋盘宽度与任何流内占位无关：留白仅由 BOARD_H_PADDING 决定。
    // 注：经典样式图片 633px 宽而基准宽 631px，故渲染宽度比「屏宽 - BOARD_H_PADDING」
    // 略宽 2px 左右（boardStyles 中既有几何，非本用例引入）。
    const uncapped = renderedWidth(undefined, w);
    expect(uncapped).toBeGreaterThanOrEqual(w - BOARD_H_PADDING);
    expect(sideGap(uncapped, w)).toBeLessThan(BOARD_H_PADDING / 2);
  });

  it('极矮屏仍由 DEFAULT_MIN_BOARD_HEIGHT 保底，且不因借用而缩小', () => {
    const tiny = computeBoardLayoutBudget(
      { hostHeight: 100, screenWidth: 360, topFlowHeight: 30, bottomFlowHeight: 30, belowHostSlack: 12 },
      classicStyle
    );
    expect(tiny.maxBoardHeight).toBe(DEFAULT_MIN_BOARD_HEIGHT);
  });
});
