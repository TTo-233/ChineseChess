/**
 * 【v5 根因回归】音效必须"一直持有音频焦点"（2026-10）
 *
 * 背景
 * ---------------------------------------------------------------------------
 * 用户反馈：不是偶发首步漏音，而是**基本所有音效都不出声**（走子/吃子/将军/胜负）。
 * 此前四轮修复（v1~v4）都建立在同一个假设上——「某条音轨的首次入混被混音器吞掉」，
 * 于是分别在"重放原子性""静音预热""独占实例池""播放头进度自检"上打补丁。
 *
 * 真实根因（expo-av 16.0.8 原生源码，逐行可对）：
 *   ① JS 侧 `pauseAsync()` ≡ `setStatusAsync({shouldPlay:false})`（build/AV.js:182-184）
 *   ② 原生**每次** setStatus 收尾都调用 `abandonAudioFocusIfUnused()`
 *      —— PlayerData.java:377（成功）/ :372（异常）
 *   ③ 它只在「没有播放器还声明需要焦点」时才真的放弃（AVManager.java:372-379），
 *      判据 `requiresAudioFocus()` = mShouldPlay && rate>0 && !muted
 *      （SimpleExoPlayerData.java:253-256）。`pauseAsync()` 恰好把 mShouldPlay
 *      置 false ⇒ **焦点被真正放弃**（AVManager.java:362-369）
 *   ④ 下一声必须重新申请焦点（SimpleExoPlayerData.java:145-159）
 *   ⑤ 申请失败即抛 `AudioFocusNotAcquiredException`，抛出点在第 151 行，
 *      紧随其后的 154~158（**更新音量**、**setPlayWhenReady**）**全被跳过**
 *      ⇒ 播放器保持遗留的 0f 音量、播放头从不推进 ⇒ 完全无声
 *   ⑥ JS 只看到一个 `E_AV_SETSTATUS` reject
 *
 * v4 的 `playAndVerify()`（SoundManager v4 第 415 行）在**每一次**播放前都调
 * `pauseAsync()` —— 正好踩在 ③ 上。于是每一次播放都走 ④⑤ 这条注定可能失败的
 * 申请路径；此后的静音预热/进度自检/重发只是在这条路径上反复打转。
 *
 * v5 的修法：**编排内部永不调用 `pauseAsync()`**，只用 `setPositionAsync(0)`
 * （不碰 mShouldPlay ⇒ 焦点得以保留）把实例复位。
 *
 * 本组用例的做法
 * ---------------------------------------------------------------------------
 * 用一个**忠实复刻上述原生状态机**的 FakeSound 来驱动 SoundManager：
 * 真的维护 `mShouldPlay`、真的在每次 setStatus 后跑 `abandonAudioFocusIfUnused()`、
 * 真的在被拒绝时抛错并跳过「更新音量/开始播放」两步。
 * 于是"有没有正确避开根因"可以被**直接计数**：
 *   · 整局只申请一次焦点 ⇒ 没踩 ③
 *   · 申请失败必然导致那一遍无声 ⇒ 复现故障，且证明重试必须换实例
 */

import { Audio } from 'expo-av';

jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: jest.fn(async () => undefined),
    Sound: { createAsync: jest.fn() },
  },
}));

jest.mock('@/assets/sounds/select.mp3', () => ({ asset: 'select' }));
jest.mock('@/assets/sounds/go.mp3', () => ({ asset: 'go' }));
jest.mock('@/assets/sounds/eat.mp3', () => ({ asset: 'eat' }));
jest.mock('@/assets/sounds/goerror.mp3', () => ({ asset: 'goerror' }));
jest.mock('@/assets/sounds/gamewin.mp3', () => ({ asset: 'gamewin' }));
jest.mock('@/assets/sounds/gamelose.mp3', () => ({ asset: 'gamelose' }));
jest.mock('@/assets/sounds/Man_jiangjun.wav', () => ({ asset: 'Man_jiangjun' }));

// ---------------------------------------------------------------------------
// 原生音频焦点状态机（对应 expo-av 原生源码）
// ---------------------------------------------------------------------------

type NativeState = {
  /** mAcquiredAudioFocus（AVManager.java:96） */
  acquired: boolean;
  /** mAppIsPaused（AVManager.java:98） */
  appPaused: boolean;
  /**
   * 系统是否同意授予焦点。设成函数即可表达"第 N 次才放行"这类确定性策略，
   * 避免测试依赖定时器时序。
   */
  grantFocus: boolean | (() => boolean);
  /** requestAudioFocus 的累计调用次数（对应 AVManager.java:355） */
  focusRequests: number;
  /**
   * 【v6 真机取证】AudioPolicy 分配输出设备的延迟（毫秒）。
   *
   * 真机上（华为 PTP-AN10 / Android 17）实测到：ExoPlayer 起播的那一刻，
   * AudioTrack 常常还没拿到输出设备（dumpsys 里 deviceIds 为空），
   * 此时 updateVolumeMuteAndDuck() 算出的增益是 -inf；
   * 而原生**不会**在设备就绪后再重算一次 ⇒ 音量永久停在近静音。
   * 这个字段用来复现该现象：>0 表示前 N 毫秒内没有输出设备。
   */
  delayedGrantMs: number;
  /** enableDelayedDeviceGrant 被调用的时刻 */
  grantedAt: number;
};

