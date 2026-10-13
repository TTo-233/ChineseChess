/**
 * "走子/吃子音效偶发完全不再播放"（2026-10，Web + 真机双端复现）
 *
 * 现象：进入对局后，走子/吃子有时没声音；重进再试又好了，概率性。
 * 揭棋接入后发现象棋也受影响 ⇒ 与揭棋引擎本身无关，是 SoundManager 的通用缺陷。
 *
 * 根因（见 SoundManager.ts 内 playQueueGen / HANDOVER_TIMEOUT_MS 处的注释）：
 *   1) `playQueues` 的串行链只在 unloadAllSounds() 被整体清空，而任务体里
 *      任何一个"不 return"的分支都会让该链保持 pending。此后所有同名音效
 *      永久排在它后面 ⇒ 该音效彻底不再播放。
 *   2) 更隐蔽的一条：getPlayableSound 里 `await inFlight.promise`，
 *      而 inFlight 是 warmupTasks 的**快照**。discardSound 会删掉 warmupTasks
 *      并重建播放器，于是这条快照可能指向一条**永远不再 settle 的旧链**
 *      （它等的对象已被 unloadAsync 掉）。调用方正 await 着它 ⇒ 该音效永久无声。
 *      表现上极具迷惑性：预热"看起来是成功的"（新预热照常重建），但一发不出声。
 *   3) ensureAudibleVolume 用 setStatusAsync({volume}) 补拉音量，而 expo-av 的
 *      Web 实现 setStatusForMedia() **不处理 volume**（只认 position/shouldPlay/rate）
 *      ⇒ Web 上这一步是空操作，音量仍为 0，音轨静音地播完 ⇒ "播一半"。
 *
 * 修复：给串行链加"世代"自检（链失效即作废，不排在死链后面）、
 *       预热交接加超时兜底、URL 层改走 setVolumeAsync。
 *
 * 本组用例把三条都钉死，且**刻意用最悲观的音轨**（每一次起播都失败、
 * 预热期间对象被丢弃重建）来驱动那些平时几乎走不到的分支。
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
jest.mock('@/assets/sounds/Man_jiangjun.wav', () => ({ asset: 'Man_jiangjun' }));

/** 假 Sound：足够实现 playAndVerify / warmUpTrack 用到的那几个方法。 */
class FakeSound {
  playing = false;
  volume = 1;
  startedAt: number | null = null;
  /** 起播延迟：超过它播放头才推进（模拟 AudioTrack 线程写延迟） */
  startupLatencyMs: number;
  private latencyForThisPlay = 0;
  /** >0 = 每一次起播都延迟这么久（这条音轨始终起不来） */
  stallEvery = 0;
  /** 音量被原生按焦点压到 0（模拟"应声被静音"，用于驱动补拉音量分支） */
  muteOnPlay = false;
  calls: string[] = [];

  constructor(startupLatencyMs = 0) {
    this.startupLatencyMs = startupLatencyMs;
  }

  stallEveryPlay(ms: number) {
    this.stallEvery = ms;
  }

  muteEveryPlay() {
    this.muteOnPlay = true;
  }

  private record(op: string) {
    this.calls.push(op);
  }

  private position() {
    if (this.startingUp()) return 0;
    return Math.max(0, Date.now() - (this.startedAt ?? Date.now()) - this.latencyForThisPlay);
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
    this.latencyForThisPlay = this.stallEvery || this.startupLatencyMs;
    this.startupLatencyMs = 0;
    // 原生 updateVolumeMuteAndDuck 按焦点改写音量：这里模拟"被压到 0"
    if (this.muteOnPlay) this.volume = 0;
    return this.status();
  }
  /** Web 上 setStatusAsync({volume}) 是空操作：音轨音量不变（回归点 #3） */
  async setStatusAsync(_status?: { volume?: number }) {
    this.record('setStatus');
    return this.status();
  }
  async unloadAsync() {
    this.record('unload');
    return true;
  }
  setOnPlaybackStatusUpdate() {
    /* didJustFinish 只走 push 回调，本组用例不依赖 */
  }
  status() {
    return {
      isLoaded: true,
      positionMillis: this.position(),
      durationMillis: 470,
      volume: this.volume,
      isPlaying: this.playing,
      didJustFinish: false,
    };
  }
  async getStatusAsync() {
    return this.status();
  }
  audibleAt(): number | null {
    // 玩家真正听到：音量非 0 的那一次起播
    return this.calls.includes('play') ? this.volume : null;
  }
}

