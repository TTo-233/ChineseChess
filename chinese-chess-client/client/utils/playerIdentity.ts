/**
 * 互联网对战玩家身份持久化
 *
 * - 玩家 ID：首次生成后持久化，全局唯一且固定（断线重连/重新进入大厅身份不变）
 * - 玩家昵称：首次生成默认昵称（用户XXXX）并持久化；用户修改后保存，
 *   再次进入大厅时回填，不会随页面重新打开而变化
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PLAYER_ID = 'lan_player_id';
const KEY_PLAYER_NAME = 'lan_player_name';

// 内存缓存，避免重复读 AsyncStorage
let cachedId: string | null = null;
let cachedName: string | null = null;

function randomSuffix(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/** 获取持久化的玩家 ID（首次调用时生成并保存） */
export async function getPlayerId(): Promise<string> {
  if (cachedId) return cachedId;
  let id: string | null = null;
  try {
    id = await AsyncStorage.getItem(KEY_PLAYER_ID);
  } catch {
    // 读取失败时按未设置处理
  }
  if (!id) {
    id = `player_${Date.now()}_${randomSuffix().toLowerCase()}`;
    try {
      await AsyncStorage.setItem(KEY_PLAYER_ID, id);
    } catch {
      // 写入失败时仅保留内存值
    }
  }
  cachedId = id;
  return id;
}

/** 获取持久化的玩家昵称（首次调用时生成默认昵称"用户XXXX"并保存） */
export async function getPlayerName(): Promise<string> {
  if (cachedName) return cachedName;
  let name: string | null = null;
  try {
    name = await AsyncStorage.getItem(KEY_PLAYER_NAME);
  } catch {
    // 读取失败时按未设置处理
  }
  if (!name || !name.trim()) {
    name = `用户${randomSuffix()}`;
    try {
      await AsyncStorage.setItem(KEY_PLAYER_NAME, name);
    } catch {
      // 写入失败时仅保留内存值
    }
  }
  cachedName = name;
  return name;
}

/** 保存玩家昵称（去除首尾空白；空昵称忽略不保存） */
export async function savePlayerName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  cachedName = trimmed;
  try {
    await AsyncStorage.setItem(KEY_PLAYER_NAME, trimmed);
  } catch {
    // 写入失败时仅保留内存值
  }
}
