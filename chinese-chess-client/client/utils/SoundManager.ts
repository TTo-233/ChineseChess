/**
 * 音效管理器
 *
 * ---------------------------------------------------------------------------
 * 真机「第一步无声、第二步起正常」问题的客观定位（基于 expo-av 16.0.8 原生源码
 * 逐行核查 + 设备复现反馈，非主观推断）：
 *
 * 复现事实（用户实机反馈）：
 *   1. 任意音效的「第一次播放」都听不到；
 *   2. 从第二次播放开始全部正常。
 *
 * 已用静态证据排除的假设：
 *   A. 素材损坏 —— 9 个音频文件逐字节解析：7 个 mp3 均为 MPEG-1 Layer III、
 *      可完整走到 EOF 且零残留字节（Xing 头声明字节数与文件大小逐一相等），
 *      2 个 wav 为合法 16bit PCM 44.1kHz。素材完好。
 *      （注：早前一次自研解析器曾误报「只有 1 帧 + 数千字节垃圾」，
 *        原因是把 layer_bits==1 当成了 Layer I 而非 Layer III，已推翻。）
 *   B. 打包丢素材 —— zip 内 9 个音效字节数与磁盘一致，SoundManager 亦非旧版。
 *   C. 别的库抢焦点 —— 全客户端仅 SoundManager 使用 expo-av，无第二个音频消费者。
 *   D. select/goerror/alarm 三个音效 —— 全项目零调用点，从未播放，
 *      故「选中音听不到」不构成证据；真正的信号只有 go/eat 的首步失效。
 *
 * 真正的机制（Android，AVManager.java / PlayerData.java / SimpleExoPlayerData.java）：
 *
 *  1. 预加载用 shouldPlay:false 建 Sound。load() → applyNewStatus() 时
 *     shouldPlayerPlay() 为 false，于是先走 setPlayWhenReady(false)，
 *     再执行 updateVolumeMuteAndDuck()——而此刻 mAcquiredAudioFocus 还是 false，
 *     getVolumeForDuckAndFocus() 因此返回 **0f**，播放器被显式置为「静音待播」。
 *
 *  2. setStatusWithListener() 每次结束都无条件调用 abandonAudioFocusIfUnused()；
 *     没有播放器在播 → 焦点被放弃。
 *
 *  3. 于是「第一次 replayAsync()」成了整个进程里唯一一次必须真正向系统
 *     requestAudioFocus() 的播放；后续每次播放都会在
 *     AVManager.java:348-350 的 `if (mAcquiredAudioFocus) return;` 处短路，
 *     不再发起任何系统请求——这正是「第 2 步起就正常」的原因。
 *
 *  4. 若这一次冷启动申请被拒（或过慢），acquireAudioFocus() 抛
 *     AudioFocusNotAcquiredException：applyNewStatus 已经把音量置 0 且
 *     setPlayWhenReady(true) 尚未执行，播放器停在「已加载、未播放、音量 0」，
 *     setStatus 以 E_AV_SETSTATUS 拒绝 → replayAsync 拒绝 → 该次播放静默丢失。
 *
 * 对应的修复：
 *  1. 预加载阶段做一次「静音预热」：让每个音效在用户听不见的时机先真正播一次
 *     （volume:0）。把「进程内第一次音频焦点申请」和「ExoPlayer 首次解码/READY」
 *     全部挪到预加载期完成——此时代理失焦点无感知，失败也无损失。
 *     进入对局后首次播放不再承担冷启动代价。
 *  2. replayAsync() 返回值里带 volume；若发现仍为 0，立即 setVolumeAsync 重新
 *     拉回（正常路径零额外原生调用，只在真出问题时兜底）。
 *  3. 保留原有三级恢复：120ms 重试 → 400ms 再试 → 卸载重建后最后尝试。
 *  4. 同名音效播放串行化、会话代号防过期请求、失败一律 console.warn 不静默。
 * ---------------------------------------------------------------------------
 */

