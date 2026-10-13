/**
 * 揭棋 · 被吃棋子清单（**纯槽内内容**，自身不含任何定位）
 *
 * ============================ 位置由谁决定 ============================
 * **本组件不决定自己在哪一行、哪一端** —— 那由宿主的角位带决定（components/BoardEdgeSlot）。
 * 本组件只负责「画什么」：棋子图、数量角标。定位（贴左/贴右、与棋盘的间隙）
 * 全部是宿主的事。
 *
 * 这样拆分的原因：2026-10 四轮实机反馈里，每一轮都在「谁来定位」这件事上翻车
 * （塞进药丸行撑破它 / 另起一行排上方离棋盘太远 / 排下方顶起 AI 行），
 * 根因是被吃棋子与药丸行耦合在了同一行里。把定位彻底交出去之后，
 * 「放哪个角位」就只是往带里填个槽，与本组件无关。
 *
 * ============================ 上界（决定了「不会挤坏另一端」）===========================
 * 一组最多 6 张图：同一棋种被吃多子合并成一个角标（jieqiCaptured.ts 按图片分组），
 * 而单方只可能有 che/ma/pao/shi/xiang/zu 六种（jieqi.ts 的 HIDDEN_MULTISET_BY_SIDE，
 * 黑方无兵、红方无卒），将帅仅 1 枚必然不合并。
 * 角位种类变多时必须重新核对这个上界。
 *
 * ============================ 语义 ============================
 *   · mine   = 我方损失（我的子被对方吃掉）→ 上带**右端**（右上）
 *   · theirs = 对方损失（对方的子被我吃掉）→ 下带**左端**（左下）
 *
 * 分组与图片口径见 utils/chess/jieqiCaptured.ts（铁律 A：暗子只显示背面图）；
 * 尺寸换算见 utils/chess/jieqiCapturedLayout.ts（纯模块，可被布局单测直接引用）。
 */

import React, { memo, useMemo } from 'react';
import { Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { capturedPiecesOfSide, type JieqiCapturedGroup } from '@/utils/chess/jieqiCaptured';
import { capturedPieceSize } from '@/utils/chess/jieqiCapturedLayout';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { BLACK_SIDE, RED_SIDE, type GameState } from '@/utils/chess/types';

/** 取某一方的被吃棋子分组；象棋局面恒为空数组（不占位） */
function useCapturedGroups(
  gameState: GameState,
  playerSide: 'red' | 'black',
  side: 'mine' | 'theirs'
): JieqiCapturedGroup[] {
  return useMemo(() => {
    if (gameState.variant !== 'jieqi') return [] as JieqiCapturedGroup[];
    const playerTag = playerSide === 'red' ? RED_SIDE : BLACK_SIDE;
    const opponentTag = playerTag === RED_SIDE ? BLACK_SIDE : RED_SIDE;
    return capturedPiecesOfSide(gameState, side === 'mine' ? playerTag : opponentTag);
  }, [gameState, playerSide, side]);
}

/** 被吃棋子边长（与盘面棋子同源，见 jieqiCapturedLayout） */
function usePieceSize(maxBoardHeight: number | undefined): number {
  const boardStyle = useBoardStyle();
  const { width: screenWidth } = useWindowDimensions();
  return useMemo(
    () => capturedPieceSize(screenWidth, boardStyle, maxBoardHeight),
    [screenWidth, boardStyle, maxBoardHeight]
  );
}

/**
 * 被吃棋子槽内容（放给 BoardEdgeSlot 的 start / end）。
 *
 * 无内容返回 null —— 宿主据此不占位，棋盘上下留白不会突变。
 */
export const CapturedPieces = memo(function CapturedPieces({
  gameState,
  playerSide,
  side,
  maxBoardHeight,
  testID,
}: {
  gameState: GameState;
  playerSide: 'red' | 'black';
  side: 'mine' | 'theirs';
  maxBoardHeight: number | undefined;
  testID?: string;
}) {
  const groups = useCapturedGroups(gameState, playerSide, side);
  const pieceSize = usePieceSize(maxBoardHeight);
  if (groups.length === 0) return null;

  // 角标尺寸沿用残局编辑器棋子面板的同一套公式（endgameEdit: paletteBadgeSize/Offset）
  const badgeSize = Math.max(Math.round(pieceSize * 0.47), 12);
  const badgeFont = Math.max(Math.round(badgeSize * 0.6), 8);
  const badgeOffset = -Math.round(badgeSize * 0.27);

  return (
    <View style={styles.list} pointerEvents="none" testID={testID}>
      {groups.map((g, i) => (
        <View key={`${g.side}-${g.hidden ? 'h' : 'f'}-${i}`} style={styles.item}>
          <Image source={g.source} style={{ width: pieceSize, height: pieceSize }} resizeMode="contain" />
          {/* 同一棋种被吃多个才出数字角标（与 endgameEdit 的「仅 > 1 显示」口径一致） */}
          {g.count > 1 && (
            <View
              testID={testID ? `${testID}-badge` : undefined}
              style={[
                styles.badge,
                {
                  top: badgeOffset,
                  right: badgeOffset,
                  minWidth: badgeSize,
                  height: badgeSize,
                  borderRadius: badgeSize / 2,
                  paddingHorizontal: badgeSize * 0.17,
                },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[
                  styles.badgeText,
                  {
                    // 【字号例外】角标字号随棋子/棋盘尺寸等比缩放（AGENTS.md 豁免项）
                    fontSize: badgeFont,
                    lineHeight: Math.max(Math.round(badgeFont * 1.2), 1),
                  },
                ]}
              >
                {g.count}
              </Text>
            </View>
          )}
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  item: {
    position: 'relative',
    // 行内间距用对称 margin 而非 gap —— 部分 Android 设备的 Yoga 在 flexWrap 下
    // 对 gap 支持不可靠（残局编辑器的棋子面板因此也用同样的对称 margin）。
    marginHorizontal: 3,
  },
  // 数量角标：沿用应用既有红色角标（与残局编辑器棋子面板、让子「让」角标同族配色）
  badge: {
    position: 'absolute',
    backgroundColor: '#C62828',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.85)',
    zIndex: 2,
  },
  badgeText: {
    color: '#FFF',
    fontWeight: '700',
    textAlign: 'center',
  },
});