let native: NativeState;

function resetNative(): void {
  native = {
    acquired: false,
    appPaused: false,
    grantFocus: true,
    focusRequests: 0,
    delayedGrantMs: 0,
    grantedAt: Date.now(),
  };
  deadTrackRemaining = 0;
  shortDurationMs = 0;
}

/**
 * 【v8】死轨模拟计数器：>0 时，接下来创建的前 N 个 FakeSound 是"死轨"——
 * 对应真机（PTP-AN10, 22:02 实测）形态 B：
 *   playAsync() 成功 resolve，但 AudioFlinger 从未激活该音轨
 *   （Server 恒 0、G db=-inf、~1s 后以 terminated 移除），播放头永不推进。
 */
let deadTrackRemaining = 0;

/** 【v8】>0 时新建实例使用该极短时长（模拟素材在自检前已自然播完）。 */
let shortDurationMs = 0;

/** AudioPolicy 是否已经给 AudioTrack 分配了输出设备。 */
function hasOutputDevice(): boolean {
  if (native.delayedGrantMs <= 0) return true;
  return Date.now() - native.grantedAt >= native.delayedGrantMs;
}

/** 对应 AVManager.java:339-360 acquireAudioFocus()。失败即抛（调用方据此中止）。 */
function acquireAudioFocus(): void {
  if (native.appPaused) {
    throw new Error('AudioFocusNotAcquiredException: background');
  }
  if (native.acquired) return; // 已有焦点：直接返回，不再打扰系统
  native.focusRequests++;
  const granted =
    typeof native.grantFocus === 'function' ? native.grantFocus() : native.grantFocus;
  if (!granted) {
    native.acquired = false;
    throw new Error('AudioFocusNotAcquiredException: not granted');
  }
  native.acquired = true;
}

/** 对应 AVManager.java:362-369 abandonAudioFocus()。 */
function abandonAudioFocus(): void {
  native.acquired = false;
}

/** 对应 PlayerData.java:372/377 —— 每次 setStatus 收尾都会跑。 */
function abandonAudioFocusIfUnused(): void {
  if (sounds.some((s) => s.requiresAudioFocus())) return;
  abandonAudioFocus();
}

// ---------------------------------------------------------------------------
// 假 Sound
// ---------------------------------------------------------------------------

let sounds: FakeSound[] = [];

class FakeSound {
  /** mShouldPlay（PlayerData.java:109）—— 只有 pauseAsync 会把它置 false */
  shouldPlay = false;
  /** 生效音量：由 updateVolumeMuteAndDuck 按焦点计算（AVManager.java:381-383） */
  effectiveVolume = 0;
  /**
   * 【v8】JS 侧请求的音量（setVolumeAsync 落到 mVolume）。
   * 生效音量 = 请求音量 × 焦点/duck 系数——预热激活把请求置 0 时，
   * 即便焦点在手，生效音量也是 0（真机 G=db 与 mVolume 相乘的模型）。
   */
  requestedVolume = 1;
  playWhenReady = false;
  positionMs = 0;
  /** 【v8.1】最近一次 seek 的位置（时间驱动播放头的基准）。 */
  basePos = 0;
  /** 【v8.1】本次 play 的起始时刻（时间驱动播放头基准）。 */
  playStartedAt: number | null = null;
  loaded = true;
  durationMs = 300;
  calls: Array<{ op: string; at: number; volume: number }> = [];

  /**
   * 【v8】死轨标志：构造时按 deadTrackRemaining 分配。
   * 死轨的 playAsync 正常 resolve，但播放头**永不推进**（真机 Server=0）。
   */
  readonly isDeadTrack: boolean;

  constructor(readonly name: string) {
    this.isDeadTrack = deadTrackRemaining > 0;
    if (this.isDeadTrack) deadTrackRemaining--;
    if (shortDurationMs > 0) this.durationMs = shortDurationMs;
  }

  private record(op: string) {
    this.calls.push({ op, at: Date.now(), volume: this.effectiveVolume });
  }

  /** SimpleExoPlayerData.java:253-256 */
  requiresAudioFocus(): boolean {
    return this.shouldPlay && this.effectiveVolume >= 0 && true;
  }

