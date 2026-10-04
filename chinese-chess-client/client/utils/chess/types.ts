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

// 棋子运行时状态
export interface PieceState {
  id: number;
  col: number;
  row: number;
  alive: boolean;
}

// ---------------------------------------------------------------------------
// 长将长捉规则状态类型（定义于 types 以避免 GameEngine <-> RuleEngine 循环依赖，
// 实现见 utils/chess/RuleEngine.ts，规则见《象棋长将长捉规则开发方案》）
// ---------------------------------------------------------------------------
export type BanReason = 'LONG_CHECK' | 'LONG_CHASE' | 'CHECK_CHASE';

export interface BanMove {
  pieceId: number;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  reason: BanReason;
}

/** 单方计数器（按方维护以支持互相长将/长捉判和） */
export interface SideRuleCounters {
  /** 该方连续将军着数 */
  jiangCount: number;
  /** 参与连续将军的棋子（去重），用于确定阈值档位（1/2/3+ 子） */
  jiangPieceIds: number[];
  /** 该方连续捉对方各子的次数（key=被捉子 pieceId，字符串以兼容 JSON 序列化） */
  zhuoCounts: Record<string, number>;
  /** 该方连续将/捉着法数（将捉交替循环） */
  jiangZhuoLoop: number;
  /** 参与将捉交替的棋子（去重） */
  jiangZhuoPieceIds: number[];
  /** 该方连续将军期间对方是否还过将（二将一还检测） */
  opponentCheckedDuringRun: boolean;
  /** 自然限招窗口内本方累计将军着数（规则一.5：双方各自最多累计 10 次将军） */
  checkCountInWindow: number;
}

export interface RuleState {
  red: SideRuleCounters;
  black: SideRuleCounters;
  /** 历史局面指纹（含初始局面，走完每步 push），用于非将非捉重复判和 */
  positionKeys: string[];
  /** 自最后一次吃子起双方累计着数（自然限招） */
  naturalMoveCounter: number;
  /** 禁着是否激活（娱乐向改造：仅表示「存在超限红点警示」，不再拦截落子、不判负） */
  banActive: boolean;
  /** 被标红方（下一手会继续长将/长捉的一方） */
  banSide: SideTag | null;
  banReason: BanReason | null;
  /** 长捉禁着的目标子（触发阈值时被连续捉的子） */
  banChaseTargets: number[];
  /** 禁着列表（仅对 banSide 的下一手有效，随状态下发；仅用于棋盘标红，不拦截落子） */
  banMoves: BanMove[];
  /** 本步产生的提示文案（接近阈值/达到阈值） */
  notice: string | null;
  /** 提示去重键（如 'red-jiang-5'），UI 据此避免重复弹出 */
  noticeKey: string | null;
}

// 游戏状态
export interface GameState {
  qiPan: number[][]; // 9x10, -1 表示空位
  pieces: PieceState[]; // 32 个棋子状态
  sideTag: SideTag; // 当前走棋方
  moveHistory: MoveRecord[];
  gameStatus: GameStatus;
  isCheck: boolean; // 当前是否被将军
  checkMessage: string;
  zobristHash: number; // Zobrist 哈希值（用于重复局面检测）
  /** 长将长捉规则状态（计数器/禁着列表），随状态序列化；makeMove 首步惰性初始化 */
  ruleState?: RuleState;
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
