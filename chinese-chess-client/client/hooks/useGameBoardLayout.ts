/**
 * 人机对战页（含残局闯关）的棋盘几何与纵向预算（第 3 批从 screens/game/index.tsx 抽出）。
 *
 * 抽出的理由不是"行数多"，而是这段逻辑有一个完整的因果链：
 *   宿主实测高度 → 视口封顶 → 纵向预算 → 棋盘尺寸 → 对齐行宽度
 *   → 绝杀特效框 → 规则提示条中心纵坐标
 * 每一环都依赖上一环的结果，散在页面里时看不出依赖顺序，改一环容易漏掉下游。
 * 现在这条链全部在本文件内，页面只消费结果。
 *
 * 同时把 `Dimensions.get('window')` 换成响应式的 `useWindowDimensions()`：
 * 原写法只在首次渲染取一次屏宽屏高，转屏/分屏后棋盘预算不再跟着变
 * （同 ChessBoard 的 C-77 一类问题）。
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions, type View } from 'react-native';
import { useBoardFrame } from '@/hooks/useBoardFrame';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/boardLayoutBudget';
import { BOTTOM_BAR_HEIGHT } from '@/components/GameBottomBar';

/** AI 角标行在纵向流内的占位高度（StyleSheet 里 aiNameRow height 26 + marginBottom 4） */
export const AI_NAME_ROW_FLOW_HEIGHT = 30;

export interface GameBoardLayoutOptions {
  /** 内容宿主实测高度（boardHost 的 onLayout） */
  boardAreaH: number;
  /**
   * 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部安全区）
   *
   * 2026-10 改造：底部操作栏已从棋盘宿主内移到页面最底端（固定通栏），
   * 因此宿主之外需要预留的高度不再是「实测的底栏高度」，而是常量
   * BOTTOM_BAR_HEIGHT + dynamicGap + 底部安全区（见下方 capHostHeightToViewport 调用）。
   */
  boardHostY: number;
  /** 安全区上下内边距：Screen 已在内容之外施加，预算封顶时需据此扣减可用高度 */
  insetsTop: number;
  insetsBottom: number;
  /** 绝杀特效可见：弹出前需要按绝对坐标兜底重测棋盘框 */
  jueshaVisible: boolean;
}

export interface GameBoardLayoutApi {
  /** 棋盘最大可用高度（纵向预算封顶后；undefined = 未受预算约束） */
  maxBoardHeight: number | undefined;
  /** 棋盘容器顶部留白：内容在宿主内垂直居中 */
  boardPadTop: number;
  /** 棋盘与底部操作栏之间的间距 = max(屏宽 * 3%, 8) */
  dynamicGap: number;
  /** 棋盘本体宽度对齐样式：AI 角标行与底部操作栏共用（同一几何、同一结果） */
  alignedRowStyle: object;
  /** 绝杀特效对齐用的棋盘框（棋盘本体真实几何） */
  jueshaBoardFrame: { x: number; y: number; width: number; height: number } | null;
  /** 规则提示条（GameNotice）的棋盘中心纵坐标；undefined = 退回容器 50% 居中 */
  ruleNoticeCenterY: number | undefined;
  /** 棋盘本体真实尺寸（由 ChessBoard 的 onBoardLayout 回报） */
  boardSize: { width: number; height: number } | null;
  setBoardSize: (size: { width: number; height: number } | null) => void;
  /** 当前窗口宽度（响应式：转屏/分屏会更新） */
  screenWidth: number;
  /** 当前窗口高度（响应式） */
  windowHeight: number;
  /** 按绝对坐标重新测量棋盘框（棋盘包裹层 onLayout 用） */
  measureBoardFrame: () => void;
  /** 浮层与棋盘共同祖先容器的 ref（useBoardFrame 原样透传） */
  containerRef: React.RefObject<View | null>;
  /** 紧贴棋盘的包裹层 ref（onLayout 里调 measureBoardFrame） */
  boardRef: React.RefObject<View | null>;
}

