/**
 * 音效管理器
 *
 * 架构说明：本文件恢复自 9 月 9 日晚（提交 67c8022「音效预加载缓存」）的稳定版本。
 * 该版本在真机上音效播放正常，核心特征：
 * 1. 使用 expo-av（Audio.Sound），而非后续引入问题的 expo-audio
 * 2. Sound 对象缓存复用，避免每次播放重新创建
 * 3. 支持预加载常用音效，消除首次播放延迟
 * 4. Audio.setAudioModeAsync 仅在初始化时调用一次（持久音频会话）
 * 5. 播放采用 setPositionAsync(0) + playAsync() 从头播放
 *
 * 在保留原架构的前提下做了两处兼容性增强（不改变播放机制）：
 * - SOUND_FILES 保留当前全部音效（含 select/goerror/alarm/Woman_jiangjun）
 * - 将军音效指向响度已对齐吃子音效的 .wav 文件（原 .mp3 响度过低）
 * - 补充 playJiangJunSound（含节流），供各对局页面调用
 */

import { Audio } from 'expo-av';

const SOUND_FILES: Record<string, any> = {
  select: require('@/assets/sounds/select.mp3'),
  go: require('@/assets/sounds/go.mp3'),
  eat: require('@/assets/sounds/eat.mp3'),
  goerror: require('@/assets/sounds/goerror.mp3'),
  gamewin: require('@/assets/sounds/gamewin.mp3'),
  gamelose: require('@/assets/sounds/gamelose.mp3'),
  alarm: require('@/assets/sounds/alarm.mp3'),
  // 将军音效：响度已放大对齐吃子音效（原 .mp3 保留，播放使用放大后的 .wav）
  Man_jiangjun: require('@/assets/sounds/Man_jiangjun.wav'),
  Woman_jiangjun: require('@/assets/sounds/Woman_jiangjun.wav'),
};

// 常用音效（进入对局时预加载）
const ESSENTIAL_SOUNDS = ['select', 'go', 'eat', 'Man_jiangjun'];

// Sound 对象缓存
const soundCache = new Map<string, Audio.Sound>();
// 正在加载中的 Promise 缓存（防止重复加载）
const loadingCache = new Map<string, Promise<Audio.Sound | null>>();

let audioModeInitialized = false;

async function ensureAudioMode(): Promise<void> {
  if (audioModeInitialized) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
    audioModeInitialized = true;
  } catch {
    // 忽略音频模式设置失败
  }
}

async function getOrLoadSound(name: string): Promise<Audio.Sound | null> {
  // 已缓存则直接返回
  const cached = soundCache.get(name);
  if (cached) return cached;

  // 正在加载中则等待同一个 Promise
  const loading = loadingCache.get(name);
  if (loading) return loading;

  const source = SOUND_FILES[name];
  if (!source) return null;

  const loadPromise = (async () => {
    try {
      const { sound } = await Audio.Sound.createAsync(source, {
        shouldPlay: false,
        volume: 1.0,
      });
      soundCache.set(name, sound);
      loadingCache.delete(name);
      return sound;
    } catch {
      loadingCache.delete(name);
      return null;
    }
  })();

  loadingCache.set(name, loadPromise);
  return loadPromise;
}

/**
 * 预加载常用音效（在进入对局界面时调用）
 */
export async function preloadSounds(): Promise<void> {
  await ensureAudioMode();
  const promises = ESSENTIAL_SOUNDS.map((name) => getOrLoadSound(name));
  await Promise.all(promises);
}

/**
 * 预加载游戏结束音效（对局进行中后台加载）
 */
export async function preloadGameEndSounds(): Promise<void> {
  await ensureAudioMode();
  await Promise.all([
    getOrLoadSound('gamewin'),
    getOrLoadSound('gamelose'),
  ]);
}

export async function playSound(name: string): Promise<void> {
  try {
    await ensureAudioMode();
    const sound = await getOrLoadSound(name);
    if (sound) {
      await sound.setPositionAsync(0);
      await sound.playAsync();
    }
  } catch {
    // 静默失败，不影响游戏流程
  }
}

// 将军语音节流：模块级时间戳（SoundManager 为全局单例，人机/残局/联机对局共享同一节流基线）
let lastJiangJunAt = 0;
// 连续将军时语音最小间隔：正常对局每步间隔均大于此值（每步都报"将军"）；
// 仅 AI 秒回/快速连将等极端场景跳过，避免语音自叠混音
const JIANGJUN_MIN_INTERVAL_MS = 1800;

/**
 * 播放男声"将军"语音（内置节流）
 * 距上次播放不足 1.8 秒时静默跳过，避免语音自叠混音
 */
export async function playJiangJunSound(): Promise<void> {
  const now = Date.now();
  if (now - lastJiangJunAt < JIANGJUN_MIN_INTERVAL_MS) return;
  lastJiangJunAt = now;
  await playSound('Man_jiangjun');
}

/**
 * 释放所有音效资源（可在退出对局时调用）
 */
export async function unloadAllSounds(): Promise<void> {
  const promises: Promise<unknown>[] = [];
  for (const [, sound] of soundCache) {
    promises.push(
      sound.unloadAsync().catch(() => { /* 忽略卸载失败 */ })
    );
  }
  soundCache.clear();
  await Promise.all(promises);
}

export async function stopSound(): Promise<void> {
  // 停止所有正在播放的音效
  const promises: Promise<unknown>[] = [];
  for (const [, sound] of soundCache) {
    promises.push(
      sound.stopAsync().catch(() => { /* 忽略停止失败 */ })
    );
  }
  await Promise.all(promises);
}

export async function unloadSound(): Promise<void> {
  // 兼容旧接口：仅停止当前播放，不卸载缓存
  await stopSound();
}
