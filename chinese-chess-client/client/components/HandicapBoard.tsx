import React, { useState } from 'react';
import { View, Image, TouchableOpacity, StyleSheet, Text, LayoutChangeEvent } from 'react-native';
import { getPieceImage } from '@/utils/chess/pieceImages';
import { getBoardStyle, gridSpacingX, gridSpacingY } from '@/utils/chess/boardStyles';

// ===== 让子小棋盘 =====
// 复用默认（经典）棋盘背景图，裁剪红方半场底部（兵行 ~ 底线）作为背景；
// 棋子复用对局同款图片资源，整体按容器宽度等比缩放，任何屏幕均不会溢出。
// id 与 GameEngine 初始局面一致：红方 帅16 仕17/18 相19/20 马21/22 车23/24 炮25/26 兵27~31
const HC_TAPPABLE = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]); // 兵/车/马/炮可让（仕/相/帅不可让）

// 小棋盘上出现的棋子：id + 棋盘坐标（col 0~8，row 以完整棋盘行号计，红方视角红在下）
const HC_PIECES: { id: number; col: number; row: number }[] = [
  // 兵行（row 6）
  { id: 27, col: 0, row: 6 }, { id: 28, col: 2, row: 6 }, { id: 29, col: 4, row: 6 },
  { id: 30, col: 6, row: 6 }, { id: 31, col: 8, row: 6 },
  // 炮行（row 7）
  { id: 25, col: 1, row: 7 }, { id: 26, col: 7, row: 7 },
  // 底线（row 9）
  { id: 23, col: 0, row: 9 }, { id: 21, col: 1, row: 9 }, { id: 19, col: 2, row: 9 },
  { id: 17, col: 3, row: 9 }, { id: 16, col: 4, row: 9 }, { id: 18, col: 5, row: 9 },
  { id: 20, col: 6, row: 9 }, { id: 22, col: 7, row: 9 }, { id: 24, col: 8, row: 9 },
];

// 经典棋盘几何（原始图像素）：裁剪从兵行上方半格到棋盘底边，含完整棋框
const CLASSIC = getBoardStyle('classic');
const SX = gridSpacingX(CLASSIC); // 交叉点横向间距
const SY = gridSpacingY(CLASSIC); // 交叉点纵向间距
const ROW6_Y = CLASSIC.pieceTop + 6 * SY; // 兵行中心 y
// 裁剪起点：兵行上方约 0.8 格（顶部留出余量，避免兵行棋子紧贴/被裁掉上边缘，并给「让」角标留出展示空间）
const CROP_TOP = ROW6_Y - SY * 0.8;
const CROP_HEIGHT = CLASSIC.imgHeight - CROP_TOP; // 裁剪高度（到底边，含棋框）

/** 让子设置小棋盘：点按兵/车/马/炮切换让子（让出的棋子置灰并带「让」角标）；readOnly 时仅展示 */
export function HandicapBoard({ selected, onToggle, readOnly }: {
  selected: number[];
  onToggle?: (id: number) => void;
  readOnly?: boolean;
}) {
  // 容器实测宽度（onLayout 兜底屏宽预估值），保证任何父布局下都不溢出
  const [containerW, setContainerW] = useState(0);

  const handleLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && Math.abs(w - containerW) > 0.5) setContainerW(w);
  };

  // 布局未测量完成前先渲染空容器占位（首帧 onLayout 后即得到真实宽度）
  const scale = containerW > 0 ? containerW / CLASSIC.imgWidth : 0;
  const viewH = CROP_HEIGHT * scale;
  const pieceSize = CLASSIC.pieceDiameter * scale;

  return (
    <View style={styles.wrap} onLayout={handleLayout}>
      {scale > 0 && (
        <View style={[styles.crop, { width: containerW, height: viewH }]}>
          {/* 棋盘背景：完整经典棋盘图绝对定位，负偏移实现裁剪 */}
          <Image
            source={CLASSIC.normalImage}
            style={{
              position: 'absolute',
              left: 0,
              top: -CROP_TOP * scale,
              width: containerW,
              height: CLASSIC.imgHeight * scale,
            }}
            resizeMode="stretch"
          />
          {/* 棋子：按交叉点坐标定位 */}
          {HC_PIECES.map(p => {
            const cx = (CLASSIC.pieceLeft + p.col * SX) * scale;
            const cy = (CLASSIC.pieceTop + p.row * SY - CROP_TOP) * scale;
            const tappable = !readOnly && HC_TAPPABLE.has(p.id);
            const isLet = selected.includes(p.id);
            // 「让」角标：尺寸/偏移/描边/字号全部随棋子等比缩放，适配任意屏宽
            const badgeSize = pieceSize * 0.46;
            return (
              <TouchableOpacity
                key={p.id}
                style={{
                  position: 'absolute',
                  left: cx - pieceSize / 2,
                  top: cy - pieceSize / 2,
                  width: pieceSize,
                  height: pieceSize,
                }}
                activeOpacity={tappable ? 0.7 : 1}
                onPress={tappable && onToggle ? () => onToggle(p.id) : undefined}
              >
                <Image
                  source={getPieceImage(p.id)}
                  style={{ width: pieceSize, height: pieceSize, opacity: isLet ? 0.35 : 1 }}
                  resizeMode="contain"
                />
                {isLet && (
                  <View style={[styles.badge, {
                    top: -badgeSize * 0.2,
                    right: -badgeSize * 0.2,
                    width: badgeSize,
                    height: badgeSize,
                    borderRadius: badgeSize / 2,
                    borderWidth: Math.max(badgeSize * 0.07, 1),
                  }]}>
                    <Text style={[styles.badgeText, { fontSize: badgeSize * 0.58 }]}>让</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'stretch',
    marginTop: 4,
  },
  crop: {
    overflow: 'hidden',
    borderRadius: 8,
  },
  badge: {
    position: 'absolute',
    backgroundColor: '#C0392B',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#FFF',
  },
  badgeText: {
    color: '#FFF',
    fontWeight: '700',
    textAlign: 'center',
  },
});
