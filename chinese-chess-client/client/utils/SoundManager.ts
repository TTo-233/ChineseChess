/**
 * ===========================================================================
 * 音效管理（v5 · 重写）
 * ===========================================================================
 *
 * 一、这次要解决的问题
 * ---------------------------------------------------------------------------
 * 用户反馈：不是偶发的首步漏音，而是**基本所有音效都不出声**（走子、吃子、
 * 将军、胜负）。此前四轮修复（v1~v4：replayAsync、静音预热、独占实例池、
 * 播放头进度自检）都建立在同一个假设上——「某条音轨的首次入混被混音器吞掉」，
 * 因此都在围绕"预热"和"重发"打补丁。v3/v4 的自检读 `positionMillis`，
 * 但**音卡死时播放头同样推不动**，于是判定"失败"→重发→再卡死，
 * 既治不了根因，还引入了 260ms 的检测延迟（就是"慢半拍"）。
 *
 * 二、真正的根因：expo-av 的「音频焦点」在每一声之后被放弃，
 *    下一声重新申请焦点失败 ⇒ 原生把音量设成 0f 且**根本不开始播放**
 * ---------------------------------------------------------------------------
 * 下面每一条都能在 expo-av 16.0.8 的原生源码里逐行对上（路径相对
 * `node_modules/expo-av/android/src/main/java/expo/modules/av/`）：
 *
 *   ① JS 侧 `sound.pauseAsync()`  ≡ `setStatusAsync({shouldPlay:false})`
 *      （build/AV.js:182-184）
 *   ② 原生每次 setStatus 收尾**都会**调用 `abandonAudioFocusIfUnused()`
 *      —— 成功路径 PlayerData.java:377，异常路径 PlayerData.java:372
 *   ③ 该函数只在「没有任何播放器还声明需要焦点」时才真的放弃焦点
 *      （AVManager.java:372-379），判据是 `requiresAudioFocus()`
 *      （SimpleExoPlayerData.java:253-256）。
 *      `pauseAsync()` 把 `mShouldPlay` 置 false ⇒ 判据为假 ⇒
 *      **焦点被真正放弃**（AVManager.java:362-369，mAcquiredAudioFocus=false）
 *   ④ 下一声 `playAsync()` 必须**重新向系统申请焦点**
 *      （SimpleExoPlayerData.java:145-159 的 playPlayerWithRateAndMuteIfNecessary）
 *   ⑤ 只要这次申请没拿到（AVManager.java:339-360 的三个失败分支：
 *      未启用 / App 被判为后台 / 系统返回非 GRANTED），就**抛**
 *      `AudioFocusNotAcquiredException`，而抛出点在第 151 行——
 *      紧随其后的 154~158 行（**更新音量**、**setPlayWhenReady**）
 *      **全部被跳过**
 *      ⇒ 播放器保持上一次遗留的音量（已是 0f，因为 ③ 之前的
 *        `getVolumeForDuckAndFocus` 对无焦点一律返回 0f，AVManager.java:381-383）
 *      ⇒ **播放头从不推进，声音永远不出现**
 *   ⑥ JS 侧看到的是 `E_AV_SETSTATUS` 拒绝。旧实现把这条异常吞掉或
 *      重试，而重试又走同一条申请路径 ⇒ **每一次重试都同样无声**。
 *
 * 也就是说：旧实现里「预热 → 重发 → 自检 → 再重发」这一整套，
 * 是在一条**注定抛异常**的路径上反复打转，永远不可能出声。
 *
 * 三、历史真机取证其实早就指向这里，只是被误读了
 * ---------------------------------------------------------------------------
 * v3 头注释记录的失败签名是：
 *     AT::add … FrmRdy 19008 → AT::remove … G db=-inf … FrmRdy 19008
 *     （缓冲帧数**完全不变**、增益 **-inf**、整段素材被 Flushed 丢弃）
 * 「增益 -inf」= 播放器音量被置 0；「缓冲帧数一动不动」= `setPlayWhenReady`
 * 从未被调用。这两个特征与上面第 ⑤ 步**完全吻合**，
 * 当时却因为"紧接着的下一声又正常"而被归因为「首次入混的竞态」。
 * 真正的规律是：**只要焦点申请成功就有声，失败就必然全程静音**。
 *
 * 四、本版（v5）的架构：持有式实例环 + 不放弃焦点
 * ---------------------------------------------------------------------------
 * 核心不变式只有一条：
 *
 *     ★ 只要音效处于「已装载且需要焦点」的状态，就绝不让它进入不需要焦点的状态。
 *
 * 具体做法：
 *   1. **永不对音效调用 `pauseAsync()`**。素材播完后只用
 *      `setPositionAsync(0)` 回到开头。该调用**不碰 `mShouldPlay`**
 *      ⇒ `requiresAudioFocus()` 恒为真 ⇒ 上面第 ②③ 步的"放弃焦点"
 *      **永远不会发生** ⇒ 焦点在整局内只申请一次、一直持有。
 *   2. 预载时为每个音效建一组**实例环**（短音效 4 个），按环形游标取用。
 *      连响（我方走子 → AI 应招，间隔 300ms 而素材 275~406ms）
 *      天然落在不同实例上，互不打断，也不再需要 v3 那套"预热交接超时"。
 *   3. **`playAsync()` 的 reject 就是全部需要的失败信号**。
 *      按第 ⑤ 步，只要它 resolve，`updateVolumeMuteAndDuck()` 就必然已经
 *      在 `mAcquiredAudioFocus === true` 的状态下执行过，音量必然是 1.0
 *      ⇒ **不存在"resolve 了却仍然听不见"的情形**。
 *      因此可以**删掉整套播放头自检**，260ms 检测延迟随之消失。
 *      失败时换一个实例重试（最多 3 次）并复位音频模式，
 *      这是针对焦点申请的**真实**恢复手段，而不是重发同一条已坏的音轨。
 *   4. 生命周期改为**引用计数**（`acquireSoundSession` / `releaseSoundSession`）。
 *      旧实现是「模块级全局状态 + 每个屏幕各自在 useEffect([]) 清理里
 *      `unloadAllSounds()`」，而导航用 `router.push` 会在一个 Stack 上叠出
 *      多个会发声的屏（lanGame/index.tsx:357,379,447,518）：先弹出的那屏
 *      的清理会拆掉**仍在挂载**的那些屏的音频，且它们不会重新预载
 *      ⇒ 越走越哑。引用计数保证"最后一个使用者离开才释放"。
 *
 * 五、跨端说明
 * ---------------------------------------------------------------------------
 * 本工程既有真机（Android）也有 Web（expo dev:web）。Web 端 expo-av 走
 * HTMLAudioElement，没有上面的焦点机制；本版的 `setPositionAsync(0) + playAsync()`
 * 在 Web 上同样有效，且**不再需要** v3 为绕开「Web 的 setStatusForMedia 不处理
 * volume」而加的补拉音量分支。Web 与真机共用同一条代码路径，无需分叉。
 *
 * ===========================================================================
 * v7：真机取证第三次更正——真正的根因是「音频被切到电话通信路由」
 * ===========================================================================
 * 前两版的推断都被设备数据推翻了，这一版才是最终结论。
 *
 * v6 曾依据「扬声器 -49dB、AT::add 增益 -inf」判断是
 * 「起播瞬间设备未就绪导致音量写不进去」，据此加了补推 playAsync。
 * **真机 dumpsys audio 显示了那一切的真正来源**：
 *
 *     setCommunicationRouteForClient for uid: 10430 device: type:speaker
 *       from API: setSpeakerphoneOn(true) from u/pid:10430/12898
 *     updateCommunicationRoute, preferredCommunicationDevice: type:speaker
 *
 * 即：**本应用自己把音频路由切到了通信扬声器**。它同时解释了此前所有异常——
 * 输出线程出现 `AUDIO_OUTPUT_FLAG_INCALL_MUSIC`、出现 earpiece 输出线程、
 * 音轨 `AT::add` 增益 -inf、扬声器端只剩 -49dB（通信路由下的音效走的是
 * 电话听筒的音量曲线，本来就不该从媒体扬声器出声）。
 * 补推多少次 playAsync 都没用：路由不对，增益永远算不对。
 *
 * 触发链（expo-av 16.0.8，AVManager.java）：
 *   JS `Audio.setAudioModeAsync(payload)`
 *     → AVManager.setAudioMode(map)                          :406
 *     → if (map.containsKey(PLAY_THROUGH_EARPIECE))         :413 ← 只要 key 存在就进
 *     → updatePlaySoundThroughEarpiece(mShouldRouteThroughEarpiece) :415
 *     → mAudioManager.setMode(...)                          :393
 *     → mAudioManager.setSpeakerphoneOn(true)               :394 ← 元凶
 *
 * **关键**：写成 `playThroughEarpieceAndroid: false` 同样会触发上述整条链，
 * 只是把开关拨到另一个方向。唯一安全的做法是**不在 payload 里放这个 key**。
 *
 * 因此 v5 关于「焦点」的结论、v6 关于「设备延迟就绪」的结论都不成立：
 *   · 焦点：真机 requestAudioFocus 是 req=3 且申请成功，从未失败；
 *   · 增益补推：路由被切到通信路由时，重算多少次都是通信路由的音量。
 * 两者都在处理症状，没有触及路由这个根因。
 */

