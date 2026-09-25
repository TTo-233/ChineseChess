/**
 * 游戏存档管理
 * 使用 AsyncStorage 保存和加载游戏状态
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GameState } from './chess/GameEngine';

const SAVE_KEY = 'chess_game_save';

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
  }
  if (typeof gs.sideTag !== 'boolean') return false;
  if (!Array.isArray(gs.moveHistory)) return false;
  if (s.playerSide !== 'red' && s.playerSide !== 'black') return false;
  return true;
}

/**
 * 保存游戏状态
 */
export async function saveGame(save: GameSave): Promise<void> {
  try {
    const json = JSON.stringify(save);
    await AsyncStorage.setItem(SAVE_KEY, json);
  } catch (error) {
    console.error('保存游戏失败:', error);
  }
}

/**
 * 加载游戏状态
 */
export async function loadGame(): Promise<GameSave | null> {
  try {
    const json = await AsyncStorage.getItem(SAVE_KEY);
    if (json) {
      const parsed = JSON.parse(json) as unknown;
      if (isValidGameSave(parsed)) {
        return parsed;
      }
      // 结构不完整（版本迁移/数据损坏）→ 清除坏档，避免加载后崩溃
      console.warn('存档结构校验失败，已清除损坏存档');
      await AsyncStorage.removeItem(SAVE_KEY);
    }
    return null;
  } catch (error) {
    console.error('加载游戏失败:', error);
    return null;
  }
}

/**
 * 删除游戏存档
 */
export async function deleteSave(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SAVE_KEY);
  } catch (error) {
    console.error('删除存档失败:', error);
  }
}

/**
 * 检查是否有存档
 */
export async function hasSave(): Promise<boolean> {
  try {
    const json = await AsyncStorage.getItem(SAVE_KEY);
    return json !== null;
  } catch (error) {
    return false;
  }
}
