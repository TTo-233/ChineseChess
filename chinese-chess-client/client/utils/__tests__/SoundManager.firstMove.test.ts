/**
 * 【C-82】"进入人机对战后，第一步音效慢一拍"（2026-10 实机）
 *
 * 这组用例把修复前后最容易回归的东西钉在**时间**上，而不是钉在实现细节上。
 *
 * 背景（详见 utils/SoundManager.ts 头注释第六节）：
 *   进入对局时 preloadSounds() 会为常用音轨各起一次静音预热，旧实现要听完整个
 *   素材才结束（go.mp3 470ms）。玩家在预热还在跑的时候就走出第一步，
 *   playSound() 里 `await prepareSound('go')` 等的就是那同一个未完成的 Promise，
 *   于是第一步音效要等 1 秒多才响。用户报的现象是"退出重进必现、局内重开正常"
 *   ——局内重开不卸载组件、预热早已跑完。
 *
 * 修法两条：
 *   a) 预热只探测播放头是否推进（≤560ms），不等整段播完；
 *   b) playSound 只给在途预热 260ms 窗口，超时让预热中止、把音轨交给正式播放。
 *
 * 关键：延迟必须量在**声音真正响起的那一刻**（音量非 0 的 playAsync），
 * 不能量 playSound() 的返回时刻——后者含 260ms 的播放头自检窗口，
 * 那是"播放后确认有没有出声"的开销，与用户听到的先后无关。
 *
 * 假 Sound 用按真实时间推进的播放头模拟一条正常工作的音轨（起播有一次延迟，
 * 模拟原生 AudioTrack 线程写延迟，真机实测 ave≈208ms）。全部使用真实定时器与
 * 真实时钟——预热的截止判断靠 Date.now()，冻结时钟会让那个循环永不退出。
 */

import { Audio } from 'expo-av';

jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: jest.fn(async () => undefined),
    Sound: { createAsync: jest.fn() },
  },
}));

// jest-expo 会把所有音频素材压成**同一个**桩对象，用 require 身份区分素材名是不行的。
// 这里给每个素材一个可区分的身份，createAsync 才能知道自己造的是哪条音轨。
jest.mock('@/assets/sounds/select.mp3', () => ({ asset: 'select' }));
jest.mock('@/assets/sounds/go.mp3', () => ({ asset: 'go' }));
jest.mock('@/assets/sounds/eat.mp3', () => ({ asset: 'eat' }));
jest.mock('@/assets/sounds/Man_jiangjun.wav', () => ({ asset: 'Man_jiangjun' }));

/** 音轨的一次原生调用（带时刻与当时音量）。 */
type Call = { op: string; at: number; volume: number };

/** 假 Sound：播放头按真实时间推进，模拟一条正常工作的音轨。 */
class FakeSound {
  playing = false;
  volume = 1;
  /** playAsync 的时刻；null = 未起播 */
  startedAt: number | null = null;
  /**
   * 这条音轨**尚未被消耗**的起播延迟（模拟原生 AudioTrack 的线程写延迟，
   * 真机实测 ave≈208ms）。整条音轨只承担一次——这正是静音预热要消耗掉的东西。
   */
  startupLatencyMs: number;
  /** 本次起播要承担的延迟（第一次起播后才变成 0） */
  private latencyForThisPlay = 0;
  /** 每一次起播都延迟这么久（模拟这条音轨始终起不来）。0 = 不启用。 */
  private stallEvery = 0;
  calls: Call[] = [];

  constructor(startupLatencyMs = 0) {
    this.startupLatencyMs = startupLatencyMs;
  }

  stallEveryPlay(ms: number) {
    this.stallEvery = ms;
  }

  private record(op: string) {
    this.calls.push({ op, at: Date.now(), volume: this.volume });
  }

  private position() {
    if (this.startingUp()) return 0;
    const elapsed = Date.now() - (this.startedAt ?? Date.now());
    return Math.max(0, elapsed - this.latencyForThisPlay);
  }