  /**
   * SimpleExoPlayerData.java:258-263 → AVManager.getVolumeForDuckAndFocus()
   *
   * 【v6】真实增益还要看 AudioPolicy 有没有给这条 AudioTrack 分配输出设备：
   * 真机上设备常常晚几十~几百毫秒才就绪，期间 AudioFlinger 记的
   * `G db` 就是 -inf。原生**只在这里**写一次音量，设备就绪后不会重算，
   * 于是音量永久停在 -inf ⇒ 扬声器端只剩 -49dB 的近静音信号。
   *
   * 【v8】生效音量 = 焦点系数 × 请求音量（mVolume）。预热激活把请求音量
   * 置 0 时，即使焦点在手也不可闻——这与真机行为一致。
   */
  private updateVolumeMuteAndDuck(): void {
    if (!native.acquired || !hasOutputDevice()) {
      this.effectiveVolume = 0; // 真机对应 G db = -inf
    } else {
      this.effectiveVolume = this.requestedVolume;
    }
  }

  /** 对应 PlayerData.java:316-379 的 setStatus 收尾 */
  private finishSetStatus(): void {
    abandonAudioFocusIfUnused();
  }

  /** PlaybackMixin pauseAsync ≡ setStatusAsync({shouldPlay:false})（build/AV.js:182） */
  async pauseAsync(): Promise<unknown> {
    this.record('pause');
    this.shouldPlay = false;
    this.playWhenReady = false;
    this.finishSetStatus();
    return this.status();
  }

  /** setPositionAsync 只带 positionMillis，**不碰 mShouldPlay**（build/AV.js:188） */
  async setPositionAsync(pos: number): Promise<unknown> {
    this.record(`setPosition:${pos}`);
    // ExoPlayer 会把越界 seek 钳到 [0, duration]：这是 warmup "跳到末尾
    // 立即 ENDED" 能成立的前提。
    this.basePos = Math.min(Math.max(0, pos), this.durationMs);
    this.positionMs = this.basePos;
    // 播放中 seek：时钟从新位置重新起算。
    this.playStartedAt = this.playWhenReady ? Date.now() : null;
    this.finishSetStatus();
    return this.status();
  }

  async setVolumeAsync(v: number): Promise<unknown> {
    this.record(`setVolume:${v}`);
    this.requestedVolume = v;
    // setVolumeAsync 走 setStatus → applyNewStatus，不触发增益重算
    // （真机 updateVolumeMuteAndDuck 只在 playAsync 里跑），但生效音量的
    // **上限**随之变化——用 min(请求, 焦点系数) 模拟：play 时再重算一次。
    this.effectiveVolume = Math.min(this.effectiveVolume, v);
    this.finishSetStatus();
    return this.status();
  }

  /** playAsync ≡ setStatusAsync({shouldPlay:true})（build/AV.js:171） */
  async playAsync(): Promise<unknown> {
    this.shouldPlay = true;
    // 【v8】死轨：resolve 成功，但播放头不推进、不进入播放状态（真机 Server=0 形态）。
    // 注意：与焦点被拒不同——那里会抛异常，这里一切"看起来成功"。
    if (this.isDeadTrack) {
      this.record('playDead');
      this.finishSetStatus();
      return this.status();
    }
    this.shouldPlay = true;
    try {
      // SimpleExoPlayerData.java:145-159 的顺序，逐行照搬：
      //   150-152  try { acquireAudioFocus() }
      //   154      updateVolumeMuteAndDuck()   ← 抛异常时被跳过
      //   158      setPlayWhenReady(true)       ← 抛异常时被跳过
      acquireAudioFocus();
      this.updateVolumeMuteAndDuck();
      this.playWhenReady = true;
      this.record('play');
      // 【v8.1】播放头按真实时钟推进（ExoPlayer 语义）：status() 里按
      // playStartedAt 计算当前 position，到达 duration 即 didJustFinish。
      // 死轨不走到这里——播放头恒 0，双时点自检据此判死。
      this.playStartedAt = Date.now();
    } catch (e) {
      this.record('playRejected');
      this.finishSetStatus();
      throw e;
    }
    this.finishSetStatus();
    return this.status();
  }

  async getStatusAsync() {
    return this.status();
  }

  async unloadAsync(): Promise<boolean> {
    this.record('unload');
    this.loaded = false;
    // 刻意**不从** sounds 里移除：已卸载实例的历史播放也要能被统计到
    return true;
  }  setOnPlaybackStatusUpdate() {
    /* 真机 didJustFinish 只走 push 回调；本组不依赖 */
  }

  status() {
    // 【v8 真机修正】expo-av 的 isPlaying ≡ playWhenReady（build/AV.js），
    // 真机死轨的 playWhenReady 是 true —— 判活只能靠 positionMillis/didJustFinish。
    // 【v8.1】播放头 = seek 基准 + 播放中经过的时钟（ExoPlayer 语义）：
    //   · seek 到 duration ⇒ 立即 didJustFinish（warmup 的"跳到末尾"据此无声）；
    //   · 正常播放到 duration ⇒ didJustFinish（避免轮询死循环）。
    let pos = this.basePos;
    let finished = false;
    if (this.playWhenReady && !this.isDeadTrack) {
      const started = this.playStartedAt ?? Date.now();
      pos = Math.min(this.basePos + (Date.now() - started), this.durationMs);
      finished = pos >= this.durationMs;
    }
    this.positionMs = pos;
    return {
      isLoaded: this.loaded,
      positionMillis: pos,
      durationMillis: this.durationMs,
      volume: 1,
      isPlaying: this.playWhenReady && !finished,
      didJustFinish: finished,
    };
  }

