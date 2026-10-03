/**
 * 残局闯关进度与自定义残局存储
 * - 闯关进度：已通过的最高关卡（内置关按数组下标顺序解锁，必须从第 1 关开始）
 * - 局内存档：挑战中途保存，可继续（单槽位，与关卡 id 绑定）
 * - 自定义残局：用户导入的 FEN，识别校验后保存，不占用闯关序号
 *
 * ⚠️ 进度以**数组下标**存储，而内置关已按难度重排过一次；
 *    老存档里的下标会指向重排后的另一关，若需精确迁移请配合 endgames.ts 的 id 核对。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { BUILTIN_ENDGAMES, type EndgameLevel, type EndgameTier } from './chess/endgames';
import type { GameState } from './chess/GameEngine';
import { BOARD_COLS, BOARD_ROWS } from './chess/types';

const PROGRESS_KEY = 'endgame_progress';
const SAVE_KEY = 'endgame_battle_save';
const CUSTOM_KEY = 'endgame_custom_levels';

/** 闯关进度：内置关卡数组下标（0 基），highestUnlocked 表示当前可挑战的最高关 */
export interface EndgameProgressData {
  /** 已解锁的最高关（0 基下标，初始 0 = 仅第 1 关可玩） */
  highestUnlocked: number;
  /** 已通过的关卡下标列表 */
  completed: number[];
  /** 每关通过时使用的最少提示次数（key 为关卡下标字符串；0=金冠 1=银冠 ≥2=铜冠，旧版无记录按铜冠）。
   *  注：字段名沿用历史存储 key（原悔棋次数），现记录提示次数，保持既有通关进度兼容 */
  bestUndoUsed?: Record<string, number>;
  /** 自定义残局通过时使用的最少提示次数（key 为自定义关 id；评级规则同内置关） */
  customBestUndoUsed?: Record<string, number>;
}

/** 残局局内存档（挑战中途保存） */
export interface EndgameBattleSave {
  /** 内置关：数组下标；自定义关：-1 */
  levelIndex: number;
  /** 自定义关 id（内置关为空字符串） */
  customId: string;
  name: string;
  fen: string;
  gameState: GameState;
  moveCount: number;
  capturedRed: number;
  capturedBlack: number;
  lastMove: { fromCol: number; fromRow: number; toCol: number; toRow: number } | null;
  timestamp: number;
}

/** 自定义残局 */
export interface CustomEndgame {
  id: string;
  name: string;
  comment: string;
  fen: string;
  createdAt: number;
}

// ============ 闯关进度 ============

export async function loadProgress(): Promise<EndgameProgressData> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    if (raw) {
      const data = JSON.parse(raw) as EndgameProgressData;
      if (typeof data.highestUnlocked === 'number' && Array.isArray(data.completed)) {
        return {
          ...data,
          bestUndoUsed: data.bestUndoUsed ?? {},
          customBestUndoUsed: data.customBestUndoUsed ?? {},
        };
      }
    }
  } catch (e) {
    console.error('读取残局闯关进度失败:', e);
  }
  return { highestUnlocked: 0, completed: [], bestUndoUsed: {}, customBestUndoUsed: {} };
}

