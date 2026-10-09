/**
 * 棋子图片映射
 * 将棋子ID映射到对应的图片资源
 */

import { representativeId } from './jieqi';
import { RED_SIDE, BLACK_SIDE, type JieqiPieceType } from './types';

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

// ---------------------------------------------------------------------------
// 揭棋 · 暗子背面图
//
// 与上面的 PIECE_IMAGES **分开**导出：正面表是「id → 该子的正面图」，
// 而揭棋的渲染取决于「此刻是明子还是暗子」，同一个 id 在不同时刻要显示不同图。
// 正面表保持 id → 正面图 的单一语义不变（象棋路径零改动），
// 揭棋由调用方（ChessBoard）根据 hiddenMask 选用背面图。
// ---------------------------------------------------------------------------

/** 暗子背面图：按 id 所属阵营取黑/红两张之一 */
const FACE_DOWN_IMAGES: Record<number, any> = {
  0: require('@/assets/pieces/face_down_black.png'),       // 黑将
  1: require('@/assets/pieces/face_down_black.png'),       // 黑士
  2: require('@/assets/pieces/face_down_black.png'),       // 黑士
  3: require('@/assets/pieces/face_down_black.png'),       // 黑象
  4: require('@/assets/pieces/face_down_black.png'),       // 黑象
  5: require('@/assets/pieces/face_down_black.png'),       // 黑马
  6: require('@/assets/pieces/face_down_black.png'),       // 黑马
  7: require('@/assets/pieces/face_down_black.png'),       // 黑车
  8: require('@/assets/pieces/face_down_black.png'),       // 黑车
  9: require('@/assets/pieces/face_down_black.png'),       // 黑炮
  10: require('@/assets/pieces/face_down_black.png'),      // 黑炮
  11: require('@/assets/pieces/face_down_black.png'),      // 黑卒
  12: require('@/assets/pieces/face_down_black.png'),      // 黑卒
  13: require('@/assets/pieces/face_down_black.png'),      // 黑卒
  14: require('@/assets/pieces/face_down_black.png'),      // 黑卒
  15: require('@/assets/pieces/face_down_black.png'),      // 黑卒
  16: require('@/assets/pieces/face_down_red.png'),        // 红帅
  17: require('@/assets/pieces/face_down_red.png'),        // 红仕
  18: require('@/assets/pieces/face_down_red.png'),        // 红仕
  19: require('@/assets/pieces/face_down_red.png'),        // 红相
  20: require('@/assets/pieces/face_down_red.png'),        // 红相
  21: require('@/assets/pieces/face_down_red.png'),        // 红马
  22: require('@/assets/pieces/face_down_red.png'),        // 红马
  23: require('@/assets/pieces/face_down_red.png'),        // 红车
  24: require('@/assets/pieces/face_down_red.png'),        // 红车
  25: require('@/assets/pieces/face_down_red.png'),        // 红炮
  26: require('@/assets/pieces/face_down_red.png'),        // 红炮
  27: require('@/assets/pieces/face_down_red.png'),        // 红兵
  28: require('@/assets/pieces/face_down_red.png'),        // 红兵
  29: require('@/assets/pieces/face_down_red.png'),        // 红兵
  30: require('@/assets/pieces/face_down_red.png'),        // 红兵
  31: require('@/assets/pieces/face_down_red.png'),        // 红兵
};

/** 暗子背面图（揭棋）。非揭棋局面不应调用。 */
export function getFaceDownImage(pieceId: number): any {
  return FACE_DOWN_IMAGES[pieceId] || null;
}

/**
 * 揭棋渲染用图：暗子显示背面，明子显示正面。
 *
 * @param pieceId     盘面 id
 * @param isHidden    该子此刻是否背面朝上（GameState.hiddenMask[id]）
 *
 * ⚠️ 揭棋的 id **不因翻开而改变**（见 types.ts 的 hiddenMask 注释），
 * 而 id 恒等于「棋位棋种」。所以：
 * - **暗子**只能按 id 取图（此时取的是背面图，id 只用来区分黑/红）；
 * - **已翻开的子**必须按 `revealedType`（真实棋种）取图，
 *   **绝不能**回落到 `getPieceImage(pieceId)` —— 那会显示成该棋位的常规棋子，
 *   于是「翻开」看起来毫无变化，整个揭棋就退化成了一局普通象棋。
 *   这是揭棋渲染最容易写错的一处。
 */
export function getJieqiPieceImage(
  pieceId: number,
  isHidden: boolean,
  revealedType: JieqiPieceType | null | undefined,
  pieceSide: 'black' | 'red',
): any {
  if (isHidden) return getFaceDownImage(pieceId);

  // 已翻开：有真实棋种就按棋种取正面图
  if (revealedType) {
    const rep = representativeId(revealedType, pieceSide === 'black' ? BLACK_SIDE : RED_SIDE);
    if (rep !== null) return getPieceImage(rep);
    // representativeId 返回 null 说明该棋种在表里没有代表（理论上不可达），
    // 落到下面的兜底而不是返回 null —— 返回 null 会让棋子整个消失。
  }
  // 将/帅等本来就是明子（revealedType 为 null），按 id 取即可
  return getPieceImage(pieceId);
}

/**
 * 揭棋 · 棋种显示名（用于走子提示、气泡等文本）。
 *
 * 暗子**不能**给名字 —— 那等于直接公布身份。这里返回 null，
 * 由调用方决定显示什么（例如「暗子」）。
 */
export function getJieqiPieceName(
  pieceId: number,
  isHidden: boolean,
  revealedType: JieqiPieceType | null | undefined,
): string | null {
  if (isHidden) return null;
  if (revealedType) {
    const t = revealedType;
    const label = t === 'zu' ? '卒' : t === 'bing' ? '兵'
      : t === 'che' ? '车' : t === 'ma' ? '马' : t === 'pao' ? '炮'
      : t === 'shi' ? '士' : t === 'xiang' ? '象' : null;
    if (label) return label;
  }
  return PIECE_NAMES[pieceId] ?? null;
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