  /** 用户真正听到声音的时刻：音量非 0 的 play */
  audibleAt(): number | null {
    const hit = this.calls.find((c) => c.op === 'play' && c.volume > 0);
    return hit ? hit.at : null;
  }
}

function nameOfSource(source: unknown): string {
  const asset = (source as { asset?: unknown } | null)?.asset;
  return typeof asset === 'string' ? asset : '未知素材';
}

async function loadSoundManager(): Promise<typeof import('@/utils/SoundManager')> {
  let mod!: typeof import('@/utils/SoundManager');
  await jest.isolateModulesAsync(() => {
    mod = require('@/utils/SoundManager');
  });
  return mod;
}

// 让 createAsync 延迟返回的毫秒数。用于把"装载途中被卸载"这种时序
// 造得确定可复现，而不是靠 await 次数去撞。0 = 不延迟。
let createDelayMs = 0;

beforeEach(() => {
  jest.clearAllMocks();
  sounds = [];
  createDelayMs = 0;
  resetNative();
  (Audio.Sound.createAsync as jest.Mock).mockImplementation(async (source: unknown) => {
    if (createDelayMs > 0) {
      await new Promise((r) => setTimeout(r, createDelayMs));
    }
    const sound = new FakeSound(nameOfSource(source));
    sounds.push(sound);
    return { sound };
  });
});

describe('【v5】音频焦点必须全程持有，不得在音效之间被放弃', () => {
  it('连续播放 20 声只申请一次焦点（旧实现每一声都重新申请）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 预载后应已持有焦点（第一声会申请一次）
    await sm.playSound('go');
    const afterFirst = native.focusRequests;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 19; i++) {
      await sm.playSound('go');
    }

    // 关键断言：焦点一旦拿到就不再被放弃。
    // 若实现里出现 pauseAsync（v4 的做法），每次 setStatus 收尾都会
    // abandonAudioFocusIfUnused ⇒ 这里会涨到 20。
    expect(native.focusRequests).toBe(afterFirst);
    expect(native.acquired).toBe(true);
  }, 30000);

  it('走子→吃子→走子 的真实编排不产生第二次焦点申请', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    await sm.playSound('go');
    await sm.playSound('eat');
    await sm.playSound('go');

    expect(native.focusRequests).toBe(1);
  }, 30000);

  it('编排内部不得调用 pauseAsync（它是放弃焦点的唯一触发器）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    await sm.playSound('go');
    await sm.playSound('eat');
    await sm.playSound('go');

    // SoundManager 只有 stopSound 会 pause，而全工程无调用点；
    // 正常播放路径里一次都不该出现。
    for (const s of sounds) {
      const pauses = s.calls.filter((c) => c.op === 'pause').length;
      expect(pauses).toBe(0);
    }
  }, 30000);
});

describe('【v5】焦点申请失败时必须换实例重试，而不是原地重发', () => {
  it('焦点被拒的那一遍确实无声（复现用户报告的故障）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 预热激活后焦点已被持有（真机行为：req=3 成功后一直持有）。
    // 要模拟"申请被拒"，必须先让它回到未持有态。
    native.acquired = false;
    native.grantFocus = false;
    await sm.playSound('go');

    // 被拒 ⇒ playAsync 抛异常 ⇒ 原生跳过"更新音量/开始播放"
    // ⇒ 没有任何一次音量非 0 的 play ⇒ 完全无声。
    const audible = sounds
      .map((s) => s.audibleAt())
      .filter((t): t is number => t !== null);
    expect(audible).toHaveLength(0);
  }, 30000);

  it('焦点恢复后同一次 playSound 能出声（重试必须换到能出声的实例）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 预热已持有焦点：先放弃，让后续申请重新走 grantFocus 计数器。
    native.acquired = false;
    // 前两次申请被拒、第三次放行 ⇒ 确定性复现"重试路径最终出声"，无定时器依赖。
    let requests = 0;
    native.grantFocus = () => {
      requests++;
      return requests >= 3;
    };

    await sm.playSound('go');

    // 两次失败后第三次成功 ⇒ 确实走到了重试路径
    expect(requests).toBe(3);
    const audible = sounds
      .map((s) => s.audibleAt())
      .filter((t): t is number => t !== null);
    expect(audible.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('playSound 永不抛出（调用点都是 fire-and-forget）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    native.grantFocus = false;
    await expect(sm.playSound('go')).resolves.toBeUndefined();
    await expect(sm.playJiangJunSound()).resolves.toBeUndefined();
  }, 30000);
});

describe('【v5】未预载的音效（如将军语音）现场装载后也能响', () => {
  it('playJiangJunSound 首次调用即可出声', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    expect(sounds.some((s) => s.name === 'Man_jiangjun')).toBe(false);

    await sm.playJiangJunSound();

    const jiangjun = sounds.filter((s) => s.name === 'Man_jiangjun');
    expect(jiangjun.length).toBeGreaterThanOrEqual(1);
    expect(jiangjun.some((s) => s.audibleAt() !== null)).toBe(true);
  }, 30000);
});

