/**
 * 棋盘样式注册表
 *
 * 每套样式包含：
 * - 两个方向的棋盘背景图（normalImage = 默认红方在下视角；flippedImage = 黑方在下视角）
 * - 该样式背景图对应的几何换算参数（原始图像素坐标），ChessBoard / BoardEditor
 *   依据这些参数把 9x10 交叉点网格映射到屏幕上，保证棋子与任意样式背景精准对齐。
 *
 * 几何参数来源：对背景图做网格线检测实测得出。
 */

export type BoardStyleId = 'classic' | 'huali' | 'xuanmo';

export interface BoardStyle {
  id: BoardStyleId;
  /** 样式展示名 */
  name: string;
  /** 样式一句话描述 */
  desc: string;
  /** 背景图原始宽度（像素） */
  imgWidth: number;
  /** 背景图原始高度（像素） */
  imgHeight: number;
  /** 交叉点网格区域（原始图像素坐标）：第 0 列 / 第 0 行 / 第 8 列 / 第 9 行 */
  pieceLeft: number;
  pieceTop: number;
  pieceRight: number;
  pieceBottom: number;
  /** 棋子直径（原始图像素），随 scale 等比缩放 */
  pieceDiameter: number;
  /** 屏宽映射基准：scale = (screenWidth - 16) / scaleBaseWidth */
  scaleBaseWidth: number;
  /** 纵向限高基准：scale = maxBoardHeight / scaleBaseHeight */
  scaleBaseHeight: number;
  /** 默认视角（红方在下）背景图 */
  normalImage: any;
  /** 翻转视角（黑方在下）背景图 */
  flippedImage: any;
}

export const BOARD_STYLES: BoardStyle[] = [
  {
    id: 'classic',
    name: '经典',
    desc: '经典默认',
    // 经典图已裁切到棋框边界（去除透明边距），与花梨木/玄墨保持一致的紧凑布局
    imgWidth: 633,
    imgHeight: 699,
    pieceLeft: 44,
    pieceTop: 44,
    pieceRight: 584,
    pieceBottom: 652,
    pieceDiameter: 66,
    scaleBaseWidth: 631,
    scaleBaseHeight: 699,
    normalImage: require('@/assets/boards/board_classic_redtop.png'),
    flippedImage: require('@/assets/boards/board_classic_blacktop.png'),
  },
  {
    id: 'huali',
    name: '花梨木',
    desc: '温润原木',
    imgWidth: 891,
    imgHeight: 981,
    pieceLeft: 64.6,
    pieceTop: 63.9,
    pieceRight: 822.3,
    pieceBottom: 911.0,
    pieceDiameter: 92,
    scaleBaseWidth: 891,
    scaleBaseHeight: 981,
    normalImage: require('@/assets/boards/board_huali_redtop.jpg'),
    flippedImage: require('@/assets/boards/board_huali_blacktop.jpg'),
  },
  {
    id: 'xuanmo',
    name: '玄墨',
    desc: '墨底红韵',
    imgWidth: 893,
    imgHeight: 985,
    pieceLeft: 68,
    pieceTop: 69,
    pieceRight: 822.6,
    pieceBottom: 913,
    pieceDiameter: 92,
    scaleBaseWidth: 893,
    scaleBaseHeight: 985,
    normalImage: require('@/assets/boards/board_xuanmo_redtop.jpg'),
    flippedImage: require('@/assets/boards/board_xuanmo_blacktop.jpg'),
  },
];

const STYLE_MAP: Record<BoardStyleId, BoardStyle> = BOARD_STYLES.reduce(
  (acc, s) => {
    acc[s.id] = s;
    return acc;
  },
  {} as Record<BoardStyleId, BoardStyle>
);

export const DEFAULT_BOARD_STYLE_ID: BoardStyleId = 'classic';

export function getBoardStyle(id: BoardStyleId | null | undefined): BoardStyle {
  return (id && STYLE_MAP[id]) || STYLE_MAP[DEFAULT_BOARD_STYLE_ID];
}

/** 交叉点横向间距（原始图像素） */
export function gridSpacingX(style: BoardStyle): number {
  return (style.pieceRight - style.pieceLeft) / 8;
}

/** 交叉点纵向间距（原始图像素） */
export function gridSpacingY(style: BoardStyle): number {
  return (style.pieceBottom - style.pieceTop) / 9;
}