/** 标记关卡通过，并解锁下一关；hintUsed 为本局使用的提示次数（仅保留历史最佳/最少记录） */
export async function markLevelCompleted(levelIndex: number, hintUsed?: number): Promise<EndgameProgressData> {
  const progress = await loadProgress();
  if (!progress.completed.includes(levelIndex)) {
    progress.completed.push(levelIndex);
  }
  // 记录该关最佳（最少）提示次数，作为金/银/铜冠评定依据
  if (typeof hintUsed === 'number') {
    const key = String(levelIndex);
    const prev = progress.bestUndoUsed?.[key];
    if (prev === undefined || hintUsed < prev) {
      progress.bestUndoUsed = { ...(progress.bestUndoUsed ?? {}), [key]: hintUsed };
    }
  }
  const next = levelIndex + 1;
  if (next < BUILTIN_ENDGAMES.length && next > progress.highestUnlocked) {
    progress.highestUnlocked = next;
  }
  try {
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch (e) {
    console.error('保存残局闯关进度失败:', e);
  }
  return progress;
}

/** 皇冠评级：未通过返回 null；0 次提示=金冠，1 次=银冠，其余（含旧版无记录）=铜冠 */
export function getCrownTier(progress: EndgameProgressData, levelIndex: number): 'gold' | 'silver' | 'bronze' | null {
  if (!progress.completed.includes(levelIndex)) return null;
  const used = progress.bestUndoUsed?.[String(levelIndex)];
  if (used === 0) return 'gold';
  if (used === 1) return 'silver';
  return 'bronze';
}

/** 记录自定义残局通过（hintUsed 为本局使用的提示次数，仅保留历史最佳/最少记录） */
export async function markCustomCompleted(customId: string, hintUsed: number): Promise<EndgameProgressData> {
  const progress = await loadProgress();
  const prev = progress.customBestUndoUsed?.[customId];
  if (prev === undefined || hintUsed < prev) {
    progress.customBestUndoUsed = { ...(progress.customBestUndoUsed ?? {}), [customId]: hintUsed };
  }
  try {
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch (e) {
    console.error('保存自定义残局评级失败:', e);
  }
  return progress;
}

/** 自定义残局皇冠评级：无通过记录返回 null；规则同内置关（0=金 1=银 ≥2=铜） */
export function getCustomCrownTier(progress: EndgameProgressData, customId: string): 'gold' | 'silver' | 'bronze' | null {
  const used = progress.customBestUndoUsed?.[customId];
  if (used === undefined) return null;
  if (used === 0) return 'gold';
  if (used === 1) return 'silver';
  return 'bronze';
}

/** 某关是否可挑战（第 1 关始终可玩，其余需前一关已通过） */
export function isLevelUnlocked(levelIndex: number, progress: EndgameProgressData): boolean {
  return levelIndex <= progress.highestUnlocked;
}

// ============ 局内存档 ============

export async function saveEndgameBattle(save: EndgameBattleSave): Promise<void> {
  try {
    await AsyncStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch (e) {
    console.error('保存残局存档失败:', e);
  }
}

export async function loadEndgameBattle(): Promise<EndgameBattleSave | null> {
  try {
    const raw = await AsyncStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as EndgameBattleSave;
    // 基本完整性校验：无对应关卡数据的存档视为无效
    if (data.levelIndex >= 0 && !BUILTIN_ENDGAMES[data.levelIndex]) return null;
    if (!data.gameState) return null;
    // 局面结构校验：防止损坏存档加载后崩溃（棋子数组必须为 32 项且含必要字段）
    // 活子的坐标还必须在棋盘内 —— -1 坐标的「活子」会被搜索引擎拿去索引定长查表，
    // 直接抛 `TypeError: Cannot read properties of undefined (reading '-1')`（2026-10 红屏教训）。
    const pieces = data.gameState.pieces;
    if (!Array.isArray(pieces) || pieces.length !== 32 ||
        !pieces.every(p => p && typeof p.id === 'number' && typeof p.col === 'number' &&
                           typeof p.row === 'number' && typeof p.alive === 'boolean' &&
                           (!p.alive || (p.col >= 0 && p.col < BOARD_COLS && p.row >= 0 && p.row < BOARD_ROWS)))) {
      console.warn('残局存档局面结构校验失败，已清除损坏存档');
      await AsyncStorage.removeItem(SAVE_KEY);
      return null;
    }
    return data;
  } catch (e) {
    console.error('读取残局存档失败:', e);
    return null;
  }
}

export async function deleteEndgameBattle(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SAVE_KEY);
  } catch (e) {
    console.error('删除残局存档失败:', e);
  }
}

// ============ 自定义残局 ============

export async function loadCustomEndgames(): Promise<CustomEndgame[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_KEY);
    if (raw) {
      const list = JSON.parse(raw) as CustomEndgame[];
      if (Array.isArray(list)) return list;
    }
  } catch (e) {
    console.error('读取自定义残局失败:', e);
  }
  return [];
}

export async function addCustomEndgame(item: Omit<CustomEndgame, 'id' | 'createdAt'>): Promise<CustomEndgame> {
  const list = await loadCustomEndgames();
  const entry: CustomEndgame = {
    ...item,
    id: `custom_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
    createdAt: Date.now(),
  };
  list.push(entry);
  try {
    await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('保存自定义残局失败:', e);
  }
  return entry;
}

/** 更新自定义残局（棋盘再编辑后保存：保留原 id 与创建时间，更新名称/说明/局面） */
export async function updateCustomEndgame(id: string, updates: { name: string; comment: string; fen: string }): Promise<boolean> {
  const list = await loadCustomEndgames();
  const idx = list.findIndex(it => it.id === id);
  if (idx === -1) return false;
  list[idx] = { ...list[idx], ...updates };
  try {
    await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('更新自定义残局失败:', e);
    return false;
  }
  return true;
}

// 摆棋保存完成后返回选关页时，自动聚焦「自定义」标签的一次性标记
// （跨页面轻量信号：编辑器保存后置位，选关页聚焦刷新时消费并切换标签）
let pendingFocusCustomTab = false;

export function markPendingFocusCustomTab(): void {
  pendingFocusCustomTab = true;
}

export function consumePendingFocusCustomTab(): boolean {
  const pending = pendingFocusCustomTab;
  pendingFocusCustomTab = false;
  return pending;
}

export async function deleteCustomEndgame(id: string): Promise<void> {
  const list = await loadCustomEndgames();
  const next = list.filter(it => it.id !== id);
  try {
    await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch (e) {
    console.error('删除自定义残局失败:', e);
  }
  // 同步清理该关的皇冠评级记录，避免残留无效数据
  try {
    const progress = await loadProgress();
    if (progress.customBestUndoUsed && id in progress.customBestUndoUsed) {
      const rest = { ...progress.customBestUndoUsed };
      delete rest[id];
      progress.customBestUndoUsed = rest;
      await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    }
  } catch (e) {
    console.error('清理自定义残局评级失败:', e);
  }
}

/** 传给对局页的残局参数（JSON 序列化后经路由传递） */
export interface EndgameLaunchParams {
  /** 内置关：数组下标；自定义关：-1 */
  levelIndex: number;
  /** 自定义关 id（内置关为空字符串） */
  customId: string;
  name: string;
  comment: string;
  fen: string;
  /** 内置关难度分档（自定义关为空） */
  tier?: EndgameTier;
  /** 继续局内存档 */
  continueBattle?: boolean;
}

export function builtinLevelToLaunch(levelIndex: number, level: EndgameLevel, continueBattle = false): EndgameLaunchParams {
  return {
    levelIndex,
    customId: '',
    name: level.name,
    comment: level.comment,
    fen: level.fen,
    tier: level.tier,
    continueBattle,
  };
}