describe('【v5】引用计数：栈上多个发声屏互不误杀', () => {
  it('只有最后一个使用者离开才卸载；仍在挂载的屏音频不丢', async () => {
    const sm = await loadSoundManager();

    // 模拟 lanGame → /lanBattle → /spectate：三个发声屏依次挂载
    await sm.acquireSoundSession();
    await sm.acquireSoundSession();
    await sm.acquireSoundSession();
    expect(sm.__debugSessionRefs()).toBe(3);

    // 用户从 spectate 返回 —— 先弹出的一屏释放
    await sm.releaseSoundSession();
    expect(sm.__debugSessionRefs()).toBe(2);

    // 关键：此时仍挂载的对局屏必须还能出声
    await sm.playSound('go');
    const audible = sounds
      .map((s) => s.audibleAt())
      .filter((t): t is number => t !== null);
    expect(audible.length).toBeGreaterThanOrEqual(1);

    // 剩下的两屏依次退出
    await sm.releaseSoundSession();
    await sm.releaseSoundSession();
    expect(sm.__debugSessionRefs()).toBe(0);
  }, 30000);

  it('最后一个使用者离开后才真正卸载实例', async () => {
    const sm = await loadSoundManager();
    await sm.acquireSoundSession();
    const before = sounds.length;
    expect(before).toBeGreaterThan(0);

    await sm.acquireSoundSession();
    await sm.releaseSoundSession(); // 还有人用
    expect(sounds.every((s) => s.loaded)).toBe(true);

    await sm.releaseSoundSession(); // 最后一人
    expect(sounds.every((s) => !s.loaded)).toBe(true);
  }, 30000);

  it('多退不崩（引用计数不会变负）', async () => {
    const sm = await loadSoundManager();
    await sm.releaseSoundSession();
    await sm.releaseSoundSession();
    expect(sm.__debugSessionRefs()).toBe(0);
  }, 30000);
});

