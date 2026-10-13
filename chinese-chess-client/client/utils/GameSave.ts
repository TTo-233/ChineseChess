/**
 * 游戏存档管理
 * 使用 AsyncStorage 保存和加载游戏状态
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GameState } from './chess/GameEngine';
import { BOARD_COLS, BOARD_ROWS } from './chess/types';
import type { JieqiPieceType } from './chess/types';

/** 揭棋的全部棋种（与 chess/jieqi.ts 的 ALL_TYPES 同一集合，供存档校验用） */
const JIEQI_PIECE_TYPES: readonly JieqiPieceType[] = ['che', 'ma', 'pao', 'shi', 'xiang', 'zu', 'bing'];

const SAVE_KEY = 'chess_game_save';

/**
 * 揭棋存档的独立键（2026-10 与人机对战拆开）。
 * 见 saveJieqiGame 上方注释：拆开是为了两个玩法的续局互不覆盖。
 */
const JIEQI_SAVE_KEY = 'chess_jieqi_save';

/**
 * 揭棋存档里随盘落盘的**暗子身份表**（2026-10 支持续局）。
 *
 * 为什么单独存一份而不是塞进 GameState：
 * 铁律 A 要求「暗子的真实身份永不挂在 GameState 上」，以免它随任何
 * 面向 AI / 展示 / 调试的 payload 泄漏出去。续局因此必须在存档层
 * （AsyncStorage 的私有空间）显式携带它，而不能借 GameState 过河。
 *
 * 体积很小：32 格的棋种短字符串 + 一个整数，几十字节。
 *
 * 已翻开的那部分**不在这里**：翻开后的真实身份写在 `gameState.revealedType`
 * 里（本来就是明子，属于公开信息），随 gameState 一起存即可。
 * 这里只需要「还没翻开的那些」的真相。
 */
export interface JieqiSaveIdentity {
  /** 下标 = 暗子占位 id，值 = 真实棋种（null = 该格无暗子/已翻开/已被吃） */
  hiddenType: (JieqiPieceType | null)[];
  /** 初始洗牌种子（保留以备将来按 seed 重放；当前不参与还原） */
  seed: number;
}

export interface GameSave {
  gameState: GameState;
  difficulty: string;
  playerSide: 'red' | 'black';
  firstMover: 'player' | 'ai'; // 先手方：玩家 or AI（旧存档无此字段，加载时按旧规则推断）
  moveCount: number;
  capturedRed: number;
  capturedBlack: number;
  lastMove: {
    fromCol: number;
    fromRow: number;
    toCol: number;
    toRow: number;
  } | null;
  isFlipped: boolean;
  timestamp: number;
  /**
   * 揭棋身份表；象棋存档为 undefined。
   *
   * 判别「这是不是一局揭棋」一律读 `gameState.variant === 'jieqi'`，
   * 不要反过来用本字段的有无来判断——旧版本存下的揭棋局没有本字段
   * （那时根本不支持续局），那种档必须按"缺身份表"处理而不是当象棋读。
   */
  jieqiIdentity?: JieqiSaveIdentity;
}

/** 揭棋盘面恒为 32 个占位 id（与 chess/types 的 PIECE_COUNT 同源语义） */
const JIEQI_SLOT_COUNT = 32;

/**
 * 校验随存档携带的揭棋身份表结构。
 *
 * 拒绝而不是"尽力修复"的理由与 isValidGameSave 同源：坏档一旦被原样
 * 交给 makeMove，读到的 hiddenType[id] 会是 undefined，翻开时算出
 * `revealedType = null`——暗子被当成翻不出身份的废子，属于静默错局，
 * 比直接丢弃存档更难排查。故只接受「长度 32 + 每项是合法棋种或 null」。
 */
function isValidJieqiIdentity(value: unknown): value is JieqiSaveIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<JieqiSaveIdentity>;
  if (!Array.isArray(v.hiddenType) || v.hiddenType.length !== JIEQI_SLOT_COUNT) return false;
  for (const t of v.hiddenType) {
    if (t === null) continue;
    if (typeof t !== 'string') return false;
    if (!(JIEQI_PIECE_TYPES as readonly string[]).includes(t)) return false;
  }
  if (typeof v.seed !== 'number' || !Number.isFinite(v.seed)) return false;
  return true;
}