  private startingUp() {
    return (
      this.playing &&
      this.startedAt !== null &&
      Date.now() - this.startedAt < this.latencyForThisPlay
    );
  }

  async pauseAsync() {
    this.record('pause');
    this.playing = false;
    return this.status();
  }
  async setPositionAsync(pos: number) {
    this.record(`setPosition:${pos}`);
    this.startedAt = null;
    return this.status();
  }
  async setVolumeAsync(v: number) {
    this.record(`setVolume:${v}`);
    this.volume = v;
    return this.status();
  }
  async playAsync() {
    this.record('play');
    this.playing = true;
    this.startedAt = Date.now();
    // 起播延迟整条音轨只承担一次：预热已经消耗掉的那一次不会再有
    this.latencyForThisPlay = this.stallEvery || this.startupLatencyMs;
    this.startupLatencyMs = 0;
    return this.status();
  }
  async setStatusAsync() {
    return this.status();
  }
  async unloadAsync() {
    this.record('unload');
    return true;
  }
  setOnPlaybackStatusUpdate() {
    /* 真机上 didJustFinish 只走 push 回调；本组用例不依赖它 */
  }

  status() {
    return {
      isLoaded: true,
      positionMillis: this.position(),
      durationMillis: 470, // go.mp3 实测时长
      volume: this.volume,
      isPlaying: this.playing,
      didJustFinish: false,
    };
  }

  async getStatusAsync() {
    return this.status();
  }

  /** 用户真正听到声音的时刻：音量非 0 的那一次起播 */
  audibleAt(): number | null {
    const hit = this.calls.find((c) => c.op === 'play' && c.volume !== 0);
    return hit ? hit.at : null;
  }
}

// 所有被创建出来的假 Sound，按创建顺序。
let created: Array<{ name: string; sound: FakeSound }> = [];

// SoundManager 用 require 拿到的就是上面这些桩对象，按其 asset 字段还原音效名。
function nameOfSource(source: unknown): string {
  const asset = (source as { asset?: unknown } | null)?.asset;
  return typeof asset === 'string' ? asset : '未知素材';
}

function soundOf(name: string): FakeSound {
  const hit = created.find((c) => c.name === name);
  if (!hit) throw new Error(`没有创建过音效 '${name}'（现有：${created.map((c) => c.name).join(',')}）`);
  return hit.sound;
}

function createCount(name: string): number {
  return created.filter((c) => c.name === name).length;
}

/** SoundManager 是模块级单例，状态会跨用例串；每次都拿一份全新实例 */
async function loadSoundManager(): Promise<typeof import('@/utils/SoundManager')> {
  let mod!: typeof import('@/utils/SoundManager');
  await jest.isolateModulesAsync(() => {
    mod = require('@/utils/SoundManager');
  });
  return mod;
}

/**
 * 每条音轨的起播延迟（模拟真机 ave≈208ms 量级）。
 * null = 音轨无论起播多少次都不推进播放头（模拟"这条音轨入不了混"），
 * 用来专门驱动"预热迟迟不成功 → 正式播放接管"这条分支。
 * 注意：起播延迟是**整条音轨一次性**的成本，靠 `stallEveryPlayMs` 把它变成
 * 每次都发生，那等于否定了"预热能消耗掉首次入混"这个前提，不是真实行为。
 */
let startupLatencyMs: number | null = 120;
/** 非 null 时：让**每一次**起播都延迟这么久（用于强制走中止分支）。 */
let stallEveryPlayMs: number | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  created = [];
  startupLatencyMs = 120;
  stallEveryPlayMs = null;
  (Audio.Sound.createAsync as jest.Mock).mockImplementation(
    async (source: unknown) => {
      const sound = new FakeSound(startupLatencyMs);
      if (stallEveryPlayMs !== null) sound.stallEveryPlay(stallEveryPlayMs);
      created.push({ name: nameOfSource(source), sound });
      return { sound };
    }
  );
});

