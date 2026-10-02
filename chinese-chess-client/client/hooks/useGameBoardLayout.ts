/**
 * 人机对战页的棋盘几何与纵向预算（第 3 批从 screens/game/index.tsx 抽出）。
 *
 * 抽出的理由不是"行数多"，而是这段逻辑有一个完整的因果链：
 *   宿主实测高度 → 视口封顶 → 纵向预算二分 → 棋盘尺寸 → 对齐行宽度
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
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/capturedDrawerMetrics';

/** AI 角标行在纵向流内的占位高度（StyleSheet 里 aiNameRow height 26 + marginBottom 4） */
export const AI_NAME_ROW_FLOW_HEIGHT = 30;
/** 被吃棋子摘要在棋盘上方的悬浮区预留高度（抽屉展开时不压棋盘） */
export const CAPTURED_STRIP_OFFSET = 30;

export interface GameBoardLayoutOptions {
  /** 内容宿主实测高度（capturedDrawerHost 的 onLayout） */
  boardAreaH: number;
  /** 底部操作栏实测高度（计入下方流内占位） */
  bottomBarH: number;
  /** 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部栏与顶部安全区） */
  drawerHostY: number;
  /** 安全区上下内边距：Screen 已在内容之外施加，预算封顶时需据此扣减可用高度 */
  insetsTop: number;
  insetsBottom: number;
  /** 绝杀特效可见：弹出前需要按绝对坐标兜底重测棋盘框 */
  jueshaVisible: boolean;
}

export interface GameBoardLayoutApi {
  /** 棋盘最大可用高度（纵向预算封顶后；undefined = 未受预算约束） */
  maxBoardHeight: number | undefined;
  /** 棋盘容器顶部留白：优先垂直居中，预留不足时整体下移贴住预留区 */
  boardPadTop: number;
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
  /** 顶部动态间距 = max(屏宽 * 3%, 8)，底部操作栏上边距用 */
  dynamicGap: number;
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
    bottomBarH,
    drawerHostY,
    insetsTop,
    insetsBottom,
    jueshaVisible,
  } = options;

  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  // 动态间距：随屏幕宽度/棋盘缩放比例自适应
  const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);

  // 棋盘高度预算 + 垂直定位留白（二分求解，口径与抽屉真实尺寸一致）：
  // 条件 1 —— 棋盘顶边上方常驻预留「AI 角标行 + 摘要条悬浮区 + 抽屉展开高度」，
  //           无论抽屉是否点开都预留，保证展开时底边不压棋盘、不与摘要条/角标重叠；
  // 条件 2 —— 内容（角标行 + 棋盘 + 底部栏）在宿主内垂直居中；居中时上方预留不足则整体下移
  //           贴住预留区（把下方空白让给棋盘），棋盘取到预留允许的最大尺寸。
  // 宽屏下棋盘由纵向预算决定而缩小，抽屉随棋盘同步缩小，预留与真实抽屉高度精确一致，
  // 不再像旧实现那样按宽度缩放高估抽屉、把棋盘压缩得过小。
  // 上方流内占位 = AI 角标行；下方流内占位 = dynamicGap + 底部操作栏。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出
  // （详见 capHostHeightToViewport 注释）。
  const { maxBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      drawerHostY,
      insetsTop,
      insetsBottom,
      0 // 底部栏在 capturedDrawerHost 之内，已由 bottomFlowHeight 计入
    ),
    screenWidth,
    stripOffset: CAPTURED_STRIP_OFFSET,
    topFlowHeight: AI_NAME_ROW_FLOW_HEIGHT,
    bottomFlowHeight: dynamicGap + bottomBarH,
  });

  // 棋盘真实几何（相对主容器）：供绝杀特效锁定棋盘中心、把结算文字/按钮排到棋盘正下方
  const { containerRef, boardRef, boardFrame, measure: measureBoardFrame } = useBoardFrame();
  // 当前棋盘样式：AI 角标行宽度需按样式几何换算棋盘本体宽度（用户可在首页设置中切换样式）
  const boardStyle = useBoardStyle();

  // AI 角标行宽度：取棋盘本体宽度并水平居中，使角标行左右边缘与棋盘边缘对齐
  // （宽屏下棋盘因纵向预算被压缩居中，角标行若铺满整屏会贴到屏幕最左/最右）
  // 底部操作栏宽度同口径：同样跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕。
  // 两个 useMemo 的计算与依赖完全一致（都是 boardAlignedRowStyle 的同一结果），
  // 第 3 批合并为一个 memo，避免同一份几何算两遍、也避免两份 memo 各自漂移。
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

  // 长将长捉提示条（GameNotice）的棋盘中心纵坐标：挂载点 capturedDrawerHost 与
  // boardFrame 的测量基准（根容器）相差 drawerHostY，需换算到同一坐标系；
  // 缺测量时返回 undefined，由 GameNotice 退回容器 50% 居中（口径同联机对战页）
  const ruleNoticeCenterY = useMemo(() => {
    if (!jueshaBoardFrame) return undefined;
    return jueshaBoardFrame.y + jueshaBoardFrame.height / 2 - drawerHostY;
  }, [jueshaBoardFrame, drawerHostY]);

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