import { Audio } from 'expo-av';
import { AppState, type AppStateStatus } from 'react-native';

/** 音效名 → 素材。key 必须与 assets/sounds 下的文件名（不含扩展名）一致。 */
const SOURCES: Record<string, number> = {
  select: require('@/assets/sounds/select.mp3'),
  go: require('@/assets/sounds/go.mp3'),
  eat: require('@/assets/sounds/eat.mp3'),
  goerror: require('@/assets/sounds/goerror.mp3'),
  gamewin: require('@/assets/sounds/gamewin.mp3'),
  gamelose: require('@/assets/sounds/gamelose.mp3'),
  alarm: require('@/assets/sounds/alarm.mp3'),
  Man_jiangjun: require('@/assets/sounds/Man_jiangjun.wav'),
  Woman_jiangjun: require('@/assets/sounds/Woman_jiangjun.wav'),
};

/**
 * 短音效（走子/吃子/选子/走错）的实例环大小。
 *
 * ⚠️ 真机取证（华为 PTP-AN10 / Android 17，2026-10）后**由 4 改为 2**：
 * 每个 AudioTrack 都要向AudioPolicy 申请一个输出设备，而该机型上
 * **同时存活 18 个实例时有 12 个拿不到设备**（`deviceIds:[]`），
 * 那些实例的增益恒为 -inf、永远推不动播放头，等于白建。
 * 2 个实例已足够覆盖「我方走子（~300ms）→ 300ms 后 AI 应招」这一最短连响，
 * 且把常驻实例数压到系统能全部分配的水平。
 */