import { Audio, type AVPlaybackStatus } from 'expo-av';

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

// 播放音量上限。createAsync / setStatusAsync 都显式传它，
// 避免原生侧残留旧音量（预加载期的 updateVolumeMuteAndDuck 会把音量压到 0）。
const SOUND_VOLUME = 1.0;

// 静音预热的最大尝试次数。预热发生在对局开始前、且 volume 为 0，
// 失败对用户完全不可见，因此值得多试几次以提高「首次焦点申请」的成功率。
const WARMUP_MAX_ATTEMPTS = 3;

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
    // interruptionModeAndroid 保持默认 DuckOthers：GAIN_TRANSIENT_MAY_DUCK
    // 是最容易拿到系统焦点的模式，改为 DoNotMix(GAIN) 反而更容易被拒。
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
  // 已缓存则返回
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
        volume: SOUND_VOLUME,
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
 * 静音预热：让音效在用户听不见的时机真正「播」一次。
 *
 * 目的（见文件头注释第 1 条）：把整个进程里唯一一次需要真正向系统
 * requestAudioFocus() 的播放，以及 ExoPlayer 首次解码到 STATE_READY 的过程，
 * 全部提前到预加载期完成。此时代理失焦或播放失败都没有任何用户感知，
 * 进入对局后的首次播放就不再是最脆弱的那一次。
 *
 * 串行执行而非并发：并发会让多个播放器同时抢同一个音频焦点请求，
 * 反而制造本不该出现的争用。
 */
async function warmUpSound(name: string, sound: Audio.Sound): Promise<void> {
  // 预热期多试几次：这一步完全静默（volume 0）且发生在对局开始之前，
  // 用户听不到也感知不到，没有理由只试一次。若连试都失败，说明这次冷启动
  // 焦点申请确实拿不到，真正的播放路径仍有三级恢复兜底。
  for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
    try {
      // volume:0 —— 用户完全听不见；这一步只为触发焦点申请与首次解码。
      const status = await sound.setStatusAsync({
        shouldPlay: true,
        volume: 0,
        positionMillis: 0,
      });
      // 若播放器尚未就绪，给它一点时间进入 STATE_READY 再停，避免把预热
      // 留在一个半就绪状态上（onPlayerStateChanged 只在 READY 时报就绪）。
      if (!status.isLoaded) {
        await sleep(60);
      }
      await sound.setStatusAsync({ shouldPlay: false, volume: SOUND_VOLUME });
      if (attempt > 1) {
        console.log(`[SoundManager] 预热音效 '${name}' 第 ${attempt} 次成功`);
      }
      return;
    } catch (e) {
      console.warn(
        `[SoundManager] 预热音效 '${name}' 第 ${attempt}/${WARMUP_MAX_ATTEMPTS} 次失败:`,
        e
      );
      if (attempt < WARMUP_MAX_ATTEMPTS) {
        await sleep(150);
      }
    }
  }
}

/**
 * 预加载常用音效（在进入对局界面时调用）
 */
export async function preloadSounds(): Promise<void> {
  await ensureAudioMode();
  const loaded = await Promise.all(ESSENTIAL_SOUNDS.map((name) => getOrLoadSound(name)));
  // 串行预热，避免并发抢焦点
  for (const sound of loaded) {
    if (!sound) continue;
    const name = ESSENTIAL_SOUNDS.find((n) => soundCache.get(n) === sound);
    if (name) await warmUpSound(name, sound);
  }
}

/**
 * 预加载游戏结束音效（对局进行中后台加载）
 */
export async function preloadGameEndSounds(): Promise<void> {
  await ensureAudioMode();
  const loaded = await Promise.all([
    getOrLoadSound('gamewin'),
    getOrLoadSound('gamelose'),
  ]);
  for (const sound of loaded) {
    if (!sound) continue;
    const name = sound === soundCache.get('gamewin') ? 'gamewin' : 'gamelose';
    await warmUpSound(name, sound);
  }
}