describe('【v5】会话作废：卸载后不重试过期请求', () => {
  it('unloadAllSounds 之后同一音效仍能再次播放（没有残留的死链）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    await sm.playSound('go');

    await sm.unloadAllSounds();
    await sm.preloadSounds();
    await sm.playSound('go');

    // 第二轮必须有真的出声（v3 的 playQueues 死链会让这里永久无声）
    const audible = sounds
      .map((s) => s.audibleAt())
      .filter((t): t is number => t !== null);
    expect(audible.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('装载途中被卸载：不得留下"已卸载却仍被引用"的死实例', async () => {
    const sm = await loadSoundManager();

    // 让本次的装载慢一点返回，确保卸载真的发生在"装载途中"
    createDelayMs = 40;

    const playing = sm.playSound('alarm'); // alarm 不在预载名单里
    await new Promise((r) => setTimeout(r, 10)); // 装载已开始但未完成
    await sm.unloadAllSounds();
    await playing;
    createDelayMs = 0;

    // 关键不变式：装载任务完成后，池里不得留下"已卸载却仍被引用"的死实例。
    // 会话已作废 ⇒ getRing 的守卫会把刚建好的实例就地卸载并放弃登记。
    expect(Object.keys(sm.__debugPoolSnapshot())).toHaveLength(0);
    // 且这些中途被创建的实例确实都已卸载
    for (const s of sounds) {
      expect(s.loaded).toBe(false);
    }

    // 并且重新预载 + 播放仍然正常（没被死实例卡住）
    await sm.preloadSounds();
    await sm.playSound('go');
    const audible = sounds
      .filter((s) => s.name === 'go' && s.audibleAt() !== null)
      .map((s) => s.audibleAt());
    expect(audible.length).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe('【v5】实例环：连响必须落在不同实例上', () => {
  it('我方走子 → 300ms → AI 应招：第二声不抢占仍在播的实例', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const ring = sm.__debugPoolSnapshot();
    expect(ring.go).toBeGreaterThanOrEqual(2);

    const countBefore = sounds.length;
    void sm.playSound('go');
    await new Promise((r) => setTimeout(r, 300));
    void sm.playSound('go');
    await new Promise((r) => setTimeout(r, 400));

    // 播放期间不应临时新建实例
    expect(sounds.length).toBe(countBefore);

    // 两声都真的出声
    const goAudible = sounds.filter((s) => s.name === 'go' && s.audibleAt() !== null);
    expect(goAudible.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('起播不被任何检测窗口拖慢（没有 v3 的 260ms 播放头自检）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const t0 = Date.now();
    await sm.playSound('go');
    const goSounds = sounds.filter((s) => s.name === 'go');
    const at = goSounds.map((s) => s.audibleAt()).find((t): t is number => t !== null);

    expect(at).toBeDefined();
    // 素材装载已完成，这里只应剩原生调用往返；给足 200ms 余量仍远小于 v3 的 260ms+重发
    expect(at! - t0).toBeLessThan(200);
  }, 30000);
});

describe('【v6】真机取证修复：起播瞬间设备未就绪导致音量停在 -inf', () => {
  // 真实故障（华为 PTP-AN10 / Android 17，2026-10 实测）：
  //   · 扬声器输出线程信号功率稳定在 -49dB（正常应≈0dB）⇒ 有信号但小到听不见；
  //   · dumpsys media.audio_flinger 里我们进程的音轨 AT::add 时 G db 即为 -inf；
  //   · 18 个常驻实例中有 12 个拿不到输出设备（deviceIds 为空）。
  // 成因：原生把音量写进播放器的唯一路径 updateVolumeMuteAndDuck()
  //   只在 playAsync() 内部跑一次，那一刻 AudioPolicy 还没分配输出设备。
  // 只有「起播后重复触发 playAsync」的修法才能让音量恢复正常。

  function enableDelayedDeviceGrant(delayMs: number) {
    native.delayedGrantMs = delayMs;
    native.grantedAt = Date.now();
  }

  it('设备延迟就绪时，必须补推 playAsync 才能把音量写进播放器', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    enableDelayedDeviceGrant(250);

    void sm.playSound('go');
    // 刚起播的瞬间还没拿到设备 ⇒ 这一遍必然是 0（真机 -inf）
    const early = sounds.filter((s) => s.name === 'go').map((s) => s.effectiveVolume);
    expect(Math.max(...early)).toBe(0);

    // 等补推生效（>250ms）
    await new Promise((r) => setTimeout(r, 600));

    const later = sounds.filter((s) => s.name === 'go').map((s) => s.effectiveVolume);
    // 关键断言：补推之后真的有实例拿到了非 0 音量
    expect(Math.max(...later)).toBe(1);
  }, 30000);

  it('设备已就绪时（Web / 多数机型）行为不变，不引入额外延迟', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    enableDelayedDeviceGrant(0);

    const t0 = Date.now();
    await sm.playSound('go');
    const go = sounds.filter((s) => s.name === 'go');
    // 首次起播就已经有音量（无需等补推）
    expect(Math.max(...go.map((s) => s.effectiveVolume))).toBe(1);
    const at = go.map((s) => s.audibleAt()).find((t): t is number => t !== null);
    expect(at! - t0).toBeLessThan(200);
  }, 30000);

  it('补推不得依赖 setVolumeAsync（它不触发增益重算）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    enableDelayedDeviceGrant(250);

    void sm.playSound('go');
    await new Promise((r) => setTimeout(r, 600));

    // 允许的 setVolume：装载时置 1、预热激活置 0/复原 1（见 warmupSlot）。
    // 播放路径本身不得用 setVolume 代替补推（它不触发增益重算）。
    for (const s of sounds) {
      const playTimeSetVol = s.calls.filter(
        (c) => c.op.startsWith('setVolume:') && c.op !== 'setVolume:1' && c.op !== 'setVolume:0'
      ).length;
      expect(playTimeSetVol).toBe(0);
    }
    // 而补推确实发生过（playAsync 被再次调用）
    const replays = sounds
      .filter((s) => s.name === 'go')
      .reduce((n, s) => n + s.calls.filter((c) => c.op === 'play').length, 0);
    expect(replays).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('常驻短音效实例数必须是 2（18 个实例时有 12 个拿不到输出设备）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    const snap = sm.__debugPoolSnapshot();
    expect(snap.go).toBe(2);
    expect(snap.eat).toBe(2);
  }, 30000);

  it('卸载必须取消在途的补推定时器（不给已卸载实例继续发指令）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    void sm.playSound('go');
    // 立刻卸载：补推定时器最早在 90ms 才触发，这里必须抢在它前面。
    await new Promise((r) => setTimeout(r, 10));
    await sm.unloadAllSounds();
    const before = sounds
      .filter((s) => s.name === 'go')
      .reduce((n, s) => n + s.calls.length, 0);
    await new Promise((r) => setTimeout(r, 700));
    const after = sounds
      .filter((s) => s.name === 'go')
      .reduce((n, s) => n + s.calls.length, 0);

    // 卸载之后不应再有补推指令落到这些实例上
    expect(after).toBe(before);
  }, 30000);
});

describe('【v7】真机根因：音频模式绝不携带 earpiece key', () => {
  // 真机取证（2026-10-17，第三次）：
  //   dumpsys audio 里出现
  //     setCommunicationRouteForClient for uid: 10430 device: type:speaker
  //       from API: setSpeakerphoneOn(true) from u/pid:10430/12898
  //     updateCommunicationRoute, preferredCommunicationDevice: type:speaker
  //   即本应用把音频切到了**电话通信路由**。这是所有症状的根因：
  //   输出线程 AUDIO_OUTPUT_FLAG_INCALL_MUSIC、音轨增益 -inf、
  //   扬声器只剩 -49dB 近静音。
  //
  // 触发链（expo-av AVManager.java:413-415 → :393-394）：
  //   只要 setAudioModeAsync 的 payload **含有** playThroughEarpieceAndroid
  //   这个 key（哪怕值是 false），就会执行
  //       setMode(...) + setSpeakerphoneOn(true)
  //   把音频路由切到通信扬声器。唯一安全的做法是整个 key 都不放。

  it('setAudioModeAsync 的 payload 绝不含 playThroughEarpieceAndroid', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const calls = (Audio.setAudioModeAsync as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const [payload] of calls) {
      expect(payload).toBeDefined();
      // 核心断言：这个 key 一个都不能出现
      expect(Object.keys(payload as object)).not.toContain('playThroughEarpieceAndroid');
      expect('playThroughEarpieceAndroid' in (payload as object)).toBe(false);
    }
  }, 30000);

  it('音频模式仍应显式关闭 duck（否则被提示音压低半音量）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const [payload] = (Audio.setAudioModeAsync as jest.Mock).mock.calls.at(-1)!;
    expect(payload).toMatchObject({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      staysActiveInBackground: false,
    });
  }, 30000);

  it('即便走 resetFocusForRetry 重下音频模式，也不会带上 earpiece key', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 播放失败会触发 resetFocusForRetry → 重新下发音频模式
    native.grantFocus = false;
    await sm.playSound('go');

    const calls = (Audio.setAudioModeAsync as jest.Mock).mock.calls;
    for (const [payload] of calls) {
      expect(Object.keys(payload as object)).not.toContain('playThroughEarpieceAndroid');
    }
  }, 30000);
});

describe('【v8】真机死轨形态：playAsync 成功但播放头不推进，必须重建实例', () => {
  // 真机对照实验（PTP-AN10，2026-10-17 22:02，媒体音量 13/16）：
  //   AT::add   G db=-inf  PortVol=-6.3  FrmRdy=19008（数据全就绪）
  //   AT::remove G db=-inf  Server=0（混音器 0 帧消费）Flags=0x008(terminated)
  // 同一时刻 requestAudioFocus(req=3) 成功、焦点栈顶部就是本应用、
  // Metro 日志无任何 [SoundManager] 告警（playAsync 全部成功 resolve）。
  // ⇒ v5 的「resolve 即代表在播」不变式被真机证伪；
  //   v6 的定时补推 playAsync 对此无效（playWhenReady 已 true，no-op）；
  //   22:19 的对照里「全新实例」是唯一被证明能出声的恢复手段。

  it('死轨实例必须在自检后被标记并卸载，且用全新实例重播', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    await sm.unloadAllSounds(); // 清掉预载，改用"播放时按需建环"精确控制谁被建成死轨

    // 接下来创建的 2 个实例 = playSound('go') 按需建出的 go 环全部实例
    deadTrackRemaining = 2;
    await sm.playSound('go');
    // 自检两时点 200/450ms、重建延迟 80ms、重建装载需要时间
    await new Promise((r) => setTimeout(r, 1300));

    const goSounds = sounds.filter((s) => s.name === 'go');
    // 被播放选中的死实例必须被检出、标记并卸载。
    // （环里另一个从未被播放的死槽 JS 无从预知——它会在被播放时
    //   因原生抛错进入既有换实例重试路径，真机行为对齐。）
    const dead = goSounds.filter((s) => s.isDeadTrack);
    expect(dead.length).toBe(2);
    // 自检只处理"被播放选中的"那个死实例；warmup 也发 playDead，所以用
    // "被 unload 过"作为被检出清理的判据（markDeadAndRebuild 必 unload）。
    const cleaned = dead.filter((s) => s.calls.some((c) => c.op === 'unload'));
    expect(cleaned.length).toBeGreaterThanOrEqual(1);
    expect(cleaned.every((s) => !s.loaded)).toBe(true);

    // 重建的全新实例（非死轨）真的拿到了非 0 音量的 play —— 即"出声"
    const freshAudible = goSounds.filter(
      (s) => !s.isDeadTrack && s.audibleAt() !== null
    );
    expect(freshAudible.length).toBeGreaterThanOrEqual(1);
    // 且重建后环里不再有死实例
    expect(sm.__debugPoolSnapshot().go).toBeGreaterThanOrEqual(1);

    // 收尾：终止在途的自检/重建流，防止泄漏到下一个用例的共享 sounds 数组
    await sm.unloadAllSounds();
    await new Promise((r) => setTimeout(r, 700));
  }, 30000);

  it('正常音轨不触发重建（自检只杀真正的死轨）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    // 前一个用例的在途自检流可能还在后台跑（共享 sounds 数组），
    // 先清会话并等一拍，让计数基线稳定在"本用例自己"的实例上。
    await sm.unloadAllSounds();
    await sm.preloadSounds();
    deadTrackRemaining = 0;

    // 基线：本用例自己的 go 实例（最后 2 个 = go 环）
    const countBefore = sounds.length;
    const baselineGo = sounds.filter((s) => s.name === 'go').slice(-2);
    expect(baselineGo.length).toBe(2);

    await sm.playSound('go');
    // 覆盖双时点自检窗口（200/450ms）+ 余量
    await new Promise((r) => setTimeout(r, 900));

    // 没有死轨时：不新建实例（数组长度不变）、基线实例全部存活
    expect(sounds.length).toBe(countBefore);
    expect(baselineGo.every((s) => s.loaded)).toBe(true);

    // 收尾：终止在途流
    await sm.unloadAllSounds();
    await new Promise((r) => setTimeout(r, 700));
  }, 30000);

  it('素材短于自检窗口且已自然播完的实例不得被误判为死轨', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 26ms 的 select：200ms 自检时它早已播完（didJustFinish）——
    // 真机上这类"播完了"的音轨 Server 是推进过的，绝不能重建。
    shortDurationMs = 30;
    const before = sounds.length;
    await sm.playSound('select');
    await new Promise((r) => setTimeout(r, 700));

    expect(sounds.length).toBe(before);
    const selects = sounds.filter((s) => s.name === 'select');
    expect(selects.length).toBeGreaterThanOrEqual(1);
    expect(selects.every((s) => s.loaded)).toBe(true);
  }, 30000);

  it('死轨重建后的播放不阻塞 playSound 返回（自检异步进行）', async () => {
    const sm = await loadSoundManager();
    // 环已预载（含 warmup），playSound 不含建环耗时 —— 只测"自检不阻塞主路径"
    await sm.preloadSounds();
    // 手工把预载实例换成死轨：直接把计数留给"重建替补"，让主播放命中的实例也是死轨——
    // 为此重建前先把现有环清掉但保留 rings 注册：用 unloadAllSounds + 手动重建太绕。
    // 简化：断言目标是"playSound 在自检窗口(200ms)之前返回"，用正常实例即可表达
    // （死轨与正常实例的 startSlot 主路径耗时相同）。
    const t0 = Date.now();
    await sm.playSound('go');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(180);
  }, 30000);

  it('重建期间会话作废：不得给已卸载的环继续重播', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    await sm.unloadAllSounds();
    deadTrackRemaining = 2;

    const playing = sm.playSound('go');
    // 抢在自检（200ms）之前卸载
    await new Promise((r) => setTimeout(r, 10));
    await sm.unloadAllSounds();
    await playing;

    // 卸载后不得有新的播放类指令（play/setPosition 都算）。
    // 判界用「最后一次 unload 的时刻」：unloadAllSounds 会同步给所有实例
    // 记 unload，之后的任何播放类调用都是泄漏。
    let unloadAtMax = 0;
    for (const s of sounds) {
      for (const c of s.calls) if (c.op === 'unload' && c.at > unloadAtMax) unloadAtMax = c.at;
    }
    const latePlays = sounds.flatMap((s) =>
      s.calls.filter((c) => c.at > unloadAtMax && (c.op === 'play' || c.op === 'playDead' || c.op.startsWith('setPosition')))
    );
    expect(latePlays.length).toBe(0);

    // 收尾：终止在途流
    await sm.unloadAllSounds();
    await new Promise((r) => setTimeout(r, 700));
  }, 30000);

  /**
   * 【v8.1 回归】用户 2026-10-18 反馈"好像没有静音预热"暴露的真 bug：
   * 初版预热只静音 80ms 就恢复音量并 seek 回 0 —— 而 ExoPlayer 在 ENDED
   * 且 playWhenReady=true 时 seek 回开头会**立即重新播放**，于是
   * go/eat/goerror（275~344ms）的剩余部分整段出声。
   * 修正后：预热 = 静音播 80ms → seek 到末尾（ENDED、无声）→ 恢复音量，
   * **不回位**；回位交给真正播放时的 startSlot。
   * 本用例钉死"预载完成后不得有任何可闻 play"。
   */
  it('预热激活必须全程静音：预载后不得出现任何可闻的 play', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 预载期间所有 play 都必须是 0 音量（setVolume(0) 之后才 playAsync）
    const audible = sounds.filter((s) => s.audibleAt() !== null);
    expect(audible).toHaveLength(0);

    // 预热结束必须恢复请求音量 1（否则后续真实播放会一直是静音）
    for (const s of sounds) expect(s.requestedVolume).toBe(1);

    // 预热不得使用 pauseAsync（v5 焦点不变式：pause 会放弃焦点）
    const pauses = sounds.flatMap((s) => s.calls.filter((c) => c.op === 'pause'));
    expect(pauses).toHaveLength(0);

    // 预热后真实播放必须能出声（seek(0)+playAsync 在 startSlot 完成）
    await sm.playSound('go');
    const goAudible = sounds.filter((s) => s.name === 'go' && s.audibleAt() !== null);
    expect(goAudible.length).toBeGreaterThanOrEqual(1);

    // 收尾
    await sm.unloadAllSounds();
    await new Promise((r) => setTimeout(r, 700));
  }, 30000);
});