/**
 * 读取存档的先后手信息（兼容旧存档：旧版红方=玩家先手、黑方=AI先手）
 */
export function resolveFirstMover(save: GameSave): 'player' | 'ai' {
  if (save.firstMover === 'player' || save.firstMover === 'ai') {
    return save.firstMover;
  }
  return save.playerSide === 'red' ? 'player' : 'ai';
}

/**
 * 校验存档结构完整性：防止历史版本/损坏的存档在加载后引发崩溃。
 * 仅校验运行时必需的最小字段集。
 *
 * ⚠️ 坐标必须**同时**通过范围与「alive ⇔ 在盘」两道检查（2026-10 红屏教训）：
 * 引擎里 -1 既表示「该子不存在」也表示「被吃掉了」，任何拿 col/row 去索引定长查表
 * （ZOBRIST_TABLE / 位置加成表 / qiPan）的代码都可能读到 `table[-1][-1]` →
 * `TypeError: Cannot read properties of undefined (reading '-1')`。
 * 仅做 typeof 校验时，一个 alive=true 却带 -1 坐标的坏子会被原样交给搜索而当场崩掉页面。
 */
function isValidGameSave(save: unknown): save is GameSave {
  if (!save || typeof save !== 'object') return false;
  const s = save as Partial<GameSave>;
  const gs = s.gameState as Partial<GameState> | undefined;
  if (!gs || typeof gs !== 'object') return false;
  if (!Array.isArray(gs.pieces) || gs.pieces.length !== 32) return false;
  for (const p of gs.pieces) {
    if (!p || typeof p !== 'object') return false;
    if (typeof p.id !== 'number' || typeof p.col !== 'number' || typeof p.row !== 'number') return false;
    if (typeof p.alive !== 'boolean') return false;
    // 活子的坐标必须真的在棋盘内（缺席子/被吃子允许 -1）
    if (p.alive && (p.col < 0 || p.col >= BOARD_COLS || p.row < 0 || p.row >= BOARD_ROWS)) return false;
  }
  if (typeof gs.sideTag !== 'boolean') return false;
  if (!Array.isArray(gs.moveHistory)) return false;
  if (s.playerSide !== 'red' && s.playerSide !== 'black') return false;
  /**
   * 【2026-10 审计 D3】`revealedType` 也要校验，理由与上面 pieces 的坐标检查同源：
   * 它是**读档即可注入**的字符串数组，一旦出现 7 个合法棋种之外的值，
   * 揭棋的 `representativeId` 查不到 id，`RuleEngine.motionArgs` 取 `.length`
   * 当场抛 `TypeError` —— 崩溃点在 `detectZhuo` → `makeMove`，也就是
   * 「续局后点任何子就崩」，且坏档会一直崩到用户手动删存档。
   *
   * 之前只校验了 `jieqiIdentity.hiddenType`（见 isValidJieqiIdentity），
   * 漏了这份**同样来自落盘**的身份表 —— 两处同源数据必须同口径校验。
   *
   * 缺失（象棋档 / 2026-10 之前的旧揭棋档）不算损坏，与 hiddenType 同处理。
   */
  if (gs.revealedType !== undefined && !isValidRevealedTypeTable(gs.revealedType)) return false;
  if (gs.hiddenMask !== undefined && !isValidBooleanTable(gs.hiddenMask, 32)) return false;
  // 带了的身份表必须是合法的；缺字段（象棋档 / 旧版揭棋档）不算损坏，见 isValidJieqiIdentity 注释
  if (s.jieqiIdentity !== undefined && !isValidJieqiIdentity(s.jieqiIdentity)) return false;
  return true;
}

/** 布尔表形状校验（hiddenMask / 旧字段的兼容闸） */
function isValidBooleanTable(v: unknown, len: number): boolean {
  if (!Array.isArray(v) || v.length !== len) return false;
  return v.every((x) => typeof x === 'boolean');
}

/**
 * `revealedType` 表校验：长度 32，每项必须为 null 或 7 个合法棋种之一。
 *
 * 与 hiddenType 的区别：revealedType 允许 null（未翻开），且**允许全部为 null**
 * （旧档可能没有该字段回填）。这里只查「形状与取值域」，不查与 hiddenMask 的
 * 交叉一致性 —— 那属于局面语义，读档时按 `hiddenMask` 为准更稳妥。
 */
