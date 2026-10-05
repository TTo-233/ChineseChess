/**
 * 棋盘纵向高度预算（人机对战 / 残局闯关 / 在线对局 / 复盘 / 观战共用）。
 *
 * 2026-10 布局改造：被吃棋子摘要条与明细抽屉整体下线后，棋盘上方不再有
 * 「抽屉展开高度 + 摘要条悬浮区」这段必须常驻的预留，预算退化为一条直线约束：
 *
 *   棋盘高度 ≤ 宿主可用高度 - 棋盘上方流内占位 - 棋盘下方流内占位
 *
 * 上下占位只由真实渲染的元素决定（AI/对手名称角标行、dynamicGap、底部操作栏），
 * 其中底部栏高度由页面 onLayout 实测回报（不同模式、不同阶段的按钮数不同）。
 *
 * 历史背景（保留以便理解为何还需要「视口封顶」）：这些页面被 Screen 包在
 * KeyboardAwareScrollView 里，内容容器是 `flexGrow: 1`，允许内容超过视口。
 * 若直接用 onLayout 实测的宿主高度做预算，会形成正反馈
 * （宿主被撑大 → 棋盘反推更大 → 内容更高 → 宿主更大），宽屏下整页可滚动。
 * `capHostHeightToViewport` 把宿主高度限制在「视口内真正可用」以内，正反馈被打断。
 */

import { useMemo } from 'react';
import { useBoardStyle } from './boardStyleStore';
import { BOARD_H_PADDING, type BoardStyle } from './boardStyles';

/**
 * 棋盘最小可用高度（极矮屏下的保底值，与历史实现一致）
 */
export const DEFAULT_MIN_BOARD_HEIGHT = 200;

/**
 * 宿主高度封顶：把 onLayout 实测的宿主高度限制在「视口内真正可用的高度」以内。
 *
 * @param viewportHeight   窗口总高度（useWindowDimensions 的 height）
 * @param measuredTop      宿主顶边相对页面内容顶边的距离（onLayout 的 layout.y，已含顶部安全区）
 * @param topInset         顶部安全区高度（Screen 已在内容之外施加，此处仅用于扣减可用空间）
 * @param bottomInset      底部安全区高度
 * @param belowHostHeight  宿主**之外**、同属本页面的固定高度（宿主内的下方占位由 bottomFlowHeight 负责）
 */
export function capHostHeightToViewport(
  measuredHeight: number,
  viewportHeight: number,
  measuredTop: number,
  topInset: number,
  bottomInset: number,
  belowHostHeight: number
): number {
  if (!(measuredHeight > 0)) return 0;
  const available = viewportHeight - topInset - measuredTop - bottomInset - belowHostHeight;
  // 极窄/极矮或测量异常时不返回负值；此时退回实测值，交由 computeBoardLayoutBudget
  // 的 minBoardHeight 保底逻辑处理（与既有行为一致）。
  if (!(available > 0)) return measuredHeight;
  return Math.min(measuredHeight, available);
}

export interface BoardLayoutBudgetInput {
  /** 内容宿主实测高度（已视口封顶）；0 表示尚未测得 */
  hostHeight: number;
  /** 屏幕宽度（棋盘宽度上限 = 屏宽 - 两侧留白，见 boardStyles 的 BOARD_H_PADDING） */
  screenWidth: number;
  /** 棋盘"上方"流内占位高度（AI 标识/对手名称角标行及其 marginBottom；无则 0） */
  topFlowHeight: number;
  /**
   * 棋盘**下方**、宿主之内的流内占位高度（我方名称角标行等；无则 0）。
   *
   * 它主要参与**垂直定位**（见 computeBoardLayoutBudget 的 paddingTop）。
   * 是否参与棋盘尺寸封顶由 belowHostSlack 决定：横向留白只由 boardStyles 的
   * BOARD_H_PADDING 一处定义，不该因为某个页面在棋盘下方多渲染一行角标，
   * 就顺带把棋盘按高度缩小、两侧留白被放大（【C-81】，见下方说明）。
   */
  bottomFlowHeight: number;
  /**
   * 棋盘宿主**正下方、宿主之外**确认为空的高度（当前各页即底部操作栏与棋盘之间的
   * dynamicGap = max(屏宽*3%, 8)）；默认为 0。
   *
   * 【C-81】2026-10 实机问题：在线对局棋盘两侧留白比人机对战宽。
   * 根因是在线对局多渲染了「我方名称角标行」（棋盘下方一行，占 bottomFlowHeight），
   * 它被计入纵向封顶 → 棋盘被按高度缩小 → 横向留白被顺带放大。
   *
   * 修法不是删掉这一行（它必须占位，否则会压到底栏），而是把「棋盘下方那段
   * 确实空着的间距」显式声明出来：下方内容可以借用这段空白，
   * 于是棋盘宽度重新只由「屏宽 - BOARD_H_PADDING」决定。
   *
   * 安全性：只有该页确实把这段间距留空时才可传，且借用量恰好等于封顶时的溢出量
   * （见 computeBoardLayoutBudget），因此最坏情况只是内容正好贴到底栏上沿，
   * 绝不会压到底栏或与之重叠。
   */
  belowHostSlack?: number;
  /** 棋盘最小高度保底（默认 DEFAULT_MIN_BOARD_HEIGHT） */
  minBoardHeight?: number;
}