describe('【C-82】第一步音效不得被后台预热阻塞', () => {
  it('预热进行中就走出第一步：声音必须在远小于素材时长内响起', async () => {
    const sm = await loadSoundManager();

    const t0 = Date.now();
    // 进入对局（fire-and-forget，页面就是这么调的：preloadSounds(); 无 await）
    void sm.preloadSounds();
    // 立刻走出第一步——真人操作就有这么快
    await sm.playSound('go');
    const t1 = Date.now();

    const audibleAt = soundOf('go').audibleAt();
    expect(audibleAt).not.toBeNull();
    // 旧实现要听完 go.mp3（470ms，叠加起播延迟约 590ms）才放行，这里必然超时失败
    expect(audibleAt! - t0).toBeLessThan(400);
    // 也远快于"整段播完"这一旧判据
    expect(t1 - t0).toBeLessThan(900);
  }, 15000);

  it('预热已完成后：第一步音效立即响起，不等任何窗口', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds(); // 预热彻底跑完

    const t0 = Date.now();
    await sm.playSound('go');
    const audibleAt = soundOf('go').audibleAt();
    expect(audibleAt).not.toBeNull();
    expect(audibleAt! - t0).toBeLessThan(60);
  }, 15000);

  it('预热迟迟不成功时（起播延迟超过 260ms 窗口）：中止预热并接管音轨，不继续等', async () => {
    const sm = await loadSoundManager();
    // 这条音轨每一次起播都要 450ms 才推进播放头：预热探测（≤560ms）来不及
    // 在 260ms 窗口内完成，必然走中止分支。
    startupLatencyMs = 450;

    const t0 = Date.now();
    void sm.preloadSounds();
    await sm.playSound('go');

    const sound = soundOf('go');
    expect(sound.audibleAt()).not.toBeNull();
    // 绝不超过窗口 + 一个轮询周期 + 一点余量（旧的"等整段播完"会远超这个数）
    expect(sound.audibleAt()! - t0).toBeLessThan(260 + 200);
    // 被中止的预热不应触发重建播放器
    expect(createCount('go')).toBe(1);
  }, 15000);

  it('预热被中止时，收尾不得 pause/回卷掉刚起播的那一遍（否则又变成无声）', async () => {
    const sm = await loadSoundManager();
    // 每一次起播都延迟 450ms：预热探测来不及在 260ms 窗口内完成 → 必然走中止分支
    startupLatencyMs = 450;
    stallEveryPlayMs = 450;

    void sm.preloadSounds();
    await sm.playSound('go');
    // 让被中止的预热把自己的收尾跑完
    await new Promise((r) => setTimeout(r, 700));

    const calls = soundOf('go').calls;
    const lastPlay = calls.map((c) => c.op).lastIndexOf('play');
    expect(lastPlay).toBeGreaterThanOrEqual(0);
    const afterLastPlay = calls.slice(lastPlay + 1).map((c) => c.op);
    expect(afterLastPlay).not.toContain('pause');
    expect(afterLastPlay).not.toContain('setPosition:0');
  }, 15000);

  it('预热收尾必须恢复音量：否则之后的每一步都会是静音', async () => {
    const sm = await loadSoundManager();
    // 走中止分支——最容易漏掉音量恢复的正是这条路径
    startupLatencyMs = 450;
    stallEveryPlayMs = 450;

    void sm.preloadSounds();
    await sm.playSound('go');
    await new Promise((r) => setTimeout(r, 700));

    expect(soundOf('go').volume).toBe(1);
  }, 15000);

  it('接管音轨时必须等预热收尾把音量恢复：否则那一声是静音播完的', async () => {
    const sm = await loadSoundManager();
    startupLatencyMs = 450;
    stallEveryPlayMs = 450;

    void sm.preloadSounds();
    await sm.playSound('go');

    // 起播那一刻的音量必须是 1（音量 0 的 playAsync 不会出声）
    const firstAudible = soundOf('go').calls.find((c) => c.op === 'play' && c.volume !== 0);
    expect(firstAudible).toBeDefined();
  }, 15000);
});