/**
 * 从播放状态里取出音量；错误状态或未加载时返回 null。
 * AVPlaybackStatus 是成功/错误两个类型的联合，必须先收窄才能取字段。
 */
function readVolume(status: AVPlaybackStatus | null | undefined): number | null {
  if (!status) return null;
  if (status.isLoaded === false || !('volume' in status)) return null;
  return typeof status.volume === 'number' ? status.volume : null;
}

/**
 * 检查播放结果：若原生回报音量为 0，补一次拉起。
 *
 * 原生侧 getVolumeForDuckAndFocus() 在 mAcquiredAudioFocus 为 false 时返回 0f，
 * 若播放瞬间焦点状态不正确，replayAsync 会「成功」但音量为 0（听感等于没播）。
 * replayAsync() 的返回值本身就带 volume，因此正常路径**不产生任何额外原生调用**，
 * 只有真的检测到 0 时才补一次 setStatusAsync。
 */
async function ensureAudibleVolume(
  sound: Audio.Sound,
  name: string,
  status: AVPlaybackStatus | null
): Promise<void> {
  if (readVolume(status) !== 0) return;
  try {
    await sound.setStatusAsync({ volume: SOUND_VOLUME });
    console.warn(`[SoundManager] 音效 '${name}' 播放后音量仍为 0，已重新拉起音量`);
  } catch (e) {
    console.warn(`[SoundManager] 音效 '${name}' 补拉音量失败:`, e);
  }
}

/**
 * 原子重放并带回退恢复（核心播放路径）：
 * 1. replayAsync 单次原生调用完成"回零+播放"，随后确认音量非 0
 * 2. 失败（音频焦点/音频会话瞬态拒绝等）→ 120ms 后重试一次
 * 3. 仍失败 → 400ms 后再试一次（覆盖冷启动焦点申请较慢的情况）
 * 4. 仍失败 → 卸载重建 Sound 对象后最后尝试一次（恢复原生播放器异常状态）
 * 本函数不抛出异常：任何失败都以 console.warn 记录后放弃本次播放，
 * 保证绝不影响对局流程（与旧行为一致，但不再"无声无息"）。
 */
async function replayWithRecovery(name: string, sessionId: number): Promise<void> {
  // 对局已切换/退出：丢弃过期播放请求
  if (sessionId !== soundSessionId) return;

  let sound = await getOrLoadSound(name);
  if (!sound) return;

  try {
    const status = await sound.replayAsync();
    await ensureAudibleVolume(sound, name, status);
    return;
  } catch (e) {
    console.warn(`[SoundManager] replay '${name}' 首次失败，120ms 后重试:`, e);
  }

  if (sessionId !== soundSessionId) return;
  await sleep(120);

  try {
    const status = await sound.replayAsync();
    await ensureAudibleVolume(sound, name, status);
    return;
  } catch (e) {
    console.warn(`[SoundManager] replay '${name}' 重试仍失败，400ms 后再试:`, e);
  }

  if (sessionId !== soundSessionId) return;
  await sleep(400);

  try {
    const status = await sound.replayAsync();
    await ensureAudibleVolume(sound, name, status);
    return;
  } catch (e) {
    console.warn(`[SoundManager] replay '${name}' 三次均失败，重建音效对象:`, e);
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
  // 重建后的播放器同样是「从未播过」的冷状态，需要重新预热才能获得焦点与解码
  await warmUpSound(name, sound);
  if (sessionId !== soundSessionId) return;
  try {
    const status = await sound.replayAsync();
    await ensureAudibleVolume(sound, name, status);
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
      sound.stopAsync().catch(() => { /* 停止失败忽略 */ })
    );
  }
  await Promise.all(promises);
}

export async function unloadSound(): Promise<void> {
  // 兼容旧接口：仅停止当前播放，不卸载缓存
  await stopSound();
}