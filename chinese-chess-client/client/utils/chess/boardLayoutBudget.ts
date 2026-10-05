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

/** 棋盘最小可用高度（极矮屏下的保底值，与历史实现一致） */
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
  /** 棋盘"下方"流内占位高度（dynamicGap + 底部操作栏/控制区；均在宿主内） */
  bottomFlowHeight: number;
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
 */
export function computeBoardLayoutBudget(
  input: BoardLayoutBudgetInput,
  boardStyle: BoardStyle
): BoardLayoutBudgetResult {
  const { hostHeight, screenWidth, topFlowHeight, bottomFlowHeight } = input;
  const minBoardHeight = input.minBoardHeight ?? DEFAULT_MIN_BOARD_HEIGHT;

  if (!(hostHeight > 0)) {
    return { maxBoardHeight: undefined, paddingTop: 0 };
  }

  // 宽度约束：棋盘宽度 = 屏宽 - 两侧留白，按当前样式的基准高度换算成可用高度上限
  const widthScale = Math.max(screenWidth - BOARD_H_PADDING, 0) / boardStyle.scaleBaseWidth;
  const widthBoardHeight = widthScale * boardStyle.scaleBaseHeight;

  // 纵向约束 + 保底：极端矮屏下宁可溢出也要保住 minBoardHeight（否则棋盘小到无法落子）
  const flowBudget = hostHeight - topFlowHeight - bottomFlowHeight;
  const board = Math.max(Math.min(widthBoardHeight, flowBudget), minBoardHeight);

  // 垂直定位留白：内容在宿主内垂直居中（内容高于宿主时为 0，由下方溢出承载）
  const contentHeight = topFlowHeight + board + bottomFlowHeight;
  const paddingTop = Math.max((hostHeight - contentHeight) / 2, 0);

  return { maxBoardHeight: board, paddingTop };
}

/** 基于当前棋盘样式的预算 Hook（用户切换棋盘样式时同步更新） */
export function useBoardLayoutBudget(input: BoardLayoutBudgetInput): BoardLayoutBudgetResult {
  const boardStyle = useBoardStyle();
  const { hostHeight, screenWidth, topFlowHeight, bottomFlowHeight, minBoardHeight } = input;
  return useMemo(
    () =>
      computeBoardLayoutBudget(
        { hostHeight, screenWidth, topFlowHeight, bottomFlowHeight, minBoardHeight },
        boardStyle
      ),
    [hostHeight, screenWidth, topFlowHeight, bottomFlowHeight, minBoardHeight, boardStyle]
  );
}