/**
 * 【揭棋】角位带的纵向占位：2026-10 四轮实机问题「标签被顶起 / 离棋盘太远」的最终形态
 *
 * 结构（components/BoardEdgeSlot.tsx 有完整推导）：
 *   [ 上带：上左 = AI 引擎角标 ............ 上右 = 我方损失(右上) ]
 *   [ 棋盘 ]
 *   [ 下带：下左 = 对方损失(左下) .......... 下右 = 空 ]
 *
 * 关键在于**定位与内容解耦**：带负责「贴左/贴右 + 与棋盘的留白」，
 * 内容只是槽里的东西。带的高度 = max(minHeight, 内容自然高度)，
 * 于是上带长高**只**来自它自己的内容，不会传导到下带或棋盘的另一侧。
 *
 * 算式（G = CAPTURED_ROW_GAP，两条带用同一个值 ⇒ 上下留白严格相等）：
 *   上带 = max(AI_ROW_MIN_HEIGHT, P) + G，AI 行基准占位 = AI_ROW_MIN_HEIGHT + G
 *          ⇒ 增量 = max(26, P) - 26 = capturedTopFlowDelta
 *   下带 = P + G                          = capturedRowReservedHeight
 *
 * 本文件钉住：增量算得对、上下留白相等、棋盘尺寸不被改小、下沿不越出宿主。
 */

import {
  AI_ROW_MIN_HEIGHT,
  CAPTURED_ROW_GAP,
  capturedPieceSize,
  capturedRowReservedHeight,
  capturedTopFlowDelta,
} from '@/utils/chess/jieqiCapturedLayout';
import { BOARD_H_PADDING, BOARD_STYLES, type BoardStyle } from '@/utils/chess/boardStyles';
import { computeBoardLayoutBudget } from '@/utils/chess/boardLayoutBudget';

const classicStyle = BOARD_STYLES.find((s) => s.id === 'classic') as BoardStyle;

/** 视口：393×852 典型竖屏手机 */
const VP = 852;
const HOST_TOP = 0;
const HOST_H = 778;
const SCREEN_W = 393;

const budget = (topFlow: number, bottomFlow = 0) =>
  computeBoardLayoutBudget(
    {
      hostHeight: HOST_H,
      screenWidth: SCREEN_W,
      topFlowHeight: topFlow,
      bottomFlowHeight: bottomFlow,
      hostTopY: HOST_TOP,
      viewportHeight: VP,
    },
    classicStyle
  );

/** 上带的总占位（AI 行基准 + 挂载我方损失后的增量 + 带与棋盘的留白） */
function topBandFlow(hasMine: boolean): number {
  return AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP + capturedTopFlowDelta(SCREEN_W, classicStyle, hasMine);
}

