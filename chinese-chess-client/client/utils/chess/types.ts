/**
 * 中国象棋核心类型定义
 * 移植自 C# WPF 象棋项目
 */

// 棋子编号常量
// 黑方: 0-15, 红方: 16-31
export const BLACK_SIDE = false;
export const RED_SIDE = true;

export type SideTag = typeof BLACK_SIDE | typeof RED_SIDE;

// 棋子编号对应的图片文件名
export const QIZI_IMAGE_NAMES: string[] = [
  '黑将', '黑士', '黑士', '黑象', '黑象', '黑马', '黑马', '黑车', '黑车', '黑炮', '黑炮', '黑卒', '黑卒', '黑卒', '黑卒', '黑卒',
  '红帅', '红仕', '红仕', '红相', '红相', '红马', '红马', '红车', '红车', '红炮', '红炮', '红兵', '红兵', '红兵', '红兵', '红兵',
];

// 棋子中文简称
export const QIZI_CN_NAMES: string[] = [
  '将', '士', '士', '象', '象', '马', '马', '车', '车', '炮', '炮', '卒', '卒', '卒', '卒', '卒',
  '帅', '仕', '仕', '相', '相', '马', '马', '车', '车', '炮', '炮', '兵', '兵', '兵', '兵', '兵',
];

// 棋子初始位置 [col, row]，32个棋子
export const QIZI_INIT_POSITION: number[][] = [
  [4, 0], [3, 0], [5, 0], [2, 0], [6, 0], [1, 0], [7, 0], [0, 0], [8, 0],
  [1, 2], [7, 2],
  [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
  [4, 9], [3, 9], [5, 9], [2, 9], [6, 9], [1, 9], [7, 9], [0, 9], [8, 9],
  [1, 7], [7, 7],
  [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
];

// 中文数字
export const CN_NUMBERS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 棋盘尺寸
export const BOARD_COLS = 9;
export const BOARD_ROWS = 10;

// 棋子类型（用于require静态引入）
export interface PieceInfo {
  id: number;
  col: number;
  row: number;
  alive: boolean;
  side: SideTag;
  name: string;
  imageName: string;
}

// 走棋记录
export interface MoveRecord {
  pieceId: number;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  capturedPieceId: number; // -1 表示没有吃子
}

// 游戏状态
export type GameStatus = 'playing' | 'red_win' | 'black_win' | 'draw';

// AI 难度
export type AIDifficulty = 'easy' | 'medium' | 'hard';

// FEN 字符串对应的棋子名称
export const FEN_CHARS = [
  'k', 'a', 'a', 'b', 'b', 'n', 'n', 'r', 'r', 'c', 'c', 'p', 'p', 'p', 'p', 'p',
  'K', 'A', 'A', 'B', 'B', 'N', 'N', 'R', 'R', 'C', 'C', 'P', 'P', 'P', 'P', 'P',
];
