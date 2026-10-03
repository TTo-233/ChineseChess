/**
 * 棋盘渲染组件 - 移动端适配版本
 * 负责绘制棋盘网格和棋子
 *
 * 性能优化：
 * 1. PieceItem 独立 memo 组件，仅变化的棋子重渲染
 * 2. 移除 90 个不可见 gridIntersection View（触摸已由 overlay 处理）
 * 3. 位置计算预缓存，避免重复运算
 * 4. 消除 pieces.find() O(n²) 查找，直接遍历传递
 *
 * 原始图片尺寸：767x842
 * 实际棋盘区域：左上(67,53) 到 右下(698,750)
 * 棋子位置区域：左上(110,96) 到 右下(650,704)
 * 棋盘宽度 = 移动端宽度，棋盘图片等比例缩放
 *
 * 【C-85】几何常量的真实口径来自 @/utils/chess/boardStyles（每个棋盘样式自带 imgWidth/
 * imgHeight/imgLeft/imgTop 与 gridSpacingX/Y），下面的常量只用于推导"原始图片坐标系下的
 * 网格间距"这一个归一化基准。历史注释称 BoardEditor 复用 ORIGINAL_IMAGE_*，
 * 实际 BoardEditor 只 import COLS/ROWS 与 boardStyles 的 gridSpacingX/Y —— 该说法已删除。
 */

import React, { useRef, useEffect, useState, useMemo, useCallback, memo } from 'react';
import { View, Image, StyleSheet, useWindowDimensions, Text, GestureResponderEvent, Animated, TouchableOpacity } from 'react-native';
import type { GameState } from '@/utils/chess/GameEngine';
import { getPieceImage, PIECE_NAMES } from '@/utils/chess/pieceImages';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { gridSpacingX, gridSpacingY } from '@/utils/chess/boardStyles';
// 【C-86】原 import { RED_SIDE, BLACK_SIDE } from '@/utils/chess/types' 是未使用 import
// （全文件只命中这一行），已删除。
import MoveEffectOverlay, { type MoveEffect } from '@/components/MoveEffectOverlay';
import Svg, { Circle, Line } from 'react-native-svg';
import { FONT } from '@/utils/typography';
import { noteBoardInteraction, endBoardInteraction } from '@/utils/chess/AIEngine';

interface ChessBoardProps {
  gameState: GameState;
  selectedPieceId: number | null;
  validMoves: boolean[][] | null;
  lastMove: { fromCol: number; fromRow: number; toCol: number; toRow: number } | null;
  isFlipped: boolean; // 是否翻转棋盘（黑方视角）
  onPiecePress: (pieceId: number) => void;
  onEmptyPress: (col: number, row: number) => void;
  onMove?: (col: number, row: number) => void;
  aiThinking?: boolean;
  capturedByRed: number[]; // 红方吃掉的棋子（黑方棋子ID）
  capturedByBlack: number[]; // 黑方吃掉的棋子（红方棋子ID）
  hideCaptured?: boolean; // 是否隐藏被吃棋子显示
  playerSide: 'red' | 'black'; // 玩家执棋方（用于被吃棋子标题）
  /** 提示功能：最优解（待走棋子橙色描边 + 落点橙色圆点），null/不传表示无提示 */
  hintMove?: { pieceId: number; toCol: number; toRow: number } | null;
  /** 让子幽灵标记（在线对局让子局专用）：被让出的棋子在其初始位置半透明展示 + 红色「让」角标，
   *  不参与对局、不响应触摸；该交叉点被真实棋子占据后自动隐藏 */
  ghostPieces?: { id: number; col: number; row: number }[];
  /** 点击被吃棋子摘要文字（对方/我方），由父级在标题行正下方渲染 CapturedPiecesDrawer */
  onCapturedPress?: (side: 'opponent' | 'mine') => void;
  /** 棋盘可用的最大纵向高度（父级实测传入）；空间不足时按比例缩小棋盘，防止挤占上下 UI */
  maxBoardHeight?: number;
  /** 被吃棋子摘要条（悬浮于棋盘上方）的额外上移偏移量：
   *  棋盘上方存在其他元素（如人机对局的 AI 标识角标行）时传入其高度，避免摘要文字与之重叠 */
  capturedStripOffset?: number;
  /** 吃子/将军特效（seq 变化时重播），null/不传表示无特效 */
  moveEffect?: MoveEffect | null;
  /** 长将长捉超限落点警示（方案 10 娱乐向改造）：超限方的「继续长将/长捉」落点以红色标记高亮，
   *  仅供当前走子方为超限方时传入；null/不传表示无超限。
   *  ⚠️ 纯警示：这些落点**可以正常点击落子**，不拦截、不判负 */
  banMoves?: { pieceId: number; toCol: number; toRow: number }[] | null;
  /** 棋盘容器实际渲染尺寸（缩放后的宽/高）回调：供父级做浮层对齐（如绝杀特效锁定棋盘中心）。
   *  注意：外层容器宽度恒为屏宽，此回调返回的才是棋盘本体的真实宽度。 */
  onBoardLayout?: (size: { width: number; height: number }) => void;
}

// 原始图片尺寸（私有：仅用于推导下面的归一化基准，【C-85】已从 export 收为私有，
// 全仓无外部引用者；外层真实几何以 @/utils/chess/boardStyles 的样式参数为准）
const ORIGINAL_IMAGE_WIDTH = 767;
const ORIGINAL_IMAGE_HEIGHT = 842;

// 实际棋盘区域（图片中的坐标）
const BOARD_LEFT = 67;
const BOARD_TOP = 53;
const BOARD_RIGHT = 698;
const BOARD_BOTTOM = 750;
const BOARD_WIDTH = BOARD_RIGHT - BOARD_LEFT; // 631
const BOARD_HEIGHT = BOARD_BOTTOM - BOARD_TOP; // 697

