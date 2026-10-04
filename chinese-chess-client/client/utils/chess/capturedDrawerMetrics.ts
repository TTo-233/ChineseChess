/**
 * 棋盘高度预算 + 被吃棋子明细抽屉高度估算（人机对战/联机对战/复盘/观战共用）。
 *
 * 背景：抽屉自"标题行正下方"向下展开（绝对定位浮层）。为了让抽屉展开时
 * 底边不压到棋盘、且不与摘要条/名称角标行重叠，棋盘上方必须预留出
 * 「名称角标行 + 被吃棋子摘要条 + 抽屉展开高度」这段空间（无论抽屉是否点开都要预留）。
 *
 * 抽屉实际尺寸与棋盘同步缩放：抽屉棋子图 = 80% 棋子图尺寸，
 * 缩放比例 = min(宽度缩放, 棋盘高度缩放)。因此"抽屉展开高度"与"棋盘可用高度"
 * 互相耦合（棋盘越小抽屉越小、需要的预留也越小），本模块通过二分求解，
 * 保证预算里预留的抽屉高度与抽屉真实展开高度始终一致——
 * 既不会像旧实现那样在宽屏下按宽度缩放高估抽屉、把棋盘压缩得过小，
 * 也不会预留不足导致抽屉压到棋盘。
 *
 * 尺寸口径与 ChessBoard / CapturedPiecesDrawer 完全一致：
 * - 抽屉内棋子图 = 80% 棋子图尺寸；
 * - 每项对称外边距 3（项宽/行高 = 棋子图 + 6）；
 * - 抽屉上下内边距 10×2、左右内边距 12×2，行内边距 4×2；
 * - 抽屉按棋子类型分组展示（同类型合并为 1 项 + 数量角标），单方最多 7 种类型，按 7 项估算。
 */

import { useMemo } from 'react';
import { useBoardStyle } from './boardStyleStore';
import { BOARD_H_PADDING, type BoardStyle } from './boardStyles';

/** 抽屉按棋子类型分组展示（同类型合并为 1 项 + 右上角数量角标），单方最多 7 种类型
 * （将/帅、士/仕、象/相、马、车、炮、兵/卒）。抽屉展开高度按最多 7 项估算——
 * 而非按 16 颗原始棋子逐颗占位（旧口径会高估约一倍行数，把棋盘压缩得过小）。 */
const MAX_CAPTURED_GROUPS = 7;
/** 被吃棋子摘要条固定行高（与 ChessBoard 的 CAPTURED_SUMMARY_H 一致） */
const STRIP_SUMMARY_H = 30;
/** 摘要条相对棋盘顶边的基础悬浮间距（capturedStrip 的 marginBottom 基准值） */
const STRIP_BASE_GAP = 8;
/** 棋盘最小可用高度（极矮屏下的保底值，与历史实现一致） */
const DEFAULT_MIN_BOARD_HEIGHT = 200;
/** 二分求解迭代次数（浮点区间二分，64 次精度已远超像素级） */
const BISECT_ITER = 64;

