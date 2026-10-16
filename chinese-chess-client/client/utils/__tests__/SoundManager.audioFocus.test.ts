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
};

let native: NativeState;

function resetNative(): void {
  native = { acquired: false, appPaused: false, grantFocus: true, focusRequests: 0 };
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
  playWhenReady = false;
  positionMs = 0;
  loaded = true;
  durationMs = 300;
  calls: Array<{ op: string; at: number; volume: number }> = [];

  constructor(readonly name: string) {}

  private record(op: string) {
    this.calls.push({ op, at: Date.now(), volume: this.effectiveVolume });
  }

  /** SimpleExoPlayerData.java:253-256 */
  requiresAudioFocus(): boolean {
    return this.shouldPlay && this.effectiveVolume >= 0 && true;
  }

  /** SimpleExoPlayerData.java:258-263 —— 无焦点一律 0f */
  private updateVolumeMuteAndDuck(): void {
    this.effectiveVolume = native.acquired ? 1 : 0;
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
    this.positionMs = pos;
    this.finishSetStatus();
    return this.status();
  }

  async setVolumeAsync(v: number): Promise<unknown> {
    this.record(`setVolume:${v}`);
    this.finishSetStatus();
    return this.status();
  }

  /** playAsync ≡ setStatusAsync({shouldPlay:true})（build/AV.js:171） */
  async playAsync(): Promise<unknown> {
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
      this.positionMs = 1; // 起播后播放头开始推进
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
  }

  setOnPlaybackStatusUpdate() {
    /* 真机 didJustFinish 只走 push 回调；本组不依赖 */
  }

  status() {
    return {
      isLoaded: this.loaded,
      positionMillis: this.positionMs,
      durationMillis: this.durationMs,
      volume: 1,
      isPlaying: this.playWhenReady,
      didJustFinish: false,
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