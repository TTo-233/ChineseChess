/**
 * 棋子图片映射
 * 将棋子ID映射到对应的图片资源
 */

const PIECE_IMAGES: Record<number, any> = {
  0: require('@/assets/pieces/jiang.png'),       // 黑将
  1: require('@/assets/pieces/shi_black.png'),   // 黑士
  2: require('@/assets/pieces/shi_black.png'),   // 黑士
  3: require('@/assets/pieces/xiang_black.png'), // 黑象
  4: require('@/assets/pieces/xiang_black.png'), // 黑象
  5: require('@/assets/pieces/ma_black.png'),    // 黑马
  6: require('@/assets/pieces/ma_black.png'),    // 黑马
  7: require('@/assets/pieces/ju_black.png'),    // 黑车
  8: require('@/assets/pieces/ju_black.png'),    // 黑车
  9: require('@/assets/pieces/pao_black.png'),   // 黑炮
  10: require('@/assets/pieces/pao_black.png'),  // 黑炮
  11: require('@/assets/pieces/zu.png'),         // 黑卒
  12: require('@/assets/pieces/zu.png'),         // 黑卒
  13: require('@/assets/pieces/zu.png'),         // 黑卒
  14: require('@/assets/pieces/zu.png'),         // 黑卒
  15: require('@/assets/pieces/zu.png'),         // 黑卒
  16: require('@/assets/pieces/shuai.png'),      // 红帅
  17: require('@/assets/pieces/shi_red.png'),    // 红仕
  18: require('@/assets/pieces/shi_red.png'),    // 红仕
  19: require('@/assets/pieces/xiang_red.png'),  // 红相
  20: require('@/assets/pieces/xiang_red.png'),  // 红相
  21: require('@/assets/pieces/ma_red.png'),     // 红马
  22: require('@/assets/pieces/ma_red.png'),     // 红马
  23: require('@/assets/pieces/ju_red.png'),     // 红车
  24: require('@/assets/pieces/ju_red.png'),     // 红车
  25: require('@/assets/pieces/pao_red.png'),    // 红炮
  26: require('@/assets/pieces/pao_red.png'),    // 红炮
  27: require('@/assets/pieces/bing.png'),       // 红兵
  28: require('@/assets/pieces/bing.png'),       // 红兵
  29: require('@/assets/pieces/bing.png'),       // 红兵
  30: require('@/assets/pieces/bing.png'),       // 红兵
  31: require('@/assets/pieces/bing.png'),       // 红兵
};

export function getPieceImage(pieceId: number): any {
  return PIECE_IMAGES[pieceId] || null;
}

// 棋子名称映射（用于显示）
export const PIECE_NAMES: Record<number, string> = {
  0: '将', 1: '士', 2: '士', 3: '象', 4: '象',
  5: '馬', 6: '馬', 7: '車', 8: '車',
  9: '砲', 10: '砲', 11: '卒', 12: '卒', 13: '卒', 14: '卒', 15: '卒',
  16: '帅', 17: '仕', 18: '仕', 19: '相', 20: '相',
  21: '馬', 22: '馬', 23: '車', 24: '車',
  25: '炮', 26: '炮', 27: '兵', 28: '兵', 29: '兵', 30: '兵', 31: '兵',
};

// 棋盘背景图片统一由 utils/chess/boardStyles.ts 管理（含经典/花梨木/玄墨多样式）