export function useGameBoardLayout(options: GameBoardLayoutOptions): GameBoardLayoutApi {
  const {
    boardAreaH,
    boardHostY,
    insetsTop,
    insetsBottom,
    jueshaVisible,
  } = options;

  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  // 动态间距：随屏幕宽度自适应（棋盘与固定底栏之间的留白，作为底栏的上边距）
  const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);

  // 棋盘高度预算 + 垂直定位留白：
  // 宿主内上方流内占位 = AI 角标行；宿主内已无底栏（底栏已移到页面最底端）。
  // 底栏改为页面固定通栏后，它占的是「宿主之外」的高度，因此不再走 bottomFlowHeight，
  // 而是以 belowHostHeight 参与视口封顶——口径与 spectate/replayPlayer 一致。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出
  // （详见 capHostHeightToViewport 注释）。
  const { maxBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      boardHostY,
      insetsTop,
      insetsBottom,
      // 底栏主体高度 + 它与棋盘的间距。底部安全区已由 capHostHeightToViewport
      // 内部的 bottomInset 扣过一次，此处不能再加，否则底部会凭空少出一个安全区的高度。
      BOTTOM_BAR_HEIGHT + dynamicGap
    ),
    screenWidth,
    topFlowHeight: AI_NAME_ROW_FLOW_HEIGHT,
    bottomFlowHeight: 0,
  });

  // 棋盘真实几何（相对主容器）：供绝杀特效锁定棋盘中心、把结算文字/按钮排到棋盘正下方
  const { containerRef, boardRef, boardFrame, measure: measureBoardFrame } = useBoardFrame();
  // 当前棋盘样式：AI 角标行宽度需按样式几何换算棋盘本体宽度（用户可在首页设置中切换样式）
  const boardStyle = useBoardStyle();

  // AI 角标行宽度：取棋盘本体宽度并水平居中，使角标行左右边缘与棋盘边缘对齐
  // （宽屏下棋盘因纵向预算被压缩居中，角标行若铺满整屏会贴到屏幕最左/最右）
  // 底部操作栏宽度同口径：同样跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕。
  const alignedRowStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight ?? 0),
    [screenWidth, boardStyle, maxBoardHeight]
  );

  // 绝杀特效弹出前兜底重测：boardPadTop/maxBoardHeight 变化只挪动棋盘（相对父级布局不变，
  // 包裹层 onLayout 可能不触发），此处按绝对坐标重新测量，保证特效对齐的是最新棋盘位置
  useEffect(() => {
    if (!jueshaVisible) return;
    measureBoardFrame();
  }, [jueshaVisible, boardPadTop, maxBoardHeight, measureBoardFrame]);

  // 棋盘本体真实尺寸（外层容器宽=屏宽，onBoardLayout 回报的才是棋盘宽），由 ChessBoard 回报
  const [boardSize, setBoardSize] = useState<{ width: number; height: number } | null>(null);

  // 绝杀特效对齐用的棋盘框：测量框宽=屏宽（外层容器），按棋盘本体宽度在其中水平居中换算，
  // 得到棋盘本体的真实 x/宽，保证特效中心与按钮宽度口径都落在棋盘本体上
  const jueshaBoardFrame = useMemo(() => {
    if (!boardFrame) return null;
    const w = boardSize?.width ?? boardFrame.width;
    const h = boardSize?.height ?? boardFrame.height;
    return {
      x: boardFrame.x + (boardFrame.width - w) / 2,
      y: boardFrame.y,
      width: w,
      height: h,
    };
  }, [boardFrame, boardSize]);

  // 长将长捉提示条（GameNotice）的棋盘中心纵坐标：挂载点 boardHost 与
  // boardFrame 的测量基准（根容器）相差 boardHostY，需换算到同一坐标系；
  // 缺测量时返回 undefined，由 GameNotice 退回容器 50% 居中（口径同联机对战页）
  const ruleNoticeCenterY = useMemo(() => {
    if (!jueshaBoardFrame) return undefined;
    return jueshaBoardFrame.y + jueshaBoardFrame.height / 2 - boardHostY;
  }, [jueshaBoardFrame, boardHostY]);

  return {
    maxBoardHeight,
    boardPadTop,
    alignedRowStyle,
    jueshaBoardFrame,
    ruleNoticeCenterY,
    boardSize,
    setBoardSize,
    screenWidth,
    windowHeight,
    dynamicGap,
    measureBoardFrame,
    containerRef,
    boardRef,
  };
}