const SHORT_RING_SIZE = 2;

/** 长音效（胜负语音、将军语音）的实例环大小：这类素材本身就很长，不需要并发。 */
const LONG_RING_SIZE = 1;

/** 短音效名单。放在这里的走"实例环"策略。 */
const SHORT_SOUNDS = new Set(['select', 'go', 'eat', 'goerror']);

/**
 * 素材播完后额外占用的时间（毫秒）。
 *
 * ExoPlayer 在 STATE_ENDED 才真正结束，但 seek 回 0 的时机略晚于
 * 「最后一帧出声」。留一点余量，避免在尾音还没走完时就把实例判为可用
 * 而截断连响。
 */
const TAIL_GUARD_MS = 140;

/** 同一音效的连播请求之间的最小间隔（毫秒）。 */
const SAME_SOUND_MIN_INTERVAL_MS = 40;

/** 单次播放失败后重试的最大次数（每次换一个实例）。 */
const MAX_PLAY_ATTEMPTS = 3;

/** 失败重试前的等待时间：给系统一点时间完成焦点的授予/回收。 */
const RETRY_BACKOFF_MS = 60;

/**
 * 起播后「补推音量」的重试间隔（毫秒）。
 *
 * 这是本版最关键的一处修复。真机取证（华为 PTP-AN10 / Android 17）：
 *   · 扬声器输出线程的信号功率在每次音效播放时稳定在 **-49dB**，
 *     而正常播放应在 0dB 附近 ⇒ 声音"有信号但小到听不见"；
 *   · 同期 dumpsys media.audio_flinger 里我们进程的音轨
 *     `AT::add` 时 `G db` 就是 **-inf**，`FrmCnt` 在 add 时为 0；
 *   · 18 个常驻实例里有 12 个 `deviceIds` 为空，即拿不到输出设备。
 *
 * 成因：原生把 JS 请求的音量写入播放器的**唯一**路径是
 * `SimpleExoPlayerData.updateVolumeMuteAndDuck()`，而它**只在
 * playAsync() 内部被调用一次**（SimpleExoPlayerData.java:154）。
 * 那一刻 ExoPlayer刚起播，AudioPolicy 还没给这条 AudioTrack 分配输出设备，
 * gain 算出来是 -inf；等设备分配完成，原生**不会**再重算一次音量，
 * 音量就此永久停在近静音状态。
 *
 * 而 `setVolumeAsync()` 走的是 setStatus → applyNewStatus，
 * **不会**触发 updateVolumeMuteAndDuck，所以单靠它无效；
 * 必须让播放器**再走一次 playAsync**（即再进一次
 * playPlayerWithRateAndMuteIfNecessary）才会重算并写入真实音量。
 *
 * 时点选取：实测设备就绪要 200~400ms，故窗口取到 500ms，
 * 覆盖低端机最慢的情况；这些都是 setTimeout 异步补推，
 * **不阻塞** playSound 返回，也不推迟起播。
 */