/**
 * 宿主高度封顶：把 onLayout 实测的宿主高度限制在「视口内真正可用的高度」以内。
 *
 * 背景（宽屏纵向溢出的根因）：这些页面被 Screen 包在 KeyboardAwareScrollView 里，
 * 其内容容器是 `flexGrow: 1`。`flexGrow: 1` 允许内容**超过**视口——内部的
 * `flex: 1` 容器会按内容实际高度撑开。于是形成正反馈：
 *   宿主实测高度被撑大 → 棋盘按更大的 hostHeight 反推尺寸 → 棋盘更高 → 内容更高 → …
 * 结果宽屏下内容高 1588 > 视口 805，页面整体可滚动。
 *
 * 封顶后 `maxBoardHeight` 不再依赖被撑大的实测值，正反馈被打断：宿主取到真实剩余
 * 空间 → 棋盘按真实空间缩小 → 内容回到一屏内 → 实测值本身也回落到封顶值（稳定不动点）。
 *
 * @param viewportHeight 窗口总高度（Dimensions 的 window 高度）
 * @param measuredTop    宿主顶边相对页面内容顶边的距离（onLayout 的 layout.y，已含顶部栏与顶部安全区）
 * @param topInset       顶部安全区高度（Screen 已在内容之外施加，此处仅用于扣减可用空间）
 * @param bottomInset    底部安全区高度
 * @param belowHostHeight 宿主**之外**、同属本页面的固定高度（底部栏等；宿主内的下方占位由 bottomFlowHeight 负责，不在此列）
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
  // 极窄/极矮或测量异常时不返回负值；此时退回实测值交由 computeBoardLayoutBudget 的
  // minBoardHeight 保底逻辑处理（与既有行为一致）。
  if (!(available > 0)) return measuredHeight;
  return Math.min(measuredHeight, available);
}

/**
 * 给定缩放比例下的抽屉展开态高度（与 CapturedPiecesDrawer 实际渲染口径一致）。
 */
export function drawerHeightAtScale(screenWidth: number, boardStyle: BoardStyle, scale: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0.0001;
  const pieceSize = Math.floor(boardStyle.pieceDiameter * safeScale);
  const capturedPieceSize = Math.max(Math.floor(pieceSize * 0.8), 1);
  const itemSize = capturedPieceSize + 6; // 项宽/行高 = 棋子图 + 对称外边距 3×2
  const availW = Math.max(screenWidth - 24 - 8, itemSize); // 抽屉左右内边距 12×2 + 行内边距 4×2
  const perRow = Math.max(Math.floor(availW / itemSize), 1);
  const rows = Math.ceil(MAX_CAPTURED_GROUPS / perRow);
  return 20 + rows * itemSize; // 上下内边距 10×2 + 行数 × 行高
}

export interface BoardLayoutBudgetInput {
  /** 宿主（标题行下方内容区）实测高度；0 表示尚未测得 */
  hostHeight: number;
  /** 屏幕宽度 */
  screenWidth: number;
  /** 传给 ChessBoard 的 capturedStripOffset（有名称角标行的页面为 30，复盘无角标行为 0） */
  stripOffset: number;
  /** 棋盘"上方"流内占位高度（AI 标识/名称角标行，含其 marginBottom；无则 0） */
  topFlowHeight: number;
  /** 棋盘"下方"流内占位高度（下方角标行 + dynamicGap + 底部操作栏/控制区；均在宿主内） */
  bottomFlowHeight: number;
  /** 棋盘最小高度保底（默认 200） */
  minBoardHeight?: number;
}

export interface BoardLayoutBudgetResult {
  /** 传给 ChessBoard / CapturedPiecesDrawer 的棋盘最大高度；宿主未测得时为 undefined */
  maxBoardHeight: number | undefined;
  /** boardContainer 的顶部留白（垂直定位用）；宿主未测得时为 0 */
  paddingTop: number;
  /** 预算采用的抽屉展开高度（= 抽屉真实展开高度） */
  drawerHeight: number;
}

/**
 * 求解棋盘高度预算与垂直定位留白。
 *
 * 约束（棋盘上方预留，条件 1）：棋盘顶边 ≥ 抽屉展开高度 + 摘要条悬浮区(38 + stripOffset)。
 * 定位（条件 2）：内容（上方角标行 + 棋盘 + 下方占位）在宿主内垂直居中；
 * 若居中时上方预留不足，则整体下移贴住预留区（相当于把下方空白让给棋盘），棋盘取到预留允许的最大尺寸。
 *
 * 推导：设内容顶部距宿主顶为 topOffset，棋盘顶边 = topOffset + topFlowHeight。
 * 需要 topOffset ≥ drawerH + 38 + stripOffset - topFlowHeight；
 * 内容不越界：topOffset + (topFlowHeight + board + bottomFlowHeight) ≤ hostHeight。
 * 化简得棋盘上限 board ≤ hostHeight - drawerH - (38 + stripOffset) - bottomFlowHeight。
 * drawerH 与 board 通过缩放耦合，利用 fits 的单调性二分求解。
 */