let created: Array<{ name: string; sound: FakeSound }> = [];
let startupLatencyMs = 120;
let stallEveryPlayMs: number | null = null;
let muteOnPlay = false;

function nameOfSource(source: unknown): string {
  const asset = (source as { asset?: unknown } | null)?.asset;
  return typeof asset === 'string' ? asset : '未知素材';
}

function soundOf(name: string): FakeSound {
  const hit = created.find((c) => c.name === name);
  if (!hit) throw new Error(`没有创建过音效 '${name}'`);
  return hit.sound;
}

/**
 * 统计某个音效名在**所有实例**上的起播次数。
 *
 * ⚠️ 短音效（走子/吃子，≤900ms）现在是「每次播放借一个独占实例」，
 * 所以不能再只看某一个实例——同一个 go 会有多个 FakeSound，必须全部统计。
 */
function playCountOf(name: string): number {
  return created
    .filter((c) => c.name === name)
    .reduce((s, c) => s + c.sound.calls.filter((x) => x === 'play').length, 0);
}

async function loadSoundManager(): Promise<typeof import('@/utils/SoundManager')> {
  let mod = null as unknown as typeof import('@/utils/SoundManager');
  await jest.isolateModulesAsync(() => {
    mod = require('@/utils/SoundManager');
  });
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  created = [];
  startupLatencyMs = 120;
  stallEveryPlayMs = null;
  muteOnPlay = false;
  (Audio.Sound.createAsync as jest.Mock).mockImplementation(async (source: unknown) => {
    const sound = new FakeSound(startupLatencyMs);
    if (stallEveryPlayMs !== null) sound.stallEveryPlay(stallEveryPlayMs);
    if (muteOnPlay) sound.muteEveryPlay();
    created.push({ name: nameOfSource(source), sound });
    return { sound };
  });
});

describe('音效串行链不得被死链永久堵死', () => {
  it('连续多次走子：每一次都必须真的发出声音', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 人机对局里连续走子/吃子就是这种节奏：同名音效被反复请求
    for (let i = 0; i < 8; i++) {
      await sm.playSound(i % 2 === 0 ? 'go' : 'eat');
    }

    // 旧实现：第一遍的链卡在 pending 后，后 7 次全都排在它后面，一次都不响。
    // ⚠️ 用 playCountOf（跨实例统计）：短音效已改为「每次播放借独占实例」，
    //    同一个 go 会有多个 FakeSound，只看第一个实例会漏数。
    for (const name of ['go', 'eat']) {
      expect(playCountOf(name)).toBeGreaterThanOrEqual(4);
    }
  }, 30000);

  it('一次播放异常不得连带拖死同名音效的后续播放', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 并发压：同时发多次（真人快速连点就是这个形态）
    await Promise.all([
      sm.playSound('go'),
      sm.playSound('go'),
      sm.playSound('go'),
      sm.playSound('go'),
    ]);

    expect(playCountOf('go')).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('unloadAllSounds 之后同一音效仍能再次播放（链已换代）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    await sm.playSound('go');

    // 退出对局
    await sm.unloadAllSounds();

    // 再次进入对局
    await sm.preloadSounds();
    await sm.playSound('go');

    // preloadSounds 并行创建 4 条音轨，created 的末位不一定是 go，
    // 故按名字取 **最后一个** go 实例（unload 之后重建的那个）。
    const all = created.filter((c) => c.name === 'go');
    expect(all.length).toBeGreaterThanOrEqual(2);
    const rebuilt = all[all.length - 1].sound;
    // 重建的那条是 unload 之后新建的，且必须真的被播放过（否则"退出再进就没声"）
    expect(rebuilt.calls).toContain('play');
  }, 30000);

  it('音轨始终起不来时：重试耗尽后不得把后续播放永久堵住', async () => {
    const sm = await loadSoundManager();
    // 每一次起播都延迟 600ms > 探测窗口 560ms：预热永远不成功
    startupLatencyMs = 600;
    stallEveryPlayMs = 600;

    // 第一遍注定失败（重试耗尽后放弃）
    await sm.playSound('go');
    const first = soundOf('go').calls.filter((c) => c === 'play').length;
    expect(first).toBeGreaterThanOrEqual(1);

    // 关键：失败过的那条链不得让后面的播放永久挂起。
    // 若 playSound 永不返回，本用例会超时失败。
    const done = await Promise.race([
      sm.playSound('go').then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 8000)),
    ]);
    expect(done).toBe('settled');
  }, 40000);
});

