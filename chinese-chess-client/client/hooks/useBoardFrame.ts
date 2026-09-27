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
 *
 * 坐标口径：boardFrame 是「相对容器」的，而 RN <Modal> 渲染在独立原生窗口里，
 * 其坐标系是窗口。若要把 AppModal 之类的弹窗卡片对齐到棋盘中心，必须先加上
 * containerOrigin（容器在窗口中的原点）换算成窗口坐标，见返回值。
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
  // 容器在窗口坐标系中的原点：把 boardFrame（容器相对）换算为窗口坐标的唯一依据
  const [containerOrigin, setContainerOrigin] = useState<{ x: number; y: number } | null>(null);

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
    // 容器自身的窗口原点：与棋盘测量同批进行（同一个 onLayout 回调里调用，避免漏测）
    container.measureInWindow((x, y) => setContainerOrigin({ x, y }));
  }, []);

  return { containerRef, boardRef, boardFrame, containerOrigin, measure };
}