export function computeBoardLayoutBudget(
  input: BoardLayoutBudgetInput,
  boardStyle: BoardStyle
): BoardLayoutBudgetResult {
  const { hostHeight, screenWidth, stripOffset, topFlowHeight, bottomFlowHeight } = input;
  const minBoardHeight = input.minBoardHeight ?? DEFAULT_MIN_BOARD_HEIGHT;

  if (!(hostHeight > 0)) {
    return { maxBoardHeight: undefined, paddingTop: 0, drawerHeight: 0 };
  }

  const widthScale = (screenWidth - BOARD_H_PADDING) / boardStyle.scaleBaseWidth;
  const widthBoardHeight = widthScale * boardStyle.scaleBaseHeight;
  // 摘要条悬浮区：摘要条高 30 + 基础间距 8 + 角标行让位偏移 stripOffset
  const stripReserve = STRIP_BASE_GAP + stripOffset + STRIP_SUMMARY_H;

  // 抽屉高度随棋盘缩放呈「整数阶梯」式单调不减，因此谓词
  // fits(board) = board ≤ hostHeight - drawerHeight(board) - stripReserve - bottomFlowHeight
  // 关于 board 单调（小棋盘恒成立、大棋盘恒不成立），可二分求最大可行棋盘高度。
  const drawerAtBoard = (boardValue: number) =>
    drawerHeightAtScale(
      screenWidth,
      boardStyle,
      Math.min(widthScale, boardValue / boardStyle.scaleBaseHeight)
    );
  const fits = (boardValue: number) =>
    boardValue <= hostHeight - drawerAtBoard(boardValue) - stripReserve - bottomFlowHeight;

  const upperBound = Math.min(widthBoardHeight, hostHeight);
  let board: number;
  if (upperBound <= minBoardHeight || fits(upperBound)) {
    // 宽度/宿主受限（抽屉放得下），或上限已低于保底高度
    board = Math.max(upperBound, minBoardHeight);
  } else if (!fits(minBoardHeight)) {
    // 极矮屏：保底高度也放不下，接受溢出
    board = minBoardHeight;
  } else {
    // 二分求 [minBoardHeight, upperBound] 内满足预留约束的最大棋盘高度
    let lo = minBoardHeight;
    let hi = upperBound;
    for (let i = 0; i < BISECT_ITER; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    board = lo;
  }

  const drawerH = drawerAtBoard(board);

  // 垂直定位留白：优先垂直居中；居中时上方预留不足则下移贴住预留区
  const contentHeight = topFlowHeight + board + bottomFlowHeight;
  const centeredTop = (hostHeight - contentHeight) / 2;
  const minTop = drawerH + stripReserve - topFlowHeight;
  const paddingTop = Math.max(centeredTop, minTop, 0);

  return { maxBoardHeight: board, paddingTop, drawerHeight: drawerH };
}

/**
 * 基于当前棋盘样式的预算 Hook（样式切换时同步更新）。
 */
export function useBoardLayoutBudget(input: BoardLayoutBudgetInput): BoardLayoutBudgetResult {
  const boardStyle = useBoardStyle();
  const { hostHeight, screenWidth, stripOffset, topFlowHeight, bottomFlowHeight, minBoardHeight } = input;
  return useMemo(
    () =>
      computeBoardLayoutBudget(
        { hostHeight, screenWidth, stripOffset, topFlowHeight, bottomFlowHeight, minBoardHeight },
        boardStyle
      ),
    [hostHeight, screenWidth, stripOffset, topFlowHeight, bottomFlowHeight, minBoardHeight, boardStyle]
  );
}