describe('补拉音量必须真的生效（Web 上 setStatusAsync 是空操作）', () => {
  it('音量被原生压到 0 时：补拉后必须调用 setVolumeAsync', async () => {
    const sm = await loadSoundManager();
    // 起播即被压到音量 0 → ensureAudibleVolume 必须兜底
    muteOnPlay = true;

    await sm.playSound('go');

    const calls = soundOf('go').calls;
    // 旧实现只调 setStatusAsync（Web 空操作），音量停在 0 ⇒ 静音播完
    expect(calls).toContain('setVolume:1');
    expect(soundOf('go').volume).toBe(1);
  }, 30000);
});

/**
 * 【2026-10 回归】"我方走子音效有明显延迟 / 声音被切断 / 某手完全无声"
 *
 * 上一轮修复引入的世代号有个致命副作用：
 *   `const myGen = (playQueueGen.get(name) ?? 0) + 1;` 把**排队**也算成换代，
 * 于是后到的请求把还在跑的先到请求判成过期（世代对不上 → 直接 return）。
 * 后果正是这三条症状：
 *   · 先到的那声根本没发（"某手完全无声"）
 *   · playQueues 指向一条空链，后续请求看起来"延迟"
 *   · 两条链同时 pause/setPosition(0)/play 同一条音轨（"声音被切断"）
 *
 * 另外，自检原先 `await sleep(260ms)` 挡在串行链上，走子常在 1 秒内连响
 * 「我方 + AI」两声 ⇒ 后一声被硬推迟 ≥260ms（"延迟"）。
 */
describe('同名连响：不得延迟、不得切断、不得整手无声', () => {
  it('连续两次同名播放：两声都必须真的起播（回归：世代号把前一声杀掉）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    const before = playCountOf('go');

    await sm.playSound('go');
    await sm.playSound('go');

    // 两声 = 至少多 2 次起播；旧回归版本只有 1 次（前一声被误判过期）
    expect(playCountOf('go') - before).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('playSound 必须很快返回：自检不得挡住串行链（回归：延迟 ≥260ms）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const t0 = Date.now();
    await sm.playSound('go');
    const elapsed = Date.now() - t0;

    // 旧实现要等 PROGRESS_CHECK_MS=260ms 的自检窗口；起播本身是 0ms。
    // 留足余量但必须显著小于 260ms。
    expect(elapsed).toBeLessThan(200);
  }, 30000);

  it('高频连点同名音效：每一遍都必须起播（真人连点的形态）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();
    const before = playCountOf('go');

    await Promise.all([
      sm.playSound('go'),
      sm.playSound('go'),
      sm.playSound('go'),
    ]);

    // 3 次请求至少要有 3 次起播（不被世代号互相杀掉）
    expect(playCountOf('go') - before).toBeGreaterThanOrEqual(3);
  }, 30000);

  it('自检判失败时仍会后台重发（兜底能力不能丢）', async () => {
    const sm = await loadSoundManager();
    // 起播延迟 600ms > 自检窗口 260ms：每遍都会被自检判成"没出声"
    startupLatencyMs = 600;
    stallEveryPlayMs = 600;

    await sm.preloadSounds();
    // ⚠️ 跨实例统计：重发会借/用不同实例，只看第一个数不到
    const before = playCountOf('go');

    // 只放一声，避免两次请求的预热接力互相覆盖（那是另一条用例的职责）
    await sm.playSound('go');
    // 让后台自检(260ms) + 重发(160ms 延迟 + 一次播放)全部落地
    await new Promise((r) => setTimeout(r, 2500));

    // 1 = 这一遍本身；≥2 说明后台确实又发了一次（重发兜底生效）
    expect(playCountOf('go') - before).toBeGreaterThanOrEqual(2);
  }, 30000);
});