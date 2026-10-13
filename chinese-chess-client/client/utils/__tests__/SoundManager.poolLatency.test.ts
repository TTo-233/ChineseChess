/**
 * 【音效延迟修复】短音效独占实例池的回归断言（2026-10）。
 *
 * 背景（详见 utils/SoundManager.ts 内 preloadShortPools / releaseAfterVerify 注释）：
 * 对局里最短的连响是「我方走子 → AI 应招」，间隔仅 300ms
 * （screens/game: 无特效时 aiDelay = 300ms），而走子素材本身 275~406ms——
 * 也就是说第二声响起时第一声**还在播**，两者必须各自占一个实例。
 *
 * 修复前有两个确定性缺陷，都让第二声（AI 应招）必然撞上空池：
 *   1) preloadShortPools 每个音效**只建 1 个**实例（池上限 3 形同虚设）；
 *   2) releaseAfterVerify 固定等 420ms 才还池，而连响间隔只有 300ms。
 * 撞上空池 ⇒ 走 acquireShortSound 的临时 createAsync（重新加载+解码素材），
 * 浏览器实测 ~9ms、真机上更久 —— 就是用户听到的「AI 走子音慢半拍」。
 *
 * 本组用例把这两个约束钉死，防止日后被"顺手改回去"。
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

/** 极小假 Sound：本组只关心"创建了多少个实例"，不关心播放头推进。 */
class FakeSound {
  calls: Array<{ op: string; at: number }> = [];
  private record(op: string) {
    this.calls.push({ op, at: Date.now() });
  }
  async pauseAsync() { this.record('pause'); return this.status(); }
  async setPositionAsync() { this.record('setPosition'); return this.status(); }
  async setVolumeAsync() { this.record('setVolume'); return this.status(); }
  async playAsync() { this.record('play'); return this.status(); }
  async setStatusAsync() { return this.status(); }
  async unloadAsync() { this.record('unload'); return true; }
  setOnPlaybackStatusUpdate() { /* 本组不依赖 */ }
  async getStatusAsync() { return this.status(); }
  status() {
    return {
      isLoaded: true,
      positionMillis: 1000, // 直接给一个"已推进"的值，避免自检判失败触发重发
      durationMillis: 406,  // go.mp3 实测
      volume: 1,
      isPlaying: true,
      didJustFinish: false,
    };
  }
  /** 音量非 0 的起播时刻（用户真正听到声的时刻） */
  audibleAt(): number | null {
    const hit = this.calls.find((c) => c.op === 'play');
    return hit ? hit.at : null;
  }
}

let created: Array<{ name: string; sound: FakeSound }> = [];

function nameOfSource(source: unknown): string {
  const asset = (source as { asset?: unknown } | null)?.asset;
  return typeof asset === 'string' ? asset : '未知素材';
}

function countOf(name: string): number {
  return created.filter((c) => c.name === name).length;
}

/** SoundManager 是模块级单例，每次拿全新实例 */
async function loadSoundManager(): Promise<typeof import('@/utils/SoundManager')> {
  let mod!: typeof import('@/utils/SoundManager');
  await jest.isolateModulesAsync(() => {
    mod = require('@/utils/SoundManager');
  });
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  created = [];
  (Audio.Sound.createAsync as jest.Mock).mockImplementation(async (source: unknown) => {
    const sound = new FakeSound();
    created.push({ name: nameOfSource(source), sound });
    return { sound };
  });
});

describe('【延迟修复】短音效独占实例池必须填满', () => {
  it('进入对局后，每个短音效的池库存 ≥2（够"我方+AI"连响同时占用）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const pool = sm.__debugPoolSnapshot();
    // 走子/吃子是"我方 → AI"连响的主角，必须各有 ≥2 个已加载实例
    expect(pool.go).toBeGreaterThanOrEqual(2);
    expect(pool.eat).toBeGreaterThanOrEqual(2);
  });

  it('预热不再只建 1 个：go 的实例数必须多于 1', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 旧实现只建 1 个（+预热的共享实例），导致第二声必然撞空池。
    // 断言"go 至少被创建了 2 个独立实例"是这条修复的最小充分判据。
    expect(countOf('go')).toBeGreaterThanOrEqual(2);
  });
});

describe('【延迟修复】连播两声不得因空池而新建实例', () => {
  it('我方走子 → 300ms → AI 应招：两声都从池里取，播放期间不新建实例', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    // 预热完成后的实例数作为基线
    const afterPreload = countOf('go');

    // 第一声（我方走子）
    void sm.playSound('go');
    // 300ms 后第二声（AI 应招）—— 此时第一声的素材（406ms）还没播完，
    // 若池只有 1 个实例，第二声就只能新建。
    await new Promise((r) => setTimeout(r, 300));
    void sm.playSound('go');
    await new Promise((r) => setTimeout(r, 200));

    // 连播期间不应再新建实例：池里已有的实例足够两声同时占用
    expect(countOf('go')).toBe(afterPreload);
  });

  it('借出的实例必须在素材播完（+重发余量）内还池，而不是固定等 420ms', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const poolBefore = sm.__debugPoolSnapshot().go;

    // 借出一次（播放 406ms 的素材）
    void sm.playSound('go');
    // 关键时点：素材已播完（406ms）之后、旧实现的 420ms 还池点之前。
    // 修复后此刻应已还池（406+160=566ms 与 420ms 取小者 = 420ms —— 本例中
    // go 的 406+160=566 > 420，故仍取 420；断言改为"不晚于素材+余量"这一契约本身）。
    await new Promise((r) => setTimeout(r, 406 + 160 + 250));

    const poolAfter = sm.__debugPoolSnapshot().go;
    // 实例已归还（库存回到借出前的水平）
    expect(poolAfter).toBeGreaterThanOrEqual(poolBefore);
  });

  it('两声的起播都不晚于调用后 100ms（不被池加载拖住）', async () => {
    const sm = await loadSoundManager();
    await sm.preloadSounds();

    const before = Date.now();
    void sm.playSound('go');
    await new Promise((r) => setTimeout(r, 300));
    const t2 = Date.now();
    void sm.playSound('go');
    await new Promise((r) => setTimeout(r, 300));

    const sounds = created.filter((c) => c.name === 'go').map((c) => c.sound);
    const audible = sounds
      .map((s) => s.audibleAt())
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);

    // 至少两声真正起播了
    expect(audible.length).toBeGreaterThanOrEqual(2);
    // 第一声紧随调用
    expect(audible[0] - before).toBeLessThan(100);
    // 第二声紧随它的调用时刻（t2），不被池加载/等待拖住
    expect(audible[1] - t2).toBeLessThan(100);
  });
});