const VOLUME_REINFORCE_DELAYS_MS = [0, 90, 220, 360, 500];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 环中的一个实例。 */
type Slot = {
  sound: Audio.Sound;
  /** 该实例的素材时长（ms），装载后从 status 读出。 */
  durationMs: number;
  /** 在此时刻之前该实例视为"正在占用"。 */
  busyUntil: number;
};

/** 某个音效的实例环。 */
type Ring = {
  slots: Slot[];
  /** 环形游标，保证取用均匀分布而不是扎堆同一实例。 */
  cursor: number;
  /** 上一次起播时刻，用于「同一音效最小间隔」节流。 */
  lastPlayAt: number;
};

// ---------------------------------------------------------------------------
// 模块级状态
// ---------------------------------------------------------------------------

const rings = new Map<string, Ring>();

/** 正在装载中的环，避免并发重复装载。 */
const ringTasks = new Map<string, Promise<Ring | null>>();

/** 引用计数：还有几个使用者在占用音频（见 acquireSoundSession）。 */
let sessionRefs = 0;

/** 会话代号：最后一个使用者释放时自增，令在途的播放请求自行作废。 */
let sessionId = 0;

let audioModeReady = false;

let appStateBound = false;

/**
 * 在途的「补推音量」定时器。
 *
 * 卸载全部音效时必须把它们清掉：否则已卸载的实例还会被继续下指令，
 * 既浪费 native 调用，也会在会话作废后又把音量写到不该存在的播放器上。
 */
const activeReinforceTimers = new Set<Array<ReturnType<typeof setTimeout>>>();

// ---------------------------------------------------------------------------
// 音频模式
// ---------------------------------------------------------------------------