function isValidRevealedTypeTable(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== JIEQI_SLOT_COUNT) return false;
  for (const t of v) {
    if (t === null) continue;
    if (!(JIEQI_PIECE_TYPES as readonly string[]).includes(t as string)) return false;
  }
  return true;
}

/**
 * 这份存档能否作为「揭棋续局」载入。
 *
 * 判据是**两个条件同时成立**：盘面确实是揭棋，且身份表齐全。
 * 缺身份表的揭棋档（2026-10 之前存下的，或数据损坏的）一律判为不可续——
 * 载进去会得到一局「暗子身份全丢」的假棋局：那盘棋根本不是玩家当初下的那盘，
 * 比不续更糟（玩家会以为引擎算错了）。调用方据此提示玩家重新开一局。
 */
export function canResumeJieqi(save: GameSave): boolean {
  return save.gameState.variant === 'jieqi' && isValidJieqiIdentity(save.jieqiIdentity);
}

/**
 * 保存游戏状态
 */
export async function saveGame(save: GameSave): Promise<void> {
  await writeSave(SAVE_KEY, save);
}

/**
 * 加载游戏状态
 */
export async function loadGame(): Promise<GameSave | null> {
  return readSave(SAVE_KEY);
}

/**
 * 删除游戏存档
 */
export async function deleteSave(): Promise<void> {
  await removeSave(SAVE_KEY);
}

// ---------------------------------------------------------------------------
// 揭棋存档（独立键，2026-10）
// ---------------------------------------------------------------------------

/**
 * 揭棋存档单独占一个键，不再与人机对战共用。
 *
 * 为什么拆：两个玩法各自的「上次棋局」互不相干，共用一个键意味着
 * 在象棋里存一局就把揭棋那局冲掉、反之亦然——玩家会发现另一个入口的
 * 续局卡片莫名消失。拆开后两边可同时各存一局，互不干扰。
 *
 * 代价：2026-10 之前存下的揭棋档躺在旧键（chess_game_save）里读不到了。
 * 那批档本来**也续不了**（旧版没存身份表，见 canResumeJieqi），
 * 所以不写迁移逻辑：与其搬一局注定续不了的残局，不如让玩家重开一局。
 */

/** 保存揭棋存档 */
export async function saveJieqiGame(save: GameSave): Promise<void> {
  await writeSave(JIEQI_SAVE_KEY, save);
}

/** 加载揭棋存档 */
export async function loadJieqiGame(): Promise<GameSave | null> {
  return readSave(JIEQI_SAVE_KEY);
}

/** 删除揭棋存档 */
export async function deleteJieqiSave(): Promise<void> {
  await removeSave(JIEQI_SAVE_KEY);
}

/** 是否存在揭棋存档 */
export async function hasJieqiSave(): Promise<boolean> {
  return existsSave(JIEQI_SAVE_KEY);
}

// ---------------------------------------------------------------------------
// 按 key 参数化的底层实现（两组公开 API 共用，避免两套逻辑漂移）
// ---------------------------------------------------------------------------

async function writeSave(key: string, save: GameSave): Promise<void> {
  try {
    const json = JSON.stringify(save);
    await AsyncStorage.setItem(key, json);
  } catch (error) {
    console.error('保存游戏失败:', error);
  }
}

async function readSave(key: string): Promise<GameSave | null> {
  try {
    const json = await AsyncStorage.getItem(key);
    if (json) {
      const parsed = JSON.parse(json) as unknown;
      if (isValidGameSave(parsed)) {
        return parsed;
      }
      // 结构不完整（版本迁移/数据损坏）→ 清除坏档，避免加载后崩溃
      console.warn('存档结构校验失败，已清除损坏存档');
      await AsyncStorage.removeItem(key);
    }
    return null;
  } catch (error) {
    console.error('加载游戏失败:', error);
    return null;
  }
}

async function removeSave(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (error) {
    console.error('删除存档失败:', error);
  }
}

async function existsSave(key: string): Promise<boolean> {
  try {
    const json = await AsyncStorage.getItem(key);
    return json !== null;
  } catch (error) {
    return false;
  }
}

/**
 * 检查是否有存档
 */
export async function hasSave(): Promise<boolean> {
  return existsSave(SAVE_KEY);
}
