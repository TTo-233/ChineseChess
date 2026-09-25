/**
 * 棋盘几何测量 Hook
 *
 * 背景：棋盘采用动态布局预算（尺寸与纵向位置随屏幕/抽屉预留变化），
 * 绝杀特效等浮层需要"棋盘中心的真实坐标"才能精准对齐，而不能假设棋盘屏幕居中。
 *
 * 用法：
 * - containerRef 挂在浮层与棋盘共同的最近祖先容器（浮层 absoluteFill 于该容器）；
 * - boardRef 挂在紧贴棋盘的包裹 View 上，并在其 onLayout 中调用 measure；
 * - boardFrame 为棋盘相对容器的 {x, y, width, height}，供浮层定位。
 */
import { useCallback, useRef, useState } from 'react';
import type { View } from 'react-native';

export interface BoardFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function useBoardFrame() {
  const containerRef = useRef<View | null>(null);
  const boardRef = useRef<View | null>(null);
  const [boardFrame, setBoardFrame] = useState<BoardFrame | null>(null);

  /** 用 measureLayout 求棋盘相对容器的位置与尺寸（测量失败静默忽略） */
  const measure = useCallback(() => {
    const board = boardRef.current;
    const container = containerRef.current;
    if (!board || !container) return;
    board.measureLayout(
      container,
      (x, y, width, height) => setBoardFrame({ x, y, width, height }),
      () => {
        /* 测量失败（如视图未挂载）忽略，浮层退回屏幕居中兜底 */
      }
    );
  }, []);

  return { containerRef, boardRef, boardFrame, measure };
}