/**
 * 下发音频模式。幂等；失败时会把标记复位，下次调用会重试。
 *
 * ⚠️ **绝不传 `playThroughEarpieceAndroid`**（2026-10-17 真机取证，第三次）。
 * 只要 payload 里出现这个 key，expo-av 就会立刻执行
 * `AVManager.updatePlaySoundThroughEarpiece()`（AVManager.java:414-415），
 * 而该函数**无论取值真假都会**：
 *       mAudioManager.setMode(...);            // 切音频模式
 *       mAudioManager.setSpeakerphoneOn(true); // 切到通信扬声器
 * 即使写成 `false` 也一样触发——开关被拨动了，只是拨到另一个方向。
 *
 * 真机 dumpsys audio 抓到的现场（uid 10430 = 本应用）：
 *       setCommunicationRouteForClient ... type:speaker
 *         from API: setSpeakerphoneOn(true) from u/pid:10430/12898
 *       updateCommunicationRoute, preferredCommunicationDevice: type:speaker
 * 后果是音频被切到**电话通信路由**：输出线程出现
 * `AUDIO_OUTPUT_FLAG_INCALL_MUSIC`、音轨 `AT::add` 时增益为 -inf、
 * 扬声器端只剩 -49dB 的近静音信号 —— 也就是用户听不到的根因。
 * 前两版（v5 的焦点问题、v6 的增益补推）方向都不对，这条才是。
 *
 * 另外 `shouldDuckAndroid: false` 也是必需的：它让原生把
 * mIsDuckingAudio 置 false，避免被导航音/提示音压低半音量。
 */
async function ensureAudioMode(): Promise<void> {
  if (audioModeReady) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: false,
      staysActiveInBackground: false,
    });
    audioModeReady = true;
  } catch (e) {
    console.warn('[SoundManager] setAudioModeAsync 失败，下次播放时重试:', e);
  }
}

/**
 * 焦点申请失败后的复位：重新下发一次音频模式。
 *
 * `expo-av` 没有暴露"重新申请焦点"的 API。能做的最有价值的动作是
 * 重下发音频模式——它会让原生走一遍 `setAudioMode`，从而对所有播放器
 * 重新计算一次 duck 音量（`updateDuckStatusForAllPlayersPlaying`）。
 * 再配合换实例重试，覆盖绝大多数瞬时的焦点竞争。
 */
async function resetFocusForRetry(): Promise<void> {
  audioModeReady = false;
  await ensureAudioMode();
}

// ---------------------------------------------------------------------------
// AppState：回到前台时复位，便于系统把焦点还回来
// ---------------------------------------------------------------------------

function bindAppState(): void {
  if (appStateBound) return;
  appStateBound = true;
  AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') {
      // 后台期间原生会把 mAppIsPaused 置 true 并放弃焦点（AVManager.java:246-261）。
      // 回到前台时把音频模式复位，让下一次播放重新走一遍申请。
      void resetFocusForRetry();
    }
  });
}

// ---------------------------------------------------------------------------
// 实例环
// ---------------------------------------------------------------------------

function ringSizeOf(name: string): number {
  return SHORT_SOUNDS.has(name) ? SHORT_RING_SIZE : LONG_RING_SIZE;
}

/** 装载单个实例。 */
async function createSlot(name: string): Promise<Slot | null> {
  const source = SOURCES[name];
  if (source === undefined) return null;
  try {
    const { sound } = await Audio.Sound.createAsync(source);
    // 音量必须显式置 1：原生在没有焦点时会把生效音量压到 0f，
    // 而我们要保证「装好即音量正常」。
    await sound.setVolumeAsync(1);
    let durationMs = 0;
    try {
      const st = await sound.getStatusAsync();
      // AVPlaybackStatus 是联合类型，只有 isLoaded 为真时才有 durationMillis
      if (st.isLoaded && typeof st.durationMillis === 'number') {
        durationMs = st.durationMillis;
      }
    } catch {
      /* 读不到时长不影响播放，退化成 TAIL_GUARD_MS 的下限 */
    }
    return { sound, durationMs, busyUntil: 0 };
  } catch (e) {
    console.warn(`[SoundManager] 装载音效 '${name}' 失败:`, e);
    return null;
  }
}