// 棋子位置区域（图片中的坐标）
const PIECE_LEFT = 110;
const PIECE_TOP = 96;
const PIECE_RIGHT = 650;
const PIECE_BOTTOM = 704;
const PIECE_AREA_WIDTH = PIECE_RIGHT - PIECE_LEFT; // 540
const PIECE_AREA_HEIGHT = PIECE_BOTTOM - PIECE_TOP; // 608

// 9x10 网格（9列10行交叉点）
export const COLS = 9;
export const ROWS = 10;

// 被吃棋子摘要行固定高度（抽屉向下展开的锚定偏移量）
const CAPTURED_SUMMARY_H = 30;

// 计算网格间距（原始图片中的像素；【C-85】私有，仅作 unitScale 的归一化分母）
const GRID_SPACING_X = PIECE_AREA_WIDTH / (COLS - 1); // 540 / 8 = 67.5
const GRID_SPACING_Y = PIECE_AREA_HEIGHT / (ROWS - 1); // 608 / 9 ≈ 67.56

// ==================== Memoized Piece Component ====================

interface PieceItemProps {
  pieceId: number;
  imageSource: any;
  animX: Animated.Value;
  animY: Animated.Value;
  pieceSize: number;
  pieceHalf: number;
  isSelected: boolean;
  onPress: (pieceId: number) => void;
}

const PieceItem = memo(function PieceItem({
  pieceId,
  imageSource,
  animX,
  animY,
  pieceSize,
  pieceHalf,
  isSelected,
  onPress,
}: PieceItemProps) {
  const handleRelease = useCallback(() => {
    onPress(pieceId);
  }, [onPress, pieceId]);

  return (
    <Animated.View
      pointerEvents="auto"
      // 【P2】点棋子是本页面最常见的触摸，必须在**按下**这一刻就通知 AIEngine 中止后台预计算。
      // 放在这里而不是只依赖外层 overlay 的 onStartShouldSetResponder，是为了不依赖
      // 「响应者冒泡时父层的 onStartShouldSetResponder 也会被调用」这一实现细节。
      onStartShouldSetResponder={() => {
        noteBoardInteraction();
        return true;
      }}
      onResponderRelease={handleRelease}
      style={[
        styles.pieceContainer,
        {
          left: animX,
          top: animY,
          marginLeft: -pieceHalf,
          marginTop: -pieceHalf + (isSelected ? -3 : 0),
          width: pieceSize,
          height: pieceSize,
          borderRadius: pieceSize / 2,
          zIndex: isSelected ? 5 : 3,
          // 选中时增强阴影
          ...(isSelected
            ? {
                boxShadow: '10px 10px 12px rgba(0, 0, 0, 0.4)',
              }
            : {}),
        },
      ]}
    >
      {/* 内层：背景色+圆形裁剪，与外层阴影分离确保 Android 阴影正常渲染 */}
      <View
        style={[
          styles.pieceContent,
          {
            width: pieceSize,
            height: pieceSize,
            borderRadius: pieceSize / 2,
          },
        ]}
      >
        {/* 选中光圈 */}
        {isSelected && (
          <View
            style={[
              styles.selectedRing,
              {
                width: pieceSize - 3,
                height: pieceSize - 3,
                borderRadius: (pieceSize - 3) / 2,
              },
            ]}
          />
        )}
        <Image
          source={imageSource}
          style={[
            styles.pieceImage,
            {
              width: pieceSize,
              height: pieceSize,
            },
          ]}
          resizeMode="contain"
        />
      </View>
    </Animated.View>
  );
}, (prev, next) => {
  // 仅在以下属性变化时重渲染
  return prev.isSelected === next.isSelected &&
    prev.animX === next.animX &&
    prev.animY === next.animY &&
    prev.pieceSize === next.pieceSize &&
    prev.imageSource === next.imageSource;
});

// ==================== Captured Pieces Helpers ====================

// 按棋子类型分组统计（用于被吃棋子展示）
function groupCapturedPieces(ids: number[]): [string, number[]][] {
  const groups: { [key: string]: number[] } = {};
  ids.forEach(pieceId => {
    const name = PIECE_NAMES[pieceId] || '?';
    if (!groups[name]) groups[name] = [];
    groups[name].push(pieceId);
  });
  return Object.entries(groups);
}

// ==================== Main Component ====================

