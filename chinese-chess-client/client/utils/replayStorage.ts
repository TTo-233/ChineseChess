/**
 * 复盘（历史对局）本地存储
 *
 * - 人机对战 / 在线对局的已结算对局自动保存到 AsyncStorage
 * - 保存格式：时间戳 + 对局模式 + 步数 + 完整着法序列
 * - 支持收藏（收藏对局不会被批量删除）、按时间筛选、批量删除
 * - 容量上限 200 条：超出时优先淘汰最旧的未收藏对局
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MoveRecord } from '@/utils/chess/types';

const KEY_REPLAYS = 'replay_games_v1';
const MAX_REPLAYS = 200;

export type ReplayMode = 'pve' | 'lan';
export type ReplaySide = 'red' | 'black';

export interface ReplayGame {
  id: string; // 唯一 ID（时间戳 + 随机后缀）
  timestamp: number; // 对局结束时间戳（毫秒）
  mode: ReplayMode; // pve=人机对战，lan=在线对局
  moveCount: number; // 棋局步数
  moves: MoveRecord[]; // 完整着法序列（用于复盘重建局面）
  firstMoveSide: ReplaySide; // 先手方（重建初始局面用）
  winnerSide: ReplaySide | null; // 获胜方，null=和棋/未知
  mySide: ReplaySide; // 保存者执棋方（人机=玩家方，在线=本方）
  note: string; // 副标题：人机=难度，在线=对手名
  favorite: boolean; // 收藏标记（收藏对局不会被批量删除）
  handicap?: number[]; // 红方让出的棋子 id（在线对局可选让棋；重建初始局面用）
}

export type ReplayInput = Omit<ReplayGame, 'id' | 'favorite'>;

// 内存缓存，避免频繁读 AsyncStorage；写操作后同步更新
let cache: ReplayGame[] | null = null;

function randomSuffix(): string {
  return Math.random().toString(36).substring(2, 8);
}

async function readAll(): Promise<ReplayGame[]> {
  if (cache) return cache;
  let list: ReplayGame[] = [];
  try {
    const raw = await AsyncStorage.getItem(KEY_REPLAYS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed.filter(
          (g): g is ReplayGame =>
            !!g && typeof g.id === 'string' && Array.isArray(g.moves)
        );
      }
    }
  } catch {
    list = [];
  }
  // 统一按时间倒序
  list.sort((a, b) => b.timestamp - a.timestamp);
  cache = list;
  return list;
}

async function writeAll(list: ReplayGame[]): Promise<void> {
  list.sort((a, b) => b.timestamp - a.timestamp);
  cache = list;
  try {
    await AsyncStorage.setItem(KEY_REPLAYS, JSON.stringify(list));
  } catch {
    // 写入失败时仅保留内存值
  }
}

/** 列出全部复盘（按时间倒序） */
export async function listReplays(): Promise<ReplayGame[]> {
  return readAll();
}

/** 按 ID 获取单条复盘 */
export async function getReplay(id: string): Promise<ReplayGame | null> {
  const list = await readAll();
  return list.find(g => g.id === id) ?? null;
}

/** 保存一条已结算对局（自动保存入口；超出容量时淘汰最旧的未收藏对局） */
export async function saveReplay(input: ReplayInput): Promise<ReplayGame> {
  const list = await readAll();
  const game: ReplayGame = {
    ...input,
    id: `replay_${Date.now()}_${randomSuffix()}`,
    favorite: false,
  };
  list.unshift(game);

  // 容量控制：超过上限时，从最旧开始移除未收藏对局；收藏对局永不淘汰
  if (list.length > MAX_REPLAYS) {
    let excess = list.length - MAX_REPLAYS;
    for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
      if (!list[i].favorite) {
        list.splice(i, 1);
        excess--;
      }
    }
  }

  await writeAll(list);
  return game;
}

/** 切换收藏状态，返回最新状态（对局不存在时返回 null） */
export async function toggleFavorite(id: string): Promise<boolean | null> {
  const list = await readAll();
  const game = list.find(g => g.id === id);
  if (!game) return null;
  game.favorite = !game.favorite;
  await writeAll(list);
  return game.favorite;
}

/** 批量删除：收藏对局受保护，即使被选中也不会删除，返回实际删除数量 */
export async function deleteReplays(ids: string[]): Promise<number> {
  const idSet = new Set(ids);
  const list = await readAll();
  const remain = list.filter(g => g.favorite || !idSet.has(g.id));
  const deleted = list.length - remain.length;
  if (deleted > 0) {
    await writeAll(remain);
  }
  return deleted;
}