describe('揭棋角位带 · 纵向占位', () => {
  const P = capturedPieceSize(SCREEN_W, classicStyle, 0);

  it('上带挂载我方损失的增量 = max(26, P) - 26（无内容时为 0，象棋界面逐像素不变）', () => {
    expect(capturedTopFlowDelta(SCREEN_W, classicStyle, false)).toBe(0);
    expect(capturedTopFlowDelta(SCREEN_W, classicStyle, true)).toBe(Math.max(AI_ROW_MIN_HEIGHT, P) - AI_ROW_MIN_HEIGHT);
  });

  it('棋子边长 ≥ AI 行高时，上下两条带占位完全相等（棋盘上下严格对称）', () => {
    // P ≥ 26 ⇒ 上带高度 max(26, P) = P，与下带的 P 相同 ⇒ 加上同一个 gap 后完全相等。
    // 这是「上下对称」最强的表述，也是用户直接能看出来的性质。
    expect(P).toBeGreaterThanOrEqual(AI_ROW_MIN_HEIGHT);
    expect(topBandFlow(true)).toBe(capturedRowReservedHeight(SCREEN_W, classicStyle, true));
  });

  it('增量只来自被吃棋子，且恰为 max(26, P) - 26', () => {
    // 上带 = AI 行基准 + 增量 + gap；下带 = P + gap。
    // 上带里「AI 行以外的部分」= max(26,P) - 26 + gap，正是这一项多出来的。
    expect(topBandFlow(true) - (AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP)).toBe(
      Math.max(AI_ROW_MIN_HEIGHT, P) - AI_ROW_MIN_HEIGHT
    );
    // 无被吃棋子时：上带只剩 AI 行基准、下带为 0
    expect(topBandFlow(false)).toBe(AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP);
  });

  it('只有下带有内容时，上带仍是 AI 行基准 26（药丸不会被顶离棋盘）', () => {
    // 这正是第 4 轮实机反馈的 bug：把被吃棋子排到 AI 行**下方**/使其成为紧贴棋盘的那一行，
    // 会把 AI 标识行顶走。现在上带高度由 minHeight 兜底，与下带有无内容无关。
    expect(topBandFlow(false)).toBe(AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP);
    // 上带有内容时也只长到 max(26, P)，不会无限长高
    expect(topBandFlow(true)).toBe(Math.max(AI_ROW_MIN_HEIGHT, P) + CAPTURED_ROW_GAP);
    expect(topBandFlow(true)).toBeLessThan(P * 2);
  });

  it('计入占位后棋盘仍以屏幕中线为中心、尺寸不被改小', () => {
    const base = budget(AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP); // 无被吃棋子
    const mine = budget(topBandFlow(true));
    const theirs = budget(AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP, capturedRowReservedHeight(SCREEN_W, classicStyle, true));
    const both = budget(topBandFlow(true), capturedRowReservedHeight(SCREEN_W, classicStyle, true));

    // 竖屏纵向充裕：角位带不该把棋盘改小
    for (const r of [mine, theirs, both]) {
      expect(r.maxBoardHeight).toBeCloseTo(base.maxBoardHeight ?? 0, 6);
    }
    // 【C-90】paddingTop = 中线 - 棋盘高/2 - topFlow - 宿主顶边 ⇒ 中心恒在中线
    const check = (r: ReturnType<typeof budget>, topFlow: number) => {
      const top = HOST_TOP + r.paddingTop + topFlow;
      expect(top + (r.maxBoardHeight ?? 0) / 2).toBeCloseTo(VP / 2, 6);
    };
    check(base, AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP);
    check(mine, topBandFlow(true));
    check(theirs, AI_ROW_MIN_HEIGHT + CAPTURED_ROW_GAP);
    check(both, topBandFlow(true));
  });

  it('棋盘下沿不越出宿主底边（不压底栏）', () => {
    const r = budget(topBandFlow(true), capturedRowReservedHeight(SCREEN_W, classicStyle, true));
    const bottom = HOST_TOP + r.paddingTop + topBandFlow(true) + (r.maxBoardHeight ?? 0);
    expect(bottom).toBeLessThanOrEqual(HOST_H + 1e-6);
  });

  it('棋子边长 ≤ AI 行高时不产生增量（上带高度与无被吃棋子时完全一致）', () => {
    // 极窄屏下 P 可能 ≤ 26，此时带高不变 —— 象棋/窄屏下逐像素不变
    const tiny = { ...classicStyle, pieceDiameter: 1 };
    expect(capturedTopFlowDelta(SCREEN_W, tiny, true)).toBe(0);
  });
});

/**
 * 角位带的**横向**容量核算（2026-10 实机修复时补的回归）。
 *
 * 上带同时要放下「AI 引擎药丸」与「最多 6 张被吃棋子图」。这是本设计里唯一
 * 一个会**横向溢出**的地方（纵向由 flex-end 对齐保证恒定，见 jieqiCapturedLayout 文件头）。
 *
 * 这里估算最坏组合：
 *   · 最宽文案（引擎名 + 难度后缀）；
 *   · 最多 6 张图（单方只有 che/ma/pao/shi/xiang/zu 六种，见 jieqi.ts 的
 *     HIDDEN_MULTISET_BY_SIDE；将帅仅 1 枚必然不合并）。
 * 结论：主流机型都有富余；**超窄屏（≤360pt）会短缺**。
 * 短缺时药丸有 flexShrink:1 作安全阀（screens/game 的 styles.aiNameChip），
 * 代价是文案被截断 —— 这是**已知取舍**，不是 bug。
 *
 * 若日后要让药丸在超窄屏也必然完整，请改这里指明的方向（可横向滚动的战利品条
 * 或角标整体缩放），**不要**动 BoardEdgeSlot 的定位 —— 定位被实机核对过五轮。
 */

/** 药丸宽度 = 边框 2 + 左右 padding 20 + 指示灯 6 + gap 6 + 文案 */
const CHIP_CHROME = 2 + 20 + 6 + 6;
/** 粗略字宽（12px 字号的中文/西文混排，取上界） */
const CHAR_PX = 12 * 1.15;
/** 最长的引擎角标文案 */
const LONGEST_LABEL = '深算引擎（极限）';
/** 每张被吃图左右各 3px margin（CapturedPieces 的 styles.item） */
const ITEM_MARGIN_X = 6;
/** 带的 paddingHorizontal（screens/game 传 12） */
const BAND_PADDING_X = 24;
/** 单方被吃棋子图的种类数上界 */
const MAX_GROUPS = 6;

function chipWidthPx(): number {
  return Math.round(CHIP_CHROME + LONGEST_LABEL.length * CHAR_PX);
}

function capturedRowWidthPx(screenWidth: number, style: BoardStyle): number {
  return MAX_GROUPS * (capturedPieceSize(screenWidth, style, 0) + ITEM_MARGIN_X);
}

describe('揭棋角位带 · 横向容量（药丸 + 最多 6 张被吃图）', () => {
  it('主流机型（≥375pt）有余量，两端不重叠', () => {
    const chip = chipWidthPx();
    for (const style of BOARD_STYLES) {
      for (const w of [375, 393, 412, 430]) {
        const band = w - BAND_PADDING_X;
        expect(chip + capturedRowWidthPx(w, style)).toBeLessThanOrEqual(band);
      }
    }
  });

  it('超窄屏（320pt）放不下 —— 已知取舍：药丸被压缩而不是两端重叠', () => {
    // 钉住这个事实，避免后人误以为「最多 6 张 ⇒ 一定放得下」并据此省掉安全阀。
    const w = 320;
    const chip = chipWidthPx();
    const overflow = chip + capturedRowWidthPx(w, classicStyle) - (w - BAND_PADDING_X);
    expect(overflow).toBeGreaterThan(0);
  });

  it('富余量随屏宽单调增加（屏越宽越宽松）', () => {
    const chip = chipWidthPx();
    const slack = (w: number) => w - BAND_PADDING_X - chip - capturedRowWidthPx(w, classicStyle);
    expect(slack(430)).toBeGreaterThan(slack(393));
    expect(slack(393)).toBeGreaterThan(slack(375));
  });
});

describe('揭棋被吃棋子 · 尺寸换算与 ChessBoard 同源', () => {
  it('棋子边长由「屏宽 - BOARD_H_PADDING」换算，且不依赖棋盘实际高度', () => {
    const byWidth = capturedPieceSize(SCREEN_W, classicStyle, 0);
    expect(capturedPieceSize(SCREEN_W, classicStyle, 699)).toBe(byWidth);
  });

  it('纵向受限时按 maxBoardHeight 缩小，与 ChessBoard 的 min(...) 同序', () => {
    const widthScale = (SCREEN_W - BOARD_H_PADDING) / classicStyle.scaleBaseWidth;
    // maxBoardHeight = scaleBaseHeight ⇒ min(widthScale, 1) = widthScale（纵向不约束）
    expect(capturedPieceSize(SCREEN_W, classicStyle, classicStyle.scaleBaseHeight)).toBe(
      Math.floor(classicStyle.pieceDiameter * widthScale * 0.72)
    );
    // 给一个很紧的高度 ⇒ min() 取高度项 ⇒ 棋子必然更小
    const tight = capturedPieceSize(SCREEN_W, classicStyle, classicStyle.scaleBaseHeight / 2);
    expect(tight).toBeLessThan(capturedPieceSize(SCREEN_W, classicStyle, 0));
  });

  it('有下限 12（小屏/极端样式下角标数字仍可读）', () => {
    expect(capturedPieceSize(120, classicStyle, 0)).toBeGreaterThanOrEqual(12);
  });

  it('三种棋盘样式下都成立（样式只改缩放，不改算式）', () => {
    for (const s of BOARD_STYLES) {
      const p = capturedPieceSize(SCREEN_W, s, 0);
      expect(capturedRowReservedHeight(SCREEN_W, s, true)).toBe(p + CAPTURED_ROW_GAP);
      expect(capturedTopFlowDelta(SCREEN_W, s, true)).toBe(Math.max(AI_ROW_MIN_HEIGHT, p) - AI_ROW_MIN_HEIGHT);
    }
  });
});