/**
 * 残局摆棋编辑器棋盘组件
 *
 * 复用 ChessBoard 的棋盘图片与几何换算常量（同一棋盘图，视觉与对局页一致），
 * 但交互语义完全不同：
 * - 无对局状态/走子动画/合法落点提示，仅静态渲染当前摆子结果
 * - 点击任意交叉点通过 onPointPress(col, row) 上报，由父级决定落子/替换/移除
 * - 固定红方在下视角（棋盘编辑无需翻转）
 *
 * 触摸处理与 ChessBoard 相同：overlay 认领响应，release 时按最近交叉点换算；
 * 棋子层 pointerEvents="none"，全部触摸由 overlay 统一处理。
 */

import React, { useMemo } from 'react';
import { View, Image, StyleSheet, useWindowDimensions, GestureResponderEvent } from 'react-native';
import { getPieceImage } from '@/utils/chess/pieceImages';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { gridSpacingX, gridSpacingY, BOARD_H_PADDING } from '@/utils/chess/boardStyles';
import { COLS, ROWS } from '@/components/ChessBoard';

interface BoardEditorProps {
  /** 摆子结果：[col][row] → 棋子 id（0-31），-1 表示空位 */
  placements: number[][];
  /** 点击交叉点回调（已换算为棋盘逻辑行列） */
  onPointPress: (col: number, row: number) => void;
}

export default function BoardEditor({ placements, onPointPress }: BoardEditorProps) {
  // 与对局页一致：使用用户当前选择的棋盘样式（几何 + 背景图）
  const boardStyle = useBoardStyle();
  const styleGridX = gridSpacingX(boardStyle);
  const styleGridY = gridSpacingY(boardStyle);

  // 【C-77】Dimensions.get('window') 是模块级快照，旋转/改窗口后不更新；
  // 摆棋编辑器的棋盘宽度会停在旧视口（网格与棋子整体偏移）。改为订阅式 hook。
  const { width: screenWidth } = useWindowDimensions();
  const boardWidth = screenWidth - BOARD_H_PADDING;
  const scale = boardWidth / boardStyle.scaleBaseWidth;

  const scaledImageWidth = boardStyle.imgWidth * scale;
  const scaledImageHeight = boardStyle.imgHeight * scale;
  const pieceSize = Math.floor(boardStyle.pieceDiameter * scale);
  const pieceHalf = pieceSize / 2;

  // 90 个交叉点坐标（缩放后），只随 scale / 样式重算
  const gridPositions = useMemo(() => {
    const positions: { x: number; y: number }[][] = [];
    for (let col = 0; col < COLS; col++) {
      positions[col] = [];
      for (let row = 0; row < ROWS; row++) {
        positions[col][row] = {
          x: (boardStyle.pieceLeft + col * styleGridX) * scale,
          y: (boardStyle.pieceTop + row * styleGridY) * scale,
        };
      }
    }
    return positions;
  }, [scale, boardStyle, styleGridX, styleGridY]);

  // 点击换算最近交叉点（与 ChessBoard.handleTouch 同算法，无翻转）
  const handleTouch = (event: GestureResponderEvent) => {
    const { locationX, locationY } = event.nativeEvent;
    const origX = locationX / scale;
    const origY = locationY / scale;

    let closestCol = -1;
    let closestRow = -1;
    let minDistance = Infinity;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const pieceX = boardStyle.pieceLeft + col * styleGridX;
        const pieceY = boardStyle.pieceTop + row * styleGridY;
        const distance = Math.sqrt(Math.pow(origX - pieceX, 2) + Math.pow(origY - pieceY, 2));
        if (distance < minDistance && distance < pieceSize / scale) {
          minDistance = distance;
          closestCol = col;
          closestRow = row;
        }
      }
    }

    if (closestCol === -1 || closestRow === -1) return;
    onPointPress(closestCol, closestRow);
  };

  // 静态棋子渲染（无动画，pointerEvents none 由 overlay 统一处理触摸）
  const pieceElements = useMemo(() => {
    const elements: React.ReactNode[] = [];
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const id = placements[col]?.[row] ?? -1;
        if (id < 0) continue;
        const { x, y } = gridPositions[col][row];
        elements.push(
          <View
            key={`${col}-${row}`}
            pointerEvents="none"
            style={[
              styles.pieceContainer,
              {
                left: x - pieceHalf,
                top: y - pieceHalf,
                width: pieceSize,
                height: pieceSize,
                borderRadius: pieceHalf,
              },
            ]}
          >
            <View style={[styles.pieceContent, { borderRadius: pieceHalf }]}>
              <Image source={getPieceImage(id)} style={{ width: pieceSize, height: pieceSize }} />
            </View>
          </View>
        );
      }
    }
    return elements;
  }, [placements, gridPositions, pieceSize, pieceHalf]);

  return (
    <View style={styles.outerContainer}>
      <View style={{ width: scaledImageWidth, height: scaledImageHeight, position: 'relative' }}>
        {/* 棋盘图片（固定红方在下视角，随用户所选样式） */}
        <Image
          source={boardStyle.normalImage}
          style={{ position: 'absolute', left: 0, top: 0, width: scaledImageWidth, height: scaledImageHeight }}
          resizeMode="contain"
        />
        {/* 棋子 + 触摸层 */}
        <View
          style={[styles.overlay, { width: scaledImageWidth, height: scaledImageHeight }]}
          onStartShouldSetResponder={() => true}
          onResponderRelease={handleTouch}
        >
          {pieceElements}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 1,
  },
  // 与 ChessBoard 一致的棋子容器：外层阴影 + 内层圆形裁剪（阴影依赖背景轮廓，必须同色背景）
  pieceContainer: {
    position: 'absolute',
    backgroundColor: '#b1824e',
    boxShadow: '6px 6px 8px rgba(0, 0, 0, 0.3)',
  },
  pieceContent: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#b1824e',
    overflow: 'hidden',
  },
});
