/**
 * 棋盘纵向预算的 React 包装（用户切换棋盘样式时同步更新）
 *
 * 为什么单独一个文件：useBoardStyle 住在 boardStyleStore，而它 import AsyncStorage。
 * 若 Hook 与 computeBoardLayoutBudget 同文件，任何 import 该文件的布局单测都会被拖进
 * RN/AsyncStorage 依赖链（2026-10 实测：布局单因此只能靠 mock 才能跑，
 * 于是布局回归断言很容易被跳过或干脆不写）。
 * 纯函数留在 boardLayoutBudget.ts（无 React 依赖），Hook 放这里，两边都能直接测。
 */

import { useMemo } from 'react';
import { useBoardStyle } from './boardStyleStore';
import {
  computeBoardLayoutBudget,
  type BoardLayoutBudgetInput,
  type BoardLayoutBudgetResult,
} from './boardLayoutBudget';

/** 基于当前棋盘样式的预算 Hook */
export function useBoardLayoutBudget(input: BoardLayoutBudgetInput): BoardLayoutBudgetResult {
  const boardStyle = useBoardStyle();
  const {
    hostHeight,
    screenWidth,
    topFlowHeight,
    bottomFlowHeight,
    belowHostSlack,
    minBoardHeight,
    hostTopY,
    viewportHeight,
  } = input;
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
          hostTopY,
          viewportHeight,
        },
        boardStyle
      ),
    [
      hostHeight,
      screenWidth,
      topFlowHeight,
      bottomFlowHeight,
      belowHostSlack,
      minBoardHeight,
      hostTopY,
      viewportHeight,
      boardStyle,
    ]
  );
}