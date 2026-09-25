/**
 * 音效管理器
 *
 * ---------------------------------------------------------------------------
 * 2026-09 走棋音偶发丢失问题：根因分析与修复（依据 expo-av 16.0.8 原生源码
 * 逐行核查得出，非主观推断）：
 *
 * 旧实现 playSound = setPositionAsync(0) + playAsync() 两次独立原生调用，
 * 且 catch{} 静默吞掉一切错误。真机上存在多条可观测的瞬态失败路径：
 *
 * Android（AVManager.java / PlayerData.java / SimpleExoPlayerData.java）：
 * 1. 每次 setStatus 结束都会执行 abandonAudioFocusIfUnused()——某音效首次播放时
 *    mShouldPlay=false，setPositionAsync 走暂停分支后无任何播放器占用音频焦点，
 *    焦点被放弃；紧随的 playAsync 必须重新向系统申请焦点。
 * 2. playAsync → acquireAudioFocus()：只要 AudioManager.requestAudioFocus(
 *    GAIN_TRANSIENT_MAY_DUCK) 未返回 GRANTED 即抛 AudioFocusNotAcquiredException，
 *    Promise 拒绝 → 被 catch{} 静默吞掉 → 无声跳过（对应"首步"概率性失败）。
 * 3. mAcquiredAudioFocus=false 期间 getVolumeForDuckAndFocus() 恒返回 0——
 *    焦点恰在播放瞬间丢失时，声音以 0 音量"播放"（听感等于没播）。
 *
 * iOS（EXAVPlayerData.m / EXAV.m）：
 * 1. playAsync → promoteAudioSessionIfNecessary → [AVAudioSession setActive:YES]，
 *    会话激活瞬态失败即以 E_AV_PLAY 拒绝 Promise → 同样被吞掉。
 * 2. setPositionAsync 不携带 seek 容差（AV.js PlaybackMixin），
 *    位置已为 0 时 mustSeek=false、否则使用无限容差，回零不精确。
 *
 * 修复策略（保留 Sound 对象缓存复用 + 预加载的整体架构）：
 * 1. 改用 replayAsync()：单次原生调用原子完成"回零+播放"
 *    （Android 合并为一次 setStatus，无两次调用间的焦点状态空窗；
 *    iOS 走专用 replayWithStatus 路径，正确处理 AVQueuePlayer 条目轮换；
 *    Web 端 replaySound 同样映射为一次 setStatusForMedia）。
 * 2. 失败重试一次（120ms 退避，覆盖音频焦点/会话的瞬态拒绝）。
 * 3. 仍失败则卸载重建 Sound 对象后最后尝试一次（恢复原生播放器异常状态）；
 *    重建前校验会话代号，避免与退出对局时的 unloadAllSounds 竞争。
 * 4. 同名音效播放串行化，杜绝并发原生调用交错。
 * 5. 所有失败路径 console.warn 输出（不再静默），便于 adb logcat / Xcode 排查。
 * ---------------------------------------------------------------------------
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
// 同名音效播放串行链：后到的播放等待先前的完成，避免原生调用交错
const playQueues = new Map<string, Promise<void>>();

// 会话代号：unloadAllSounds 时自增。用于丢弃"已退出对局"后的过期播放请求，
// 防止其重建音效对象（那会在退出对局后泄漏一个已加载的原生播放器）。
let soundSessionId = 0;

let audioModeInitialized = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ensureAudioMode(): Promise<void> {
  if (audioModeInitialized) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
    audioModeInitialized = true;
  } catch (e) {
    // 音频模式设置失败不应阻断播放（下次播放时会再次尝试）
    console.warn('[SoundManager] setAudioModeAsync 失败，将在下次播放时重试:', e);
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
    } catch (e) {
      console.warn(`[SoundManager] 加载音效 '${name}' 失败:`, e);
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

/**
 * 原子重放并带回退恢复（核心播放路径）：
 * 1. replayAsync 单次原生调用完成"回零+播放"
 * 2. 失败（音频焦点/音频会话瞬态拒绝等）→ 120ms 后重试一次
 * 3. 仍失败 → 卸载重建 Sound 对象后最后尝试一次（恢复原生播放器异常状态）
 * 本函数不抛出异常：任何失败都以 console.warn 记录后放弃本次播放，
 * 保证绝不影响对局流程（与旧行为一致，但不再"无声无息"）。
 */
async function replayWithRecovery(name: string, sessionId: number): Promise<void> {
  // 对局已切换/退出：丢弃过期播放请求
  if (sessionId !== soundSessionId) return;

  let sound = await getOrLoadSound(name);
  if (!sound) return;

  try {
    await sound.replayAsync();
    return;
  } catch (e) {
    console.warn(`[SoundManager] replay '${name}' 首次失败，120ms 后重试:`, e);
  }

  if (sessionId !== soundSessionId) return;
  await sleep(120);

  try {
    await sound.replayAsync();
    return;
  } catch (e) {
    console.warn(`[SoundManager] replay '${name}' 重试仍失败，重建音效对象:`, e);
  }

  if (sessionId !== soundSessionId) return;
  // 重建：清缓存 → 卸载旧对象 → 重新加载 → 最后尝试一次
  soundCache.delete(name);
  try {
    await sound.unloadAsync();
  } catch {
    // 忽略卸载失败（对象可能已被原生侧回收）
  }
  sound = await getOrLoadSound(name);
  if (!sound) return;
  try {
    await sound.replayAsync();
  } catch (e) {
    console.warn(`[SoundManager] replay '${name}' 重建后仍失败，放弃本次播放:`, e);
  }
}

export async function playSound(name: string): Promise<void> {
  try {
    await ensureAudioMode();
    const sessionId = soundSessionId;
    // 串行化同一音效的播放：排队等待上一次播放完成后原子重放
    const task = (playQueues.get(name) ?? Promise.resolve()).then(() =>
      replayWithRecovery(name, sessionId),
    );
    playQueues.set(name, task);
    await task;
  } catch (e) {
    // 兜底：replayWithRecovery 自身不抛错，此处仅防御意外异常
    console.warn(`[SoundManager] playSound '${name}' 异常:`, e);
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
  // 会话代号自增：使仍在队列中的过期播放请求自行失效（不会重建音效对象）
  soundSessionId++;
  const promises: Promise<unknown>[] = [];
  for (const [, sound] of soundCache) {
    promises.push(
      sound.unloadAsync().catch(() => { /* 忽略卸载失败 */ })
    );
  }
  soundCache.clear();
  playQueues.clear();
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