export interface BoardLayoutBudgetResult {
  /** 传给 ChessBoard 的棋盘最大高度；宿主未测得时为 undefined（此时棋盘只受宽度约束） */
  maxBoardHeight: number | undefined;
  /** boardContainer 的顶部留白（内容垂直居中）；宿主未测得时为 0 */
  paddingTop: number;
}

/**
 * 求解棋盘高度预算与垂直定位留白。
 *
 * 设棋盘顶边距宿主顶为 topOffset，则棋盘顶边 = topOffset + topFlowHeight。
 * 内容不越界要求 topOffset + (topFlowHeight + board + bottomFlowHeight) ≤ hostHeight，
 * 即 topOffset ≤ hostHeight - topFlowHeight - board - bottomFlowHeight。
 * 取 topOffset = max((hostHeight - 内容高)/2, 0)（垂直居中）代入，解出
 *   board ≤ hostHeight - topFlowHeight - bottomFlowHeight（无需二分，直接线性求解）。
 *
 * 【C-81】belowHostSlack > 0 时，上式的封顶改为「只封顶上方占位」：
 *   board ≤ hostHeight + belowHostSlack - topFlowHeight
 * 即下方的行可以借用棋盘下方那段确实空着的间距（当前即底栏上边距 dynamicGap），
 * 横向宽度重新只由 BOARD_H_PADDING 决定，人机对战与在线对局的留白因此一致。
 */
export function computeBoardLayoutBudget(
  input: BoardLayoutBudgetInput,
  boardStyle: BoardStyle
): BoardLayoutBudgetResult {
  const { hostHeight, screenWidth, topFlowHeight, bottomFlowHeight } = input;
  const belowHostSlack = input.belowHostSlack ?? 0;
  const minBoardHeight = input.minBoardHeight ?? DEFAULT_MIN_BOARD_HEIGHT;

  if (!(hostHeight > 0)) {
    return { maxBoardHeight: undefined, paddingTop: 0 };
  }

  // 宽度约束：棋盘宽度 = 屏宽 - 两侧留白，按当前样式的基准高度换算成可用高度上限
  const widthScale = Math.max(screenWidth - BOARD_H_PADDING, 0) / boardStyle.scaleBaseWidth;
  const widthBoardHeight = widthScale * boardStyle.scaleBaseHeight;

  // 纵向约束 + 保底：极端矮屏下宁可溢出也要保住 minBoardHeight（否则棋盘小到无法落子）
  const flowBudget = hostHeight + belowHostSlack - topFlowHeight - bottomFlowHeight;
  const board = Math.max(Math.min(widthBoardHeight, flowBudget), minBoardHeight);

  // 垂直定位留白：内容在宿主内垂直居中（内容高于宿主时为 0，由下方溢出承载）
  const contentHeight = topFlowHeight + board + bottomFlowHeight;
  const paddingTop = Math.max((hostHeight - contentHeight) / 2, 0);

  return { maxBoardHeight: board, paddingTop };
}

/** 基于当前棋盘样式的预算 Hook（用户切换棋盘样式时同步更新） */
export function useBoardLayoutBudget(input: BoardLayoutBudgetInput): BoardLayoutBudgetResult {
  const boardStyle = useBoardStyle();
  const { hostHeight, screenWidth, topFlowHeight, bottomFlowHeight, belowHostSlack, minBoardHeight } =
    input;
  return useMemo(
    () =>
      computeBoardLayoutBudget(
        {
          hostHeight,
          screenWidth,
          topFlowHeight,
          bottomFlowHeight,
          belowHostSlack,
          minBoardHeight,
        },
        boardStyle
      ),
    [hostHeight, screenWidth, topFlowHeight, bottomFlowHeight, belowHostSlack, minBoardHeight, boardStyle]
  );
}