/** 建（取）某个音效的实例环。 */
async function getRing(name: string): Promise<Ring | null> {
  const existing = rings.get(name);
  if (existing) return existing;

  const inflight = ringTasks.get(name);
  if (inflight) return inflight;

  // 记录本次装载起始时的会话代号。若装载途中整个音频被卸载（会话自增），
  // 这些刚建好的原生播放器会随 unloadAllSounds 一起被卸载，
  // 此时**不能**把它们再登记进 rings —— 那会留下一圈"已卸载却仍被引用"的死实例。
  const buildSession = sessionId;

  const task = (async (): Promise<Ring | null> => {
    const size = ringSizeOf(name);
    const slots: Slot[] = [];
    for (let i = 0; i < size; i++) {
      const slot = await createSlot(name);
      if (slot) slots.push(slot);
    }
    ringTasks.delete(name);

    // 会话已变更：这些实例已经（或即将）被 unloadAllSounds 释放，就地卸掉并放弃。
    if (buildSession !== sessionId) {
      await Promise.all(
        slots.map((s) =>
          s.sound.unloadAsync().catch(() => {
            /* 卸载失败忽略 */
          })
        )
      );
      return null;
    }

    if (slots.length === 0) return null;
    const ring: Ring = { slots, cursor: 0, lastPlayAt: 0 };
    rings.set(name, ring);
    return ring;
  })();

  ringTasks.set(name, task);
  return task;
}

/** 从环里取一个可用实例：优先空闲，其次取最早空闲的那个。 */
function acquireSlot(ring: Ring): Slot {
  const now = Date.now();
  let chosen: Slot | null = null;

  for (let i = 0; i < ring.slots.length; i++) {
    const idx = (ring.cursor + i) % ring.slots.length;
    const slot = ring.slots[idx];
    if (slot.busyUntil <= now) {
      chosen = slot;
      ring.cursor = (idx + 1) % ring.slots.length;
      break;
    }
  }

  if (!chosen) {
    // 全都占着（极少见）：拿最早空闲的那个，宁可截断也不静默。
    chosen = ring.slots.reduce((a, b) => (a.busyUntil <= b.busyUntil ? a : b));
    ring.cursor = (ring.slots.indexOf(chosen) + 1) % ring.slots.length;
  }

  chosen.busyUntil = now + Math.max(chosen.durationMs, TAIL_GUARD_MS) + TAIL_GUARD_MS;
  return chosen;
}

/** 某音效是否还有可用（已装载的）实例。 */
function hasRing(name: string): boolean {
  return rings.has(name);
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

/**
 * 起播并**确保音量真的落到播放器上**。抛出的异常由调用方处理（换实例重试）。
 *
 * 起播后必须在多个时点**重复触发一次 playAsync()**：每触发一次，
 * 原生都会重跑一遍 playPlayerWithRateAndMuteIfNecessary()，
 * 其中的 updateVolumeMuteAndDuck() 才会把当前音量写进播放器。
 * 起播瞬间 AudioPolicy 往往还没分配输出设备（deviceIds 为空），
 * 那一次算出来的增益是 -inf；稍后再触发一次，设备已就绪，
 * 增益才恢复正常（成因与真机数据见VOLUME_REINFORCE_DELAYS_MS 的注释）。
 *
 * 注意这里用的是 playAsync() 而不是 setVolumeAsync()：
 * 后者走 setStatus → applyNewStatus，**不会**调用
 * updateVolumeMuteAndDuck，写进去的值不会生效。
 */
async function startSlot(slot: Slot, isAlive: () => boolean): Promise<void> {
  // 回到开头：素材播完后播放器停在 STATE_ENDED，此时把 playWhenReady
  // 重新置 true **不会**让它继续播，必须先 seek 离开 ENDED。
  //
  // ⚠️ 这里刻意**不用** pauseAsync()：它会连带把 mShouldPlay 置 false，
  // 从而让 requiresAudioFocus() 为假、原生在 setStatus 收尾时放弃音频焦点
  // （PlayerData.java:377 → AVManager.java:372-379）。
  // setPositionAsync 只传 positionMillis，不碰 mShouldPlay，焦点得以保留。
  await slot.sound.setPositionAsync(0);
  await slot.sound.playAsync();

  // 补推音量：不 await 整段，避免把音效的起播延迟到 500ms 之后。
  // 每一步都在会话仍有效时才动手，防止给已卸载的实例继续发指令。
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  for (const delay of VOLUME_REINFORCE_DELAYS_MS) {
    if (delay === 0) continue; // 第 0 次就是上面那次 playAsync
    const timer = setTimeout(() => {
      if (!isAlive()) return;
      // 只重播当前位置，不回到开头：此时播放头正处在素材中段，
      // 再 seek 一次反而会把已经播出的部分截掉、并可能让重播超过素材末尾。
      void slot.sound.playAsync().catch(() => {
        /* 补推失败无所谓：真正的兜底是外层的换实例重试 */
      });
    }, delay);
    timers.push(timer);
  }

  // 最后一个定时器负责把这一组从注册表里摘掉，避免 Set 无限增长。
  // 必须与补推定时器**放在同一个数组**里，否则 unloadAllSounds
  // 清空注册表后，这个清理定时器仍会存活并对已卸载的实例做计数。
  const lastDelay = VOLUME_REINFORCE_DELAYS_MS[VOLUME_REINFORCE_DELAYS_MS.length - 1];
  timers.push(
    setTimeout(() => {
      activeReinforceTimers.delete(timers);
    }, lastDelay + 50)
  );

  activeReinforceTimers.add(timers);
}

/**
 * 播放一个音效。**永不抛出**。
 *
 * 失败语义（依据 SoundManager 头注释第二节第 ⑤ 步）：`playAsync()` 的
 * reject 意味着原生没能拿到音频焦点，因而既没有更新音量、也没有开始播放。
 * 这时换另一个实例重试，并复位音频模式。
 */
export async function playSound(name: string): Promise<void> {
  try {
    await ensureAudioMode();
    bindAppState();

    const mySession = sessionId;
    if (!hasRing(name)) {
      // 首次触发时这个音效还没预载（例如将军语音只在将军时才用到）。
      // 现场装一个环再播，保证"任何时候任何音效都能响"。
      await getRing(name);
    }

    for (let attempt = 0; attempt < MAX_PLAY_ATTEMPTS; attempt++) {
      if (mySession !== sessionId) return; // 会话已结束，丢弃过期请求
      const ring = rings.get(name);
      if (!ring) return;

      // 同一音效的连播做最小间隔节流：短时间内的重复请求只保留最后一个，
      // 避免玩家快速连点时把实例环搅乱。
      const now = Date.now();
      if (now - ring.lastPlayAt < SAME_SOUND_MIN_INTERVAL_MS) {
        await sleep(now + SAME_SOUND_MIN_INTERVAL_MS - ring.lastPlayAt);
      }
      if (mySession !== sessionId) return;
      ring.lastPlayAt = Date.now();

      const slot = acquireSlot(ring);
      try {
        await startSlot(slot, () => mySession === sessionId);
        return; // resolve 即代表这一遍确实在出声（见头注释第四节第 3 点）
      } catch (e) {
        console.warn(`[SoundManager] 播放 '${name}' 第 ${attempt + 1} 次失败（多为音频焦点未获批），换实例重试:`, e);
        await resetFocusForRetry();
        await sleep(RETRY_BACKOFF_MS);
      }
    }
    console.warn(`[SoundManager] 播放 '${name}' 连续 ${MAX_PLAY_ATTEMPTS} 次失败，放弃。`);
  } catch (e) {
    console.warn(`[SoundManager] playSound '${name}' 异常:`, e);
  }
}

/** 将军语音。内部自带节流，避免连将时反复触发。 */
let jiangJunLastAt = 0;
const JIANGJUN_MIN_INTERVAL_MS = 1200;

export async function playJiangJunSound(): Promise<void> {
  const now = Date.now();
  if (now - jiangJunLastAt < JIANGJUN_MIN_INTERVAL_MS) return;
  jiangJunLastAt = now;
  await playSound('Man_jiangjun');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/** 预载常用音效（对局必经的几条）。重复调用安全。 */
export async function preloadSounds(): Promise<void> {
  await ensureAudioMode();
  bindAppState();
  // 串行装载：并发 createAsync 会在原生侧同时拉起多条解码器，
  // 低端机更容易触发首播卡顿；串行反而更稳，总耗时也可忽略
  // （素材总计约 50KB）。
  for (const name of ['select', 'go', 'eat', 'goerror']) {
    await getRing(name);
  }
}

/** 预载胜负语音。对局中途才会用到，单独提供。 */
export async function preloadGameEndSounds(): Promise<void> {
  await ensureAudioMode();
  bindAppState();
  for (const name of ['gamewin', 'gamelose']) {
    await getRing(name);
  }
}

/**
 * 占用音频会话（引用计数 +1）。
 *
 * 各对局屏在 `useEffect` 里调用它替代原来的 `preloadSounds()`。
 * 第一个使用者会完成预载；后续使用者只增加计数，**不会**重新装载。
 */
export async function acquireSoundSession(): Promise<void> {
  bindAppState();
  if (sessionRefs === 0) {
    await preloadSounds();
    await preloadGameEndSounds();
  } else {
    // 已有会话：只确保音频模式可用，不重装实例环。
    await ensureAudioMode();
  }
  sessionRefs++;
}

/**
 * 释放音频会话（引用计数 -1）。
 *
 * 只有**最后一个**使用者离开时才真正卸载全部实例。
 * 这一条是 v5 修掉的另一个独立缺陷：旧实现里每个对局屏各自在
 * `useEffect([])` 清理中调用 `unloadAllSounds()`，而导航用的是
 * `router.push`，同一个 Stack 上可以叠着多个会发声的屏；先弹出的那屏
 * 的清理会拆掉仍在挂载的屏的音频，且它们不会重新预载 ⇒ 越走越哑。
 */
export async function releaseSoundSession(): Promise<void> {
  if (sessionRefs === 0) return;
  sessionRefs--;
  if (sessionRefs > 0) return;
  await unloadAllSounds();
}

/**
 * 卸载全部音效资源。仅在最后一个会话释放时由 releaseSoundSession 调用。
 *
 * 自增 sessionId 有双重作用：① 让在途 playSound 请求自行作废；
 * ② 让在途的 getRing 装载任务识别出"会话已变更"，把刚建好但已无处安放的
 *    实例就地卸载（见 getRing 里的 buildSession 守卫），
 *    从而不会留下"已卸载却仍被 rings 引用"的死实例。
 */
export async function unloadAllSounds(): Promise<void> {
  sessionId++;
  ringTasks.clear();

  // 取消在途的补推音量定时器：会话已作废，且实例即将被卸载，
  // 再往下发指令只会打到不存在的播放器上。
  for (const timers of activeReinforceTimers) {
    for (const t of timers) clearTimeout(t);
  }
  activeReinforceTimers.clear();

  const pending: Promise<unknown>[] = [];
  for (const [, ring] of rings) {
    for (const slot of ring.slots) {
      pending.push(
        slot.sound.unloadAsync().catch(() => {
          /* 卸载失败忽略 */
        })
      );
    }
  }
  rings.clear();

  await Promise.all(pending);
}

// 刻意**不提供** stopSound() / unloadSound() 这类"只暂停不卸载"的接口。
// 它们唯一能用的实现就是 pauseAsync()，而那会放弃音频焦点（见头注释第二节
// 第 ③ 步），正是本版要消灭的故障源。v4 留下的 stopSound 全工程无调用点，
// 删除它比留着更安全——省得日后有人把它接回音效编排里。

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/**
 * 供回归测试观察池状态的只读快照。
 *
 * 返回值是「各音效的实例数」；v3/v4 的同名钩子返回的是可用库存，
 * 这里改成返回实例总数——v5 不再有"借出/归还"的概念，实例始终可用。
 */
export function __debugPoolSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, ring] of rings) out[name] = ring.slots.length;
  return out;
}

/** 测试用：当前引用计数。 */
export function __debugSessionRefs(): number {
  return sessionRefs;
}