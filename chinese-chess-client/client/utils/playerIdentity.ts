/**
 * 互联网对战玩家身份持久化
 *
 * - 玩家 ID：首次生成后持久化，全局唯一且固定（断线重连/重新进入大厅身份不变）
 * - 玩家昵称：首次生成默认昵称（用户XXXX）并持久化；用户修改后保存，
 *   再次进入大厅时回填，不会随页面重新打开而变化
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const KEY_PLAYER_ID = 'lan_player_id';
const KEY_PLAYER_NAME = 'lan_player_name';

// 内存缓存，避免重复读 AsyncStorage
let cachedId: string | null = null;
let cachedName: string | null = null;

// 【C-11 / §4.13】playerId 是服务端识别玩家的唯一凭据（服务端零认证，任何请求体里的
// playerId 都会被接受），所以它必须不可枚举。原来的 Math.random().toString(36) 只有
// 约 31 bit 熵、且非加密随机：同毫秒生成的两个 id 前缀相同，猜到 id 就能替对方
// 重连（POST /rooms/:id/reconnect 只校验 id 是否在房间里）来取消其断线判负倒计时。
// Crypto.randomUUID() 是 RFC4122 v4、122 bit 熵，Web 端与非安全上下文下都可用。
function secureSuffix(): string {
  try {
    return Crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  } catch {
    // 极端环境下（原生 crypto 未就绪）退回旧实现：可用性优先于不可枚举性
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }
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
    // 保留 player_ 前缀与时间戳（便于人工排查），随机段改为加密随机
    id = `player_${Date.now()}_${secureSuffix().toLowerCase()}`;
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
    // 昵称不是凭据，但同一函数共用随机源；改用同一个加密随机实现保持一致
    name = `用户${secureSuffix()}`;
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

/* ------------------------------------------------------------------ *
 * 房间会话凭证（【S-1 / §3.1】服务端接入 sessionToken 后的客户端侧）
 *
 * 创建/加入房间时服务端会签发一个 sessionToken（crypto.randomBytes(32)），
 * 之后所有**写操作**都必须带上它，playerId 退化为显示用标识。这里负责：
 *   1. 从创建/加入响应里接住 token 并持久化（key 含 roomId + playerId）；
 *   2. 提供同步读取（对局页首帧要立刻拼 WS URL，不能等异步存储）；
 *   3. 退出/房间消失时清理，避免 token 在本地无限堆积。
 *
 * 持久化是刻意的：App 被系统杀掉后重进对局页仍能凭旧 token 恢复席位，
 * 否则玩家会被判断线负或被迫重新加入房间。风险是设备被他人接触时可复用，
 * 这与改造前 playerId 直接当凭据相比已是数量级提升（256 bit vs 可枚举 id）。
 * ------------------------------------------------------------------ */

const KEY_SESSION_TOKEN_PREFIX = 'lan_session_token_';

// 同步缓存：key 与持久化 key 同构
const sessionTokens = new Map<string, string>();

function tokenKey(roomId: string, playerId: string): string {
  return `${KEY_SESSION_TOKEN_PREFIX}${roomId}__${playerId}`;
}

/** 保存某房间下本玩家的会话凭证（创建/加入成功、或幂等重入重新签发后调用） */
export async function setRoomSessionToken(roomId: string, playerId: string, token: string): Promise<void> {
  if (!roomId || !playerId || !token) return;
  sessionTokens.set(tokenKey(roomId, playerId), token);
  try {
    await AsyncStorage.setItem(tokenKey(roomId, playerId), token);
  } catch {
    // 写入失败时仅保留内存值（本次会话内仍可用）
  }
}

/**
 * 读取某房间下本玩家的会话凭证。
 * 先看内存缓存；缓存未命中时回落读存储（首屏冷启动用）。
 * 返回空串表示本地没有可用 token，调用方应按「需要重新加入房间」处理。
 */
export async function getRoomSessionToken(roomId: string, playerId: string): Promise<string> {
  if (!roomId || !playerId) return '';
  const key = tokenKey(roomId, playerId);
  const cached = sessionTokens.get(key);
  if (cached) return cached;
  let token: string | null = null;
  try {
    token = await AsyncStorage.getItem(key);
  } catch {
    // 读取失败时按无 token 处理
  }
  if (token) sessionTokens.set(key, token);
  return token ?? '';
}

/**
 * 同步读取缓存中的会话凭证（不触发存储读取）。
 * 用于「必须立刻拿到 token 拼请求头」的路径（如对局页首帧的 WS URL）；
 * 若返回空串，调用方应先 await getRoomSessionToken()。
 */
export function peekRoomSessionToken(roomId: string, playerId: string): string {
  if (!roomId || !playerId) return '';
  return sessionTokens.get(tokenKey(roomId, playerId)) ?? '';
}

/** 清除某房间下本玩家的会话凭证（离开房间、房间被销毁、或收到 403 后） */
export async function clearRoomSessionToken(roomId: string, playerId: string): Promise<void> {
  if (!roomId || !playerId) return;
  const key = tokenKey(roomId, playerId);
  sessionTokens.delete(key);
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // 清理失败只影响持久化，内存已清
  }
}