export default function ChessBoard({
  gameState,
  selectedPieceId,
  validMoves,
  lastMove,
  isFlipped,
  onPiecePress,
  onEmptyPress,
  onMove,
  aiThinking,
  capturedByRed,
  capturedByBlack,
  hideCaptured,
  playerSide,
  hintMove = null,
  ghostPieces,
  onCapturedPress,
  maxBoardHeight,
  capturedStripOffset = 0,
  moveEffect = null,
  banMoves = null,
  onBoardLayout,
}: ChessBoardProps) {
  // 【C-77】改用 useWindowDimensions：Dimensions.get('window') 只在模块求值时取一次快照，
  // 旋转屏幕 / 浏览器改窗口 / 分屏后不会更新，棋盘宽度会停在旧视口（表现为棋盘溢出、
  // 控件行超宽）。同项目 endgame/index.tsx:75、Modal/AppModal.tsx:99、JueShaOverlay.tsx:98
  // 已是这个写法。
  const { width: screenWidth } = useWindowDimensions();

  // 棋盘宽度 = 屏幕宽度（留少量边距）
  const boardWidth = screenWidth - 16;

  // 当前棋盘样式（用户可在首页设置中切换）：几何参数与背景图均随样式变化
  const boardStyle = useBoardStyle();
  const styleGridX = gridSpacingX(boardStyle);
  const styleGridY = gridSpacingY(boardStyle);

  // 计算缩放比例：棋盘宽度 / 样式基准宽度。
  // 宽屏/纵向空间不足的设备上（maxBoardHeight 由父级实测可用高度传入），
  // 按比例缩小棋盘，避免棋盘挤占上方标题行与下方操作栏的显示空间
  const widthScale = boardWidth / boardStyle.scaleBaseWidth;
  const scale = maxBoardHeight && maxBoardHeight > 0
    ? Math.min(widthScale, maxBoardHeight / boardStyle.scaleBaseHeight)
    : widthScale;

  // 使用 ref 保持回调最新，避免 memo 化组件闭包过期
  const onPiecePressRef = useRef(onPiecePress);
  onPiecePressRef.current = onPiecePress;
  const onEmptyPressRef = useRef(onEmptyPress);
  onEmptyPressRef.current = onEmptyPress;
  const aiThinkingRef = useRef(aiThinking);
  aiThinkingRef.current = aiThinking;

  // 棋子位置动画值
  const [pieceAnims, setPieceAnims] = useState<Map<number, { x: Animated.Value; y: Animated.Value }>>(new Map());
  const prevPositions = useRef<Map<number, { x: number; y: number }>>(new Map());
  const isInitialLoad = useRef(true);

  // 缩放后的图片尺寸
  const scaledImageWidth = boardStyle.imgWidth * scale;
  const scaledImageHeight = boardStyle.imgHeight * scale;

  // UI 元素基准缩放：落点圆点/标记等硬编码尺寸以经典样式原图像素为口径，
  // 其它样式按「网格间距比例」换算，保证圆点、标记与棋格的屏幕占比
  // 与经典样式完全一致（经典样式下 unitScale === scale，行为零差异）
  const unitScale = scale * (styleGridX / GRID_SPACING_X);

  // 棋子大小（基于缩放比例，直径随样式几何变化）
  const pieceSize = Math.floor(boardStyle.pieceDiameter * scale);
  const pieceHalf = pieceSize / 2;

  // ===== 被吃棋子 =====
  // 摘要行常驻于棋盘上方（点击后由父级通过 onCapturedPress 在标题行正下方
  // 渲染 CapturedPiecesDrawer 明细抽屉，本组件不再内置展开层；
  // 明细项尺寸计算见 CapturedPiecesDrawer）

  // 左半区（对方损失）与右半区（我方损失）对应的被吃棋子
  const opponentLostIds = playerSide === 'red' ? capturedByRed : capturedByBlack;
  const mineLostIds = playerSide === 'red' ? capturedByBlack : capturedByRed;

  // 预计算所有网格交叉点位置（90个点，只算一次）
  const gridPositions = useMemo(() => {
    const positions: { x: number; y: number }[][] = [];
    for (let col = 0; col < COLS; col++) {
      positions[col] = [];
      for (let row = 0; row < ROWS; row++) {
        const displayCol = isFlipped ? 8 - col : col;
        const displayRow = isFlipped ? 9 - row : row;
        const origX = boardStyle.pieceLeft + displayCol * styleGridX;
        const origY = boardStyle.pieceTop + displayRow * styleGridY;
        positions[col][row] = { x: origX * scale, y: origY * scale };
      }
    }
    return positions;
  }, [scale, isFlipped, boardStyle, styleGridX, styleGridY]);

  // 获取棋子位置（从预计算的缓存中读取）
  const getPos = useCallback((col: number, row: number) => {
    return gridPositions[col][row];
  }, [gridPositions]);

  // 初始化或更新棋子动画值
  useEffect(() => {
    setPieceAnims(prevAnims => {
      const newAnims = new Map(prevAnims);
      // 【P4】changed：本次 effect 是否真的改了 newAnims。没有改动就原样返回 prevAnims
      // —— Map 虽然内容没变却是新对象，React 会照样判定 state 变了并触发一次全量重渲染。
      // 原来这里必然多渲染一遍整个棋盘（90 个交叉点 + 32 个棋子 + 特效层），
      // 在真机上就是"落子后那一拍卡顿"的固定成本。
      let changed = false;

      gameState.pieces.forEach(piece => {
        if (!piece.alive) return;

        const { x, y } = getPos(piece.col, piece.row);
        const prev = prevPositions.current.get(piece.id);

        if (!newAnims.has(piece.id)) {
          newAnims.set(piece.id, {
            x: new Animated.Value(x),
            y: new Animated.Value(y),
          });
          prevPositions.current.set(piece.id, { x, y });
          changed = true;
        } else if (!isInitialLoad.current && prev && (prev.x !== x || prev.y !== y)) {
          const anim = newAnims.get(piece.id)!;
          Animated.parallel([
            Animated.timing(anim.x, {
              toValue: x,
              duration: 200,
              useNativeDriver: false,
            }),
            Animated.timing(anim.y, {
              toValue: y,
              duration: 200,
              useNativeDriver: false,
            }),
          ]).start();
          prevPositions.current.set(piece.id, { x, y });
        } else if (isInitialLoad.current) {
          const anim = newAnims.get(piece.id)!;
          anim.x.setValue(x);
          anim.y.setValue(y);
          prevPositions.current.set(piece.id, { x, y });
        }
      });

      // 清理已死亡棋子的动画值
      const aliveIds = new Set(gameState.pieces.filter(p => p.alive).map(p => p.id));
      newAnims.forEach((_, id) => {
        if (!aliveIds.has(id)) {
          newAnims.delete(id);
          prevPositions.current.delete(id);
          changed = true;
        }
      });

      // 仅在内容真正变化时换引用（React 对同一引用直接跳过重渲染）
      return changed ? newAnims : prevAnims;
    });

    if (isInitialLoad.current) {
      isInitialLoad.current = false;
    }
  }, [gameState.pieces, getPos]);

  // 处理棋子点击（稳定引用，通过 ref 调用最新回调）
  const handlePieceTouch = useCallback((pieceId: number) => {
    if (aiThinkingRef.current) return;
    onPiecePressRef.current(pieceId);
    // 【P2】棋子层的触摸也要收尾。棋子层不是 overlay，没有 onResponderTerminate 兜底，
    // 不显式调用的话 touchInteractionActive 会一直保持 true。
    endBoardInteraction();
  }, []);

  // 处理棋盘触摸（空白处或棋子位置均可，作为 PieceItem 的兜底）
  const handleTouch = useCallback((event: GestureResponderEvent) => {
    // 【P2】AI 思考中同样要收尾：此时不做任何处理，但必须结束"交互进行中"标记，
    // 否则 noteBoardInteraction 置起的 touchInteractionActive 会一直挂着，
    // 后台提示预计算将永久无法启动。
    if (aiThinkingRef.current) {
      endBoardInteraction();
      return;
    }

    const { locationX, locationY } = event.nativeEvent;
    const origX = locationX / scale;
    const origY = locationY / scale;

    let closestCol = -1;
    let closestRow = -1;
    let minDistance = Infinity;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const displayCol = isFlipped ? 8 - col : col;
        const displayRow = isFlipped ? 9 - row : row;

        const pieceX = boardStyle.pieceLeft + displayCol * styleGridX;
        const pieceY = boardStyle.pieceTop + displayRow * styleGridY;
        const distance = Math.sqrt(
          Math.pow(origX - pieceX, 2) + Math.pow(origY - pieceY, 2)
        );

        if (distance < minDistance && distance < pieceSize / scale) {
          minDistance = distance;
          closestCol = col;
          closestRow = row;
        }
      }
    }

    if (closestCol === -1 || closestRow === -1) {
      endBoardInteraction();
      return;
    }

    // 检查该位置是否有存活棋子
    const piece = gameState.pieces.find(
      p => p.alive && p.col === closestCol && p.row === closestRow
    );

    if (piece) {
      onPiecePressRef.current(piece.id);
    } else {
      onEmptyPressRef.current(closestCol, closestRow);
    }
    // 【P2】本次交互结束，开启静默宽限期：这段时间内不重启后台预计算
    endBoardInteraction();
  }, [scale, isFlipped, pieceSize, gameState.pieces, boardStyle, styleGridX, styleGridY]);

  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onBoardLayoutRef = useRef(onBoardLayout);
  onBoardLayoutRef.current = onBoardLayout;

  // 渲染合法移动提示点
  //
  // 【P4】落点点击用 ref 而不是闭包：原来 `onPress={() => onMove && onMove(col,row)}`
  // 把 onMove 变成了 memo 的依赖，父级每次重建 onMove 回调都会让这一整层落点重新
  // 渲染（选中棋子时最多 8 个）。改用 ref 后 onMove 的引用变化不再穿透进来。
  const validMoveElements = useMemo(() => {
    if (!validMoves) return null;

    const indicators: React.ReactNode[] = [];
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        if (validMoves[col] && validMoves[col][row]) {
          const { x, y } = getPos(col, row);
          indicators.push(
            <TouchableOpacity
              key={`valid-${col}-${row}`}
              onPress={() => onMoveRef.current?.(col, row)}
              activeOpacity={0.7}
              style={[
                styles.validMoveIndicator,
                {
                  width: 24 * unitScale,
                  height: 24 * unitScale,
                  borderRadius: 12 * unitScale,
                  left: x - 12 * unitScale,
                  top: y - 12 * unitScale,
                },
              ]}
            />
          );
        }
      }
    }
    return indicators;
  }, [validMoves, getPos, unitScale]);

  // 渲染上一步标记
  const lastMoveMarker = useMemo(() => {
    if (!lastMove) return null;

    // 若上一步起始位置恰是当前选中棋子的合法落点，隐藏起始位置标识，
    // 避免白色圆环与落点提示点重叠，保证用户能清晰辨认允许的落点
    if (validMoves && validMoves[lastMove.fromCol] && validMoves[lastMove.fromCol][lastMove.fromRow]) {
      return null;
    }

    const { x, y } = getPos(lastMove.fromCol, lastMove.fromRow);
    // 【C-75】pieceSize 已经是屏幕像素（= 棋子直径 × scale），unitScale 是无量纲比例，
    //   两者相乘等于把缩放乘了两次（0.8 · 直径 · scale²）。390px 宽屏 scale≈0.593 时
    //   markerSize 只剩 ≈18.5px，而这个环又画在棋子层之下，窄屏上基本看不见 ——
    //   「上一步从哪来」的提示等于没有。同文件其余尺寸一律只用 pieceSize。
    const markerSize = pieceSize * 0.8;
    const innerSize = markerSize * 0.4;
    const borderWidth = Math.max(markerSize * 0.06, 2);

    return (
      <View
        key="lastmove-from"
        pointerEvents="none"
        style={[
          styles.lastMoveMarker,
          {
            width: markerSize,
            height: markerSize,
            borderRadius: markerSize / 2,
            left: x - markerSize / 2,
            top: y - markerSize / 2,
            borderWidth: borderWidth,
            borderColor: 'rgba(255, 255, 255, 0.8)',
            backgroundColor: 'transparent',
          },
        ]}
      >
        <View
          pointerEvents="none"
          style={{
            width: innerSize,
            height: innerSize,
            borderRadius: innerSize / 2,
            backgroundColor: 'rgba(255, 255, 255, 0.8)',
            alignSelf: 'center',
            marginTop: 'auto',
            marginBottom: 'auto',
          }}
        />
      </View>
    );
  }, [lastMove, getPos, pieceSize, validMoves]);

  // 移动后的棋子额外效果：在最近落子（lastMove 目标格）的棋子外圈绘制白色较窄光圈，
  // 上下左右断开形成四段圆弧（缺口对准正上/正下/正左/正右），与棋子保持间距，
  // 清晰标识"上一步走到了哪里"。置于棋子图层下方，光圈在棋子外沿之外不遮挡棋子。
  const movedPieceRingMarker = useMemo(() => {
    if (!lastMove) return null;
    const { x, y } = getPos(lastMove.toCol, lastMove.toRow);

    // 光圈宽度与棋子间距均约为棋子尺寸的 5%（保底值防止极小棋子时不可见）
    const ringWidth = Math.max(1.5, pieceSize * 0.05);
    const gapFromPiece = Math.max(2, pieceSize * 0.05);
    // 光圈中心线半径 = 棋子半径 + 间距 + 光圈半宽
    const ringRadius = pieceSize / 2 + gapFromPiece + ringWidth / 2;
    // SVG 画布尺寸（完整容纳光圈外沿，向上取整并留 1px 余量防裁剪）
    const svgSize = Math.ceil((ringRadius + ringWidth / 2) * 2) + 2;
    // 四段圆弧：每象限 90° = 弧 60° + 缺口 30°；dashoffset 使缺口中心对准起点（正右），
    // 随周长四等分后缺口恰好落在正右/正下/正左/正上，四段弧位于四个斜向
    const circumference = 2 * Math.PI * ringRadius;
    const arcLen = circumference * (60 / 360);
    const gapLen = circumference * (30 / 360);

    return (
      <Svg
        key="lastmove-to-ring"
        width={svgSize}
        height={svgSize}
        pointerEvents="none"
        style={[
          styles.movedPieceRing,
          { left: x - svgSize / 2, top: y - svgSize / 2 },
        ]}
      >
        <Circle
          cx={svgSize / 2}
          cy={svgSize / 2}
          r={ringRadius}
          stroke="rgba(255, 255, 255, 0.85)"
          strokeWidth={ringWidth}
          fill="none"
          strokeDasharray={[arcLen, gapLen]}
          strokeDashoffset={arcLen + gapLen / 2}
        />
      </Svg>
    );
  }, [lastMove, getPos, pieceSize]);

  // 渲染提示标记：待走棋子橙色外圈 + 提示落点橙色圆点
  // 待走棋子外圈与"移动后位置外圈"(movedPieceRingMarker)保持完全一致的样式
  // （四段圆弧光圈、相同线宽/间距/缺口朝向），仅颜色使用橙色。
  const hintMarker = useMemo(() => {
    if (!hintMove) return null;
    const piece = gameState.pieces[hintMove.pieceId];
    if (!piece || !piece.alive) return null;

    const fromPos = getPos(piece.col, piece.row);
    const toPos = getPos(hintMove.toCol, hintMove.toRow);

    // 与 movedPieceRingMarker 完全一致的几何参数：
    // 光圈宽度与棋子间距均约为棋子尺寸的 5%，缺口对准正上/正下/正左/正右
    const ringWidth = Math.max(1.5, pieceSize * 0.05);
    const gapFromPiece = Math.max(2, pieceSize * 0.05);
    const ringRadius = pieceSize / 2 + gapFromPiece + ringWidth / 2;
    const svgSize = Math.ceil((ringRadius + ringWidth / 2) * 2) + 2;
    const circumference = 2 * Math.PI * ringRadius;
    const arcLen = circumference * (60 / 360);
    const gapLen = circumference * (30 / 360);

    // 提示落点：尺寸与正常可落点提示一致（按样式口径换算）
    const dotSize = 24 * unitScale;

    return [
      // 最优解待走棋子：橙色四段圆弧光圈（样式同移动后位置外圈）
      <Svg
        key="hint-from"
        width={svgSize}
        height={svgSize}
        pointerEvents="none"
        style={[
          styles.movedPieceRing,
          { left: fromPos.x - svgSize / 2, top: fromPos.y - svgSize / 2 },
        ]}
      >
        <Circle
          cx={svgSize / 2}
          cy={svgSize / 2}
          r={ringRadius}
          stroke="#F57C00"
          strokeWidth={ringWidth}
          fill="none"
          strokeDasharray={[arcLen, gapLen]}
          strokeDashoffset={arcLen + gapLen / 2}
        />
      </Svg>,
      // 提示落点：橙色圆点
      <View
        key="hint-to"
        pointerEvents="none"
        style={[
          styles.hintDot,
          {
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            left: toPos.x - dotSize / 2,
            top: toPos.y - dotSize / 2,
          },
        ]}
      />,
    ];
  }, [hintMove, gameState.pieces, getPos, pieceSize, unitScale]);

  // 渲染长将长捉超限落点警示（方案 10 娱乐向改造「棋盘上高亮会继续长将/长捉的着法」）：
  // 超限落点绘制红色警示符号（圆环 + 对角斜杠），与提示落点同样不拦截触摸——可正常落子
  const banMarkers = useMemo(() => {
    if (!banMoves || banMoves.length === 0) return null;
    const markSize = Math.max(18, pieceSize * 0.6);
    const r = markSize / 2 - 1;
    const cross = r * 0.62; // 斜杠半径（略小于圆环，留出边距）
    return banMoves.map((m, i) => {
      const pos = getPos(m.toCol, m.toRow);
      return (
        <Svg
          key={`ban-${i}-${m.pieceId}-${m.toCol}-${m.toRow}`}
          width={markSize}
          height={markSize}
          pointerEvents="none"
          style={[
            styles.movedPieceRing,
            { left: pos.x - markSize / 2, top: pos.y - markSize / 2 },
          ]}
        >
          <Circle
            cx={markSize / 2}
            cy={markSize / 2}
            r={r}
            stroke="#D32F2F"
            strokeWidth={Math.max(1.5, markSize * 0.07)}
            fill="none"
          />
          <Line
            x1={markSize / 2 - cross}
            y1={markSize / 2 - cross}
            x2={markSize / 2 + cross}
            y2={markSize / 2 + cross}
            stroke="#D32F2F"
            strokeWidth={Math.max(1.5, markSize * 0.07)}
          />
          <Line
            x1={markSize / 2 - cross}
            y1={markSize / 2 + cross}
            x2={markSize / 2 + cross}
            y2={markSize / 2 - cross}
            stroke="#D32F2F"
            strokeWidth={Math.max(1.5, markSize * 0.07)}
          />
        </Svg>
      );
    });
  }, [banMoves, getPos, pieceSize]);

  const boardImage = isFlipped ? boardStyle.flippedImage : boardStyle.normalImage;

  return (
    // 外层容器宽度使用数值屏宽（而非 alignSelf: 'stretch'——部分 Android 设备
    // 的 Yoga 对 stretch 处理不可靠，容器会收缩包裹比屏幕宽约 21% 的棋盘容器，
    // 导致被吃棋子半区（flex:1）超出屏幕）。容器由父级 alignItems: 'center' 居中，
    // 宽度恰好等于屏幕可见宽，棋盘容器在其中居中、视觉效果与之前完全一致。
    <View style={[styles.outerContainer, { width: screenWidth }]}>
      {/* 被吃棋子覆盖层：独立全宽条带，锚定在棋盘上方。
          参照系是数值屏宽的 outerContainer（而非可能超宽的棋盘容器）。
          两个半区各显示摘要文字（对方/我方损失棋子：N），点击后通过
          onCapturedPress 通知父级在标题行正下方展开明细抽屉 */}
      {!hideCaptured && (
        <View
          style={[
            styles.capturedStrip,
            // 棋盘上方有其他元素（如 AI 标识角标行）时整体上移，保证摘要文字不与其重叠
            capturedStripOffset > 0 && { marginBottom: 8 + capturedStripOffset },
          ]}
          pointerEvents="box-none"
        >
          {/* 摘要行：左右各半（固定高度） */}
          <View style={styles.capturedSummaryRow}>
            {(
              [
                { ids: opponentLostIds, title: '对方损失棋子', side: 'opponent' as const },
                { ids: mineLostIds, title: '我方损失棋子', side: 'mine' as const },
              ]
            ).map(({ ids, title, side }) => {
              // 无损失时仅保留占位槽位维持左右各半布局
              if (ids.length === 0) {
                return <View key={side} style={styles.capturedHalf} />;
              }
              return (
                <TouchableOpacity
                  key={side}
                  style={styles.capturedHalf}
                  activeOpacity={0.7}
                  onPress={() => onCapturedPress?.(side)}
                >
                  <Text style={styles.capturedTitle}>{title}：{ids.length}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      <View
        style={[
          styles.container,
          {
            width: scaledImageWidth,
            height: scaledImageHeight,
          },
        ]}
        onLayout={
          onBoardLayoutRef.current
            ? (e) => {
                const { width, height } = e.nativeEvent.layout;
                onBoardLayoutRef.current?.({ width, height });
              }
            : undefined
        }
      >
      {/* 棋盘图片 */}
      <Image
        source={boardImage}
        style={[
          styles.boardImage,
          {
            width: scaledImageWidth,
            height: scaledImageHeight,
          },
        ]}
        resizeMode="contain"
      />

      {/* 棋子和交互层 */}
      <View
        style={[
          styles.overlay,
          {
            width: scaledImageWidth,
            height: scaledImageHeight,
            left: 0,
            top: 0,
          },
        ]}
        // 必须返回 true 认领触摸响应：棋子/落点提示是更深的子视图，会优先认领；
        // 空白处无人认领时由本层兜底，onResponderRelease 才会触发 handleTouch
        // （否则点击空白处没有任何视图成为 responder，取消选中逻辑永远不会执行）。
        // 拖动时父级 ScrollView 可通过默认的终止请求接管响应，不影响页面滚动。
        //
        // 【P2】onStartShouldSetResponder 是**触摸按下的那一刻**同步触发的，比 onResponderRelease
        // 早（后者要等抬手）。后台提示预计算必须在这里就被通知并中止：等到抬手才通知，
        // 这次点击本身就已经被搜索占用的线程延迟过了。
        onStartShouldSetResponder={(e) => {
          noteBoardInteraction();
          return true;
        }}
        onResponderRelease={handleTouch}
        // 抬手/取消后开启静默宽限期，期间不重启预计算（见 AIEngine.HINT_TOUCH_GRACE_MS）
        onResponderTerminate={() => endBoardInteraction()}
      >
        {/* 上一步标记 */}
        {lastMoveMarker}

        {/* 移动后的棋子外圈四段圆弧光圈（最近落子标识） */}
        {movedPieceRingMarker}

        {/* 提示标记（最优解：橙色描边 + 橙色落点） */}
        {hintMarker}
        {banMarkers}

        {/* 让子幽灵标记：被让出的棋子原位半透明展示 + 红色「让」角标。
            渲染在真实棋子下层，交叉点被占据后自动隐藏，不拦截任何触摸 */}
        {ghostPieces?.map(g => {
          if (gameState.qiPan[g.col]?.[g.row] !== -1) return null;
          const pos = getPos(g.col, g.row);
          const badgeSize = pieceSize * 0.46;
          return (
            <View
              key={`ghost-${g.id}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: pos.x - pieceHalf,
                top: pos.y - pieceHalf,
                width: pieceSize,
                height: pieceSize,
              }}
            >
              <Image
                source={getPieceImage(g.id)}
                style={{ width: pieceSize, height: pieceSize, opacity: 0.35 }}
                resizeMode="contain"
              />
              <View
                style={[styles.ghostBadge, {
                  top: -badgeSize * 0.2,
                  right: -badgeSize * 0.2,
                  width: badgeSize,
                  height: badgeSize,
                  borderRadius: badgeSize / 2,
                  borderWidth: Math.max(badgeSize * 0.07, 1),
                }]}
              >
                <Text style={[styles.ghostBadgeText, { fontSize: badgeSize * 0.58 }]}>让</Text>
              </View>
            </View>
          );
        })}

        {/* 棋子 - 直接遍历传递，避免 find() 查找 */}
        {gameState.pieces.map(piece => {
          if (!piece.alive) return null;
          const anim = pieceAnims.get(piece.id);
          if (!anim) return null;

          return (
            <PieceItem
              key={piece.id}
              pieceId={piece.id}
              imageSource={getPieceImage(piece.id)}
              animX={anim.x}
              animY={anim.y}
              pieceSize={pieceSize}
              pieceHalf={pieceHalf}
              isSelected={selectedPieceId === piece.id}
              onPress={handlePieceTouch}
            />
          );
        })}

        {/* 合法移动提示 */}
        {validMoveElements}
      </View>

      {/* 吃子/将军特效（最上层浮层，pointerEvents=none 不拦截棋盘触摸；
          常驻挂载：闲置时内部以 opacity 0 预渲染素材完成解码，首次播放无加载延迟） */}
      <MoveEffectOverlay
        effect={moveEffect}
        boardWidth={scaledImageWidth}
        boardHeight={scaledImageHeight}
      />
      </View>
    </View>
  );
}

// ==================== Captured Pieces Drawer (导出，由对局页渲染) ====================

export interface CapturedPiecesDrawerProps {
  /** 展开的一侧；null 表示收起 */
  side: 'opponent' | 'mine' | null;
  gameState: GameState;
  /** 玩家执棋方（用于区分对方/我方被吃棋子） */
  playerSide: 'red' | 'black';
  /** 棋盘可用的最大纵向高度（与 ChessBoard 同参），用于保持明细棋子尺寸与棋盘一致缩放 */
  maxBoardHeight?: number;
}

/**
 * 被吃棋子明细抽屉：由对局页渲染在【顶部标题行正下方】的全宽浮层
 * （绝对定位，覆盖摘要行与棋盘上方区域，不挤压任何布局、棋盘位置不动）。
 * 规格与棋盘摘要行一致：80% 棋子图尺寸随屏宽自适应 + 右上方红色数量角标。
 * 父级使用方式：作为标题行下方相对定位容器（flex:1，无 padding）的首个子节点。
 */
export function CapturedPiecesDrawer({ side, gameState, playerSide, maxBoardHeight }: CapturedPiecesDrawerProps) {
  // 动画值用 useState 惰性初始化（避免渲染期访问 ref.current）
  const [anim] = useState(() => new Animated.Value(0));
  // 实际渲染的一侧：收起动画播放期间保持渲染，动画结束后再卸载
  const [renderedSide, setRenderedSide] = useState<'opponent' | 'mine' | null>(side);

  // 渲染期派生（React 官方 adjust-state-during-render 模式）：
  // 展开/切换时立即同步渲染目标；收起时保留旧值直至退出动画结束
  if (side && side !== renderedSide) {
    setRenderedSide(side);
  }

  // 展开：下滑 + 淡入；收起：上滑 + 淡出，动画结束后卸载
  useEffect(() => {
    if (side) {
      Animated.timing(anim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    } else if (renderedSide) {
      Animated.timing(anim, { toValue: 0, duration: 140, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setRenderedSide(null);
      });
    }
  }, [side, renderedSide, anim]);

  // 由 gameState 推导双方被吃棋子（口径与 ChessBoard 摘要行完全一致：
  // capturedByRed=红方战果（被吃的黑方棋子），capturedByBlack=黑方战果（被吃的红方棋子）；
  // "对方损失"=被玩家吃掉的对方棋子）
  const capturedByRed: number[] = [];
  const capturedByBlack: number[] = [];
  gameState.pieces.forEach((p) => {
    if (!p.alive) {
      if (p.id >= 16) capturedByBlack.push(p.id);
      else capturedByRed.push(p.id);
    }
  });
  const ids = renderedSide === 'opponent'
    ? (playerSide === 'red' ? capturedByRed : capturedByBlack)
    : (playerSide === 'red' ? capturedByBlack : capturedByRed);

  // 与 ChessBoard 相同的尺寸计算（80% 棋子图 + 角标按基准比例联动）；
  // 棋盘因纵向空间不足缩小时，明细棋子同步缩小
  // 【C-77】同 ChessBoard 主组件：Dimensions.get('window') 是模块级快照，改为订阅式 hook
  const { width: screenWidth } = useWindowDimensions();
  const drawerStyle = useBoardStyle();
  const widthScale = (screenWidth - 16) / drawerStyle.scaleBaseWidth;
  const scale = maxBoardHeight && maxBoardHeight > 0
    ? Math.min(widthScale, maxBoardHeight / drawerStyle.scaleBaseHeight)
    : widthScale;
  const pieceSize = Math.floor(drawerStyle.pieceDiameter * scale);
  const capturedPieceSize = Math.max(Math.floor(pieceSize * 0.8), 1);
  const capturedBadgeSize = Math.max(Math.round(capturedPieceSize * 0.47), 12);
  const capturedBadgeFont = Math.max(Math.round(capturedBadgeSize * 0.6), 8);
  const capturedBadgeOffset = -Math.round(capturedBadgeSize * 0.27);

  // 未展开（且收起动画已结束）或该方暂无棋子时不渲染（自动收起，避免空卡片）
  if (!renderedSide || ids.length === 0) return null;

  return (
    <Animated.View
      style={[
        styles.capturedDrawerOverlay,
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }],
        },
      ]}
      collapsable={false}
    >
      <View style={styles.capturedPiecesRow}>
        {groupCapturedPieces(ids).map(([name, gids]) => (
          <View key={name} style={styles.capturedPieceItem}>
            <Image
              source={getPieceImage(gids[0])}
              style={{ width: capturedPieceSize, height: capturedPieceSize }}
            />
            {/* 数量角标：棋子右上方红色圆标，仅数量 > 1 时显示 */}
            {gids.length > 1 && (
              <View
                style={[
                  styles.capturedPieceBadge,
                  {
                    top: capturedBadgeOffset,
                    right: capturedBadgeOffset,
                    minWidth: capturedBadgeSize,
                    height: capturedBadgeSize,
                    borderRadius: capturedBadgeSize / 2,
                    paddingHorizontal: capturedBadgeSize * 0.17,
                  },
                ]}
              >
                <Text
                  allowFontScaling={false}
                  style={[
                    styles.capturedPieceBadgeText,
                    {
                      fontSize: capturedBadgeFont,
                      lineHeight: Math.max(Math.round(capturedBadgeFont * 1.2), 1),
                    },
                  ]}
                >
                  {gids.length}
                </Text>
              </View>
            )}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    alignItems: 'center',
    // 宽度在渲染处以数值屏宽传入（见 return 处的注释），不依赖 alignSelf: 'stretch'
  },
  container: {
    position: 'relative',
  },
  boardImage: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  overlay: {
    position: 'absolute',
    zIndex: 1,
  },
  // 外层阴影容器：负责阴影。两点关键：
  // 1) Android 的阴影依赖视图轮廓（outline），轮廓来源于背景——无背景色则轮廓为空，
  //    阴影完全不渲染，因此必须设置背景色（与内层同色同圆角，视觉无变化）；
  // 2) 旧版 shadow* 属性仅 iOS 有效、在新架构中已弃用，boxShadow 三端统一支持。
  pieceContainer: {
    position: 'absolute',
    backgroundColor: '#b1824e',
    boxShadow: '6px 6px 8px rgba(0, 0, 0, 0.3)',
  },
  // 内层内容容器：负责背景色、圆形裁剪
  pieceContent: {
    alignItems: 'center',
    justifyContent: 'center',
    // 木质底色，消除棋子 PNG 半透明边缘与棋盘背景之间的白色缝隙
    backgroundColor: '#b1824e',
    overflow: 'hidden',
  },
  pieceImage: {
    // 棋子图片填满容器
  },
  selectedRing: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#fff',
    opacity: 0.9,
  },
  // 让子幽灵棋子的「让」角标：尺寸/偏移/描边/字号在使用处随棋子大小等比计算
  ghostBadge: {
    position: 'absolute',
    backgroundColor: '#C0392B',
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#FFF',
  },
  ghostBadgeText: {
    color: '#FFF',
    fontWeight: '700',
    textAlign: 'center',
  },
  validMoveIndicator: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.7)',
    zIndex: 10,
  },
  lastMoveMarker: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  // 移动后棋子的四段圆弧光圈：绝对定位于最近落子，置于棋子图层下方（不遮挡棋子）。
  // 提示功能的待走棋子外圈复用此样式（仅描边颜色改为橙色）
  movedPieceRing: {
    position: 'absolute',
    zIndex: 2,
  },
  // 提示：落点橙色圆点（无白色外圈，80% 不透明度，尺寸同正常可落点提示）
  hintDot: {
    position: 'absolute',
    backgroundColor: 'rgba(245, 124, 0, 0.8)',
    zIndex: 9,
  },
  capturedStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    marginBottom: 8,
    zIndex: 10,
  },
  capturedSummaryRow: {
    flexDirection: 'row',
    // 固定高度，摘要行位置始终不动
    height: CAPTURED_SUMMARY_H,
  },
  capturedHalf: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4, // 扩大摘要文字的点击区域
  },
  // 明细弹窗：居中卡片浮层，与棋盘/标题行完全解耦
  // 被吃棋子抽屉：绝对定位于摘要行正下方，向下展开覆盖棋盘上方区域；
  // zIndex/elevation 高于棋盘层，保证 Android Release 下也不被棋盘遮挡
  // 被吃棋子明细抽屉（对局页层级 CapturedPiecesDrawer 使用）：
  // 锚定顶部标题行正下方，全宽实心浮层，覆盖摘要行与棋盘上方区域；
  // zIndex/elevation 置于最高层，collapsable={false} 防止 Android Release
  // 视图扁平化导致被棋盘遮挡
  capturedDrawerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
    paddingHorizontal: 12,
    paddingVertical: 10,
    zIndex: 50,
    elevation: 50,
  },
  capturedPiecesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    alignSelf: 'stretch',
    paddingHorizontal: 4,
    // 注意：此处不能使用 gap 属性——Yoga（Android）在 gap + flexWrap 组合下
    // 换行宽度计算有缺陷，会导致最后一项的"×数量"文字被挤出屏幕。
    // 间距通过 capturedPieceItem 的 marginHorizontal 实现。
  },
  capturedTitle: {
    fontSize: FONT.body,
    color: '#666',
  },
  capturedPieceItem: {
    // 数量改为右上角角标后，项尺寸即棋子图尺寸；角标绝对定位于项内
    position: 'relative',
    // 对称外边距代替 gap：相邻项间距 6px，且每项的完整宽度
    // （棋子图 + 外边距）都会被计入换行判断
    marginHorizontal: 3,
    marginVertical: 3,
  },
  // 数量角标：棋子右上方红色圆形标记（参考通知角标样式），
  // 略微超出棋子边缘形成叠加感；白字细边保证在木质底色上清晰。
  // 尺寸/偏移/内边距均随棋子图尺寸按比例内联传入（移动端自适应）
  capturedPieceBadge: {
    position: 'absolute',
    backgroundColor: '#C62828',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.85)',
  },
  capturedPieceBadgeText: {
    color: '#fff',
    fontWeight: '700',
  },
});
