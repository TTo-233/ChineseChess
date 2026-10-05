/**
 * ===========================================================================
 * 音效播放管理（含真机无声问题的修复，第三次迭代）
 * ===========================================================================
 *
 * 一、判定方法（真机取证）
 * ---------------------------------------------------------------------------
 * 本项目 APK 是 release 构建，应用进程不输出任何 logcat（`run-as` 被拒），
 * 因此只能从系统音频栈取证：
 *   1. `dumpsys media.audio_flinger` 里 AudioOut_15 输出线程的 `AT::add/<...>/
 *      AT::remove/removeTrack_l` 历史 —— 按每行自己的时间戳排序后，
 *      用 `AT::add` 与同一个 track 指针的 `AT::remove` 配成一次播放。
 *      注意该 dump 是按音轨分组、**不是**按时间排序的。
 *   2. 同一个线程 `Hal stream dump:` 里的 `Signal power history`（HAL 自己测得
 *      的输出功率），这是"到底有没有声音出来"的唯一直接证据。
 *   3. 判定"这一步有没有真的落子"必须看 UI：`uiautomator dump` 里的
 *      `第 N 回合` 文本 + move 前后截图（漏点棋盘与"无声"在日志上完全一样）。
 * 字段口径（AudioOut_15 的列图例）：
 *   Type Id Active Client(pid/uid) Session Port Id S Flags Format Chn mask
 *   SRate ST Usg CT G db L dB R dB VS dB PortVol dB PortMuted Server
 *   FrmCnt FrmRdy F Underruns Flushed BitPerfect InternalMute Latency
 *   → `[25]`=FrmCnt（缓冲容量）、`[26]`=FrmRdy（当前已缓冲帧数，**不是**已写帧数，
 *     它是会减少的）、`[11]`=Flags、`[18]`=G db、`[22]`=Flushed。
 *
 * 二、实测结论：失败的是「一条 AudioTrack 的首次入混」
 * ---------------------------------------------------------------------------
 * 12 次冷启动、每次只走一步棋（同一台 HONOR PTP-AN10 / Android 17），
 * 11 次有声、1 次无声（≈9%，对应用户说的"一定概率"）。两种签名：
 *   有声（第一次播放）：
 *     AT::add  ... A 0x000 ... FrmRdy 7006  ... new
 *     AT::remove ... S 0x600 ... G db=-22 ... FrmRdy 0 ... Flushed 0
 *     + 该秒 HAL Signal power history 有 `[ -45.4 ] sum(4.4)` 这类条目
 *   无声（同一次进程里、人的第一步）：
 *     AT::add  ... A 0x000 ... FrmRdy 19008 ... new
 *     AT::remove ... A 0x008 ... G db=-inf ... FrmRdy 19008（完全没变）
 *     removeTrack_l ... T 0x208 ... Flushed=19008（整段素材被丢弃）
 *     + 那一秒 HAL Signal power history **没有任何条目**
 * 紧接着同一条音轨的下一次播放（AI 应招，1.6 秒后）完全正常。
 * 另一批 20 次冷启动 × 3 步棋的统计（46 次播放、5 次无声）给出了更关键的对照：
 * 所有无声播放的通道掩码都是 `00000001`（单声道，即 eat.mp3 —— 本工程唯一被调用
 * 的单声道素材），而同一次进程里反复播放的立体声 go.mp3 一次都没失败。
 * 更直接的证据来自同一个进程内的交替（.dsh-work/reps/fl_rp_1.txt）：
 *   失败：add rdy=13248 → remove state=A flags=0x008 G db=-inf rdy=13248（约 1.0 秒）
 *   成功：add rdy=0     → remove state=S flags=0x600 G db=-22  rdy=0    （约 0.5 秒）
 * 同一个素材可以一次失败、下一次成功。
 * ⇒ 这是一次"这一遍没被混音器拉起来"的竞态：失败的音轨缓冲帧数完全不变、
 *   增益一直是 -inf、HAL 无输出，而同一个素材的下一次播放又正常。
 *   因此修复不需要（也不应该）精确复刻成因：把首次入混消耗掉（预热）+ 没出声
 *   就重发（进度自检），两条腿都指向"用户听到的那一遍一定是真的在推进的那一遍"。
 * 走子/吃子/将军是三条不同的音轨/素材，因此各自的"第一个音效"都可能被吞。
 *
 * 三、为什么上一版（v2）没修好
 * ---------------------------------------------------------------------------
 * v2 的起播自检读的是 `getStatusAsync()` 的 `didJustFinish` / `isPlaying`，两者
 * 在无声场景下都恒为"成功"：
 *   - `didJustFinish` **只存在于 push 回调**（`PlayerData.java:259-263
 *     callStatusUpdateListenerWithDidJustFinish()`），`getStatus()` 里永远没有
 *     这个 key，所以 `after.didJustFinish` 恒为 undefined；
 *   - `isPlaying` = `getPlayWhenReady() && getPlaybackState() == STATE_READY`
 *     （`SimpleExoPlayerData.java:205-220`），音轨卡死并不改变这两个值。
 * ⇒ v2 的自检永远不会判定失败，也就永远不会重试。v2 实测确实无效。
 *
 * 四、本版（v3）的两个手段
 * ---------------------------------------------------------------------------
 * 1) 静音预热（治本，针对第二节）：每条音效在**真正播放之前**先做一次
 *    「音量 0 的起播探测」，把这条音轨的"首次入混"消耗在无声状态；此后用户
 *    听到的那一遍是这条音轨的第二次入混——实测第二次从未失败。
 *    音量 0 播放不会出声（原生 `getVolumeForDuckAndFocus` 直接给 0f）。
 *    **【C-82】此处只探测"播放头是否推进"（≤560ms），不等整段播完**——
 *    早期版本等整段播完，那正是"第一步音效慢一拍"的直接原因，见第六节。
 * 2) 进度自检（兜底，针对任何残余的卡死）：`positionMillis` 是原生真实播放头
 *    位置（`getExtraStatusFields` 直接取 `mSimpleExoPlayer.getCurrentPosition()`），
 *    卡死的音轨永远推不动。起播 260ms 后至少推进 20ms 才算出声，否则原地
 *    重发一次「pause → setPosition(0) → play」（真机日志显示正是这一组操作让
 *    卡死的音轨被拆除并重新入混、随后正常出声），仍然不行才换新播放器。
 *
 * 五、已经排除的原因（都做过真机取证，不要再往这些方向改）
 * ---------------------------------------------------------------------------
 * A. 素材损坏：7 个 mp3 按 MPEG-1 Layer III 逐帧解码可到文件尾、Xing 头声明的
 *    字节数与文件大小一致；2 个 wav 是合法 PCM s16le 44.1kHz。
 * B. 打包丢文件 / 装的是旧代码：安装包 `res/` 下 9 个音频资源与磁盘字节数一致；
 *    用 Hermes bundle 的 UTF-16LE 字符串表（注意：Hermes 字符串是 **UTF-16LE**，
 *    按 UTF-8 搜恒为 0）可确认改动确实进了安装包。
 * C. 第二个音频消费者：全工程只有本文件 import expo-av。
 * D. 系统音量：`STREAM_MUSIC streamVolume:7`、未静音；无声那次 `mutedState:none`。
 * E. 焦点被拒：焦点栈顶始终是 `expo.modules.av.AVManager`、
 *    `GAIN_TRANSIENT_MAY_DUCK`、`loss: none`，且每次播放都有
 *    `requestAudioFocus() ... req=3`。
 * F. 进入棋盘后的下滑手势 / 等待时长：8 次冷启动的 2×2 对照（有无下滑 × 800ms
 *    /3000ms）里 7 次有声，与这两个变量无关。
 *
 * 六、【C-82】"第一步音效慢一拍"（2026-10 实机）：不是混音竞态，是预热阻塞
 * ---------------------------------------------------------------------------
 * 现象：退出重进人机对战，我方先手第一步的走子音**总是**慢半拍；不退出、
 * 局内重开则正常。
 *
 * 这不是第二节那个随机竞态（那个表现为"约 9% 无声"），而是一个**确定性阻塞**：
 * `preloadSounds()` 在进入对局时就为四条常用音轨各起一次预热，而旧实现的预热
 * 要**听完整个素材**才结束（go.mp3 470ms，最坏 470+800=1270ms）。玩家完全
 * 可能在预热还在跑的时候走出第一步，于是 `playSound()` 里
 * `await prepareSound('go')` 等的就是**那同一个尚未完成的预热 Promise**，
 * 第一步音效要等 1 秒多才响——听起来正是"慢一拍"。
 *
 * "退出重进必现、局内重开不复现"是这个解释的推论：局内重开走 `useNewGame`
 * 的纯状态重置，组件不卸载、`unloadAllSounds()` 不执行，预热早已跑完；
 * 退出再进入则重新挂载，把整套预热从头再来一遍。
 *
 * 两条修法（在同一文件内，互为前提）：
 *   a) 预热不再等整段播完，只探测播放头是否推进（≤560ms）——首次入混只需要
 *      "被拉起来"这一刻，不需要听完；
 *   b) `playSound` 不再无上限地等在途预热：只给 260ms 窗口，超时则让预热
 *      **中止**、把音轨完整交给正式播放（串行让位，不是两者抢同一个播放头）。
 *
 * 七、复测标准（重建 APK 后）
 * ---------------------------------------------------------------------------
 * 用 `.dsh-work/reps3.ps1` + `an3.py` 统计：成功 = 没有任何一次播放出现
 * `AT::remove ... A 0x008 / G db=-inf / FrmRdy 不变 / Flushed>0`，且每次播放
 * 对应的那一秒 HAL `Signal power history` 都有高于 -60dB 的条目。
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

// 常用音效（进入对局时预加载 + 静音预热）
const ESSENTIAL_SOUNDS = ['select', 'go', 'eat', 'Man_jiangjun'];

// 对局结束音效（进入对局后后台预加载 + 静音预热）
const GAME_END_SOUNDS = ['gamewin', 'gamelose'];

// 播放音量上限。createAsync / setStatusAsync 都显式传它，
// 避免原生侧残留旧音量（原生侧 updateVolumeMuteAndDuck 会按焦点状态改写音量）。
const SOUND_VOLUME = 1.0;

// 静音预热时的音量。原生 getVolumeForDuckAndFocus 对 0 直接返回 0f，
// 因此这一遍只走音轨入混流程，不会出声。
const WARMUP_VOLUME = 0.0;

// 预热探测的等待上限。预热不再等整段播完，只等「播放头真的推进」这一下——
// 这才是"首次入混已消耗"的充分判据（见文件头注释四、1 修订）。
// 必须大于真机实测的 AudioTrack 起播抖动（线程写延迟 ave≈208ms）。
const WARMUP_PROBE_DEADLINE_MS = 560;

// 预热探测轮询间隔
const WARMUP_POLL_MS = 40;

// 首步音效最多为「后台预热」等待多久（毫秒）。超时则不再等，改用已加载的对象
// 直接出声——播放头自检与重发仍然兜底，绝不能让界面等完整个预热。
const FIRST_PLAY_MAX_WAIT_MS = 260;

// 预热失败后重建播放器再预热的最大次数。
const WARMUP_MAX_ATTEMPTS = 3;

// 起播后的进度自检窗口。需大于 AudioTrack 起播抖动（真机实测线程写延迟
// ave≈208ms），又远短于最短素材（alarm 261ms）以免误判。
const PROGRESS_CHECK_MS = 260;

// 自检窗口内播放头至少要推进的毫秒数。
const PROGRESS_MIN_ADVANCE_MS = 20;

// 一遍播放最多发起几次：第 1 次正常发起，第 2 次原地重发（不重建），第 3 次换新播放器。
const PLAY_MAX_ATTEMPTS = 3;

// 重发前的退避，避免与刚卸载的原生播放器抢音频会话。
const RECREATE_DELAY_MS = 120;

// Sound 对象缓存
const soundCache = new Map<string, Audio.Sound>();
// 正在加载中的 Promise 缓存（防止重复加载）
const loadingCache = new Map<string, Promise<Audio.Sound | null>>();
// 「加载 + 静音预热」的进行中/已完成 Promise 缓存（同名并发调用共用一次预热）
const prepareCache = new Map<string, Promise<Audio.Sound | null>>();
// 已完成静音预热的音效名
const warmedNames = new Set<string>();
// 同名音效播放串行链：后到的播放等先前一遍发起完再发起，避免原生调用交错
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
    // 注意：expo-av 的 setAudioModeAsync 会把默认值补全后整体下发，其中
    // playThroughEarpieceAndroid=false 会让原生执行 setSpeakerphoneOn(true)，
    // 这是一次真实的通话路由切换；只在进程内做一次，别在播放路径里反复做。
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
 * 丢弃并卸载某个缓存音效对象（含其预热状态）。
 *
 * 只在「预热始终不成功」或「重发后仍不出声」时调用：这条音轨已经被证明
 * 入不了混，留着只会反复触发同样的失败，直接换一个新的。
 * 卸载失败无需关心 —— 对象可能已被原生侧回收，此时静默忽略即可。
 */
async function discardSound(name: string): Promise<void> {
  prepareCache.delete(name);
  // 预热任务一并作废：正在跑的预热不该再往这个名字上登记后续任务
  warmupTasks.delete(name);
  warmedNames.delete(name);
  const sound = soundCache.get(name);
  if (!sound) return;
  soundCache.delete(name);
  try {
    await sound.unloadAsync();
  } catch {
    // 忽略卸载失败
  }
}

/** 读取原生真实播放头位置（毫秒）；未加载或查询失败返回 -1。 */
async function readPosition(sound: Audio.Sound): Promise<number> {
  try {
    const status = await sound.getStatusAsync();
    if (status.isLoaded === false) return -1;
    return typeof status.positionMillis === 'number' ? status.positionMillis : -1;
  } catch {
    return -1;
  }
}

/**
 * 静音预热：让这条 AudioTrack 起来一下，把「首次入混」消耗在无声状态。
 *
 * 这是本版的核心修复（见文件头注释四、1）：真机实测"一条 AudioTrack 的首次
 * 入混"有约 9% 的概率被吞掉（音轨不消费任何数据、整段被 Flushed、HAL 无输出），
 * 而同一条音轨的第二次入混从未失败。所以把首次入混消耗在这里。
 *
 * 【C-82】2026-10 实机回归：**只等播放头推进，不再等整段播完**。
 * 原实现等到 didJustFinish（或播放头走到末尾），也就是必须听完整个素材
 * （go.mp3 470ms、最坏 470+800=1270ms）。而 preloadSounds() 在进入对局时
 * 就为四条常用音轨各起一次预热，玩家完全可能在预热还在跑的时候走出第一步，
 * 于是 playSound() 只能 await 那同一个未完成的预热 Promise——第一步音效
 * 就要等 1 秒多才响，正是用户报的"慢一拍"。退出重进必现、局内重开不复现，
 * 也正好对上：局内重开不卸载组件、不重跑预热，预热早已完成。
 *
 * 现在改为：起播后只探测播放头是否推进（WARMUP_PROBE_DEADLINE_MS 内），
 * 推进即判定"这条音轨确实入了混"，随即复位收尾。探测失败才重建播放器。
 * 首次入混只需要"被拉起来"这一刻，并不需要听完整段。
 *
 * 返回 true = 这条音轨确实入了混。
 */
async function warmUpTrack(
  name: string,
  sound: Audio.Sound,
  isAborted: () => boolean
): Promise<boolean> {
  try {
    // 起播：与正式播放同样的三步（复位 → 回开头 → 起播），确保预热本身
    // 走的就是正式播放的路径，而不是另一条容易出问题的路径。
    await sound.pauseAsync();
    await sound.setPositionAsync(0);
    await sound.setVolumeAsync(WARMUP_VOLUME);
    await sound.playAsync();

    // 探测播放头：只要它动过，就证明混音器真的在消费这条音轨的样本。
    // 不设回调——didJustFinish 只走 push 回调，且此处要的本来不是"播完"而是"入混"。
    const deadline = Date.now() + WARMUP_PROBE_DEADLINE_MS;
    while (Date.now() < deadline) {
      await sleep(WARMUP_POLL_MS);
      // 每轮检查一次是否被正式播放放弃，最迟一个轮询周期就让出这条音轨
      if (isAborted()) return false;
      if (await readPosition(sound) > 0) return true;
    }
    return false;
  } catch (e) {
    console.warn(`[SoundManager] 音效 '${name}' 静音预热异常:`, e);
    return false;
  } finally {
    try {
      // 预热期间音量是 0，必须恢复，否则之后的正式播放会一直静音。
      await sound.setVolumeAsync(SOUND_VOLUME);
      // 被放弃时不暂停/回卷：正式播放紧接着就自己做 pause → setPosition(0) → play，
      // 这里再补一刀只会把刚起播的那一遍掐掉。
      if (!isAborted()) {
        await sound.pauseAsync();
        await sound.setPositionAsync(0);
      }
    } catch (e) {
      console.warn(`[SoundManager] 音效 '${name}' 预热后复位失败:`, e);
    }
  }
}

// 正在进行的预热任务（音效名 → 任务）。用于让正式播放能中途"接管"一条音轨。
type WarmupTask = {
  promise: Promise<Audio.Sound | null>;
  /** 正式播放放弃这次预热：预热循环尽快退出，且不再复位这条音轨 */
  abort: () => void;
  /** 是否已被放弃 */
  aborted: () => boolean;
};
const warmupTasks = new Map<string, WarmupTask>();

/**
 * 加载 + 静音预热。同名调用共用同一个 Promise，避免重复预热同一条音轨。
 *
 * 预热失败会重建播放器重试（最多 WARMUP_MAX_ATTEMPTS 次）：一条入不了混的
 * 音轨只能靠换新播放器解决。全部失败时仍返回当前对象 —— 正式播放还有进度自检兜底。
 */
function prepareSound(name: string): Promise<Audio.Sound | null> {
  const running = prepareCache.get(name);
  if (running) return running;

  let aborted = false;
  const task = (async () => {
    for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
      const sound = await getOrLoadSound(name);
      if (!sound) return null;
      // 【C-82】预热期间正式播放随时可能来接管这条音轨，等 getOrLoadSound 的
      // 间隙里也要先看一眼：已经有人在用了就别再抢占。
      if (aborted) return sound;
      if (await warmUpTrack(name, sound, () => aborted)) {
        warmedNames.add(name);
        return sound;
      }
      // 预热被正式播放接管时，这条音轨马上要被拿去出声，重建毫无意义（还会打断它）
      if (aborted) return sound;
      console.warn(
        `[SoundManager] 音效 '${name}' 第 ${attempt}/${WARMUP_MAX_ATTEMPTS} 次静音预热未成功，重建播放器`
      );
      await discardSound(name);
    }
    return getOrLoadSound(name);
  })();

  prepareCache.set(name, task);
  warmupTasks.set(name, {
    promise: task,
    abort: () => {
      aborted = true;
    },
    aborted: () => aborted,
  });
  return task;
}

/**
 * 播放一遍并自检是否真的出声。返回 true = 这一遍确实在推进。
 *
 * 调用形态是刻意的：把「停顿复位」「回到开头」「开始播放」拆成三次各自 await
 * 落定的原生调用，而不是 replayAsync() 的单个 Bundle —— 后者会让 seek 与
 * setPlayWhenReady(true) 挤在同一个原生状态更新里，真机实测会把音轨卡在
 * TrackTransitionStatePaused。
 */
async function playAndVerify(sound: Audio.Sound, name: string): Promise<boolean> {
  let finished = false;
  const onStatus = (status: AVPlaybackStatus) => {
    if (status.isLoaded && status.didJustFinish) finished = true;
  };
  try {
    sound.setOnPlaybackStatusUpdate(onStatus);
    // ① 明确复位到暂停态：这一遍自己保证起点，不依赖播放器的残留状态
    await sound.pauseAsync();
    // ② 回到开头。此处 seek 发生在确切的暂停态上，可以正常完成
    await sound.setPositionAsync(0);
    // ③ 起播。这一遍的 Bundle 不含 positionMillis，原生不会发起 seek
    const status = await sound.playAsync();
    await ensureAudibleVolume(sound, name, status);

    // ④ 进度自检：用真实播放头位置判断这一遍有没有真的被混音器消费。
    //    失败样本的播放头是"冻结"的（真机上该音轨 FrmRdy 一直不变、HAL 无输出），
    //    所以判据是「读到素材末尾」或「确实在推进」，二者都不是就重发。
    const first = await readPosition(sound);
    await sleep(PROGRESS_CHECK_MS);
    const second = await readPosition(sound);
    if (second < 0) {
      console.warn(`[SoundManager] 音效 '${name}' 播放后读不到状态（视作未出声）`);
      return false;
    }
    if (finished) return true;
    const tail = await sound.getStatusAsync();
    const durationMs =
      tail.isLoaded && typeof tail.durationMillis === 'number' ? tail.durationMillis : 0;
    // 播放头到达素材末尾（原生把它裁剪在 [0, duration] 内，可以卡得很紧）
    if (durationMs > 0 && second >= durationMs - PROGRESS_MIN_ADVANCE_MS) return true;
    // 播放头确实在推进
    if (second - Math.max(first, 0) >= PROGRESS_MIN_ADVANCE_MS) return true;
    console.warn(
      `[SoundManager] 音效 '${name}' 播放头未推进（${first}ms → ${second}ms，素材 ${durationMs}ms），判定这一遍没出声`
    );
    return false;
  } catch (e) {
    console.warn(`[SoundManager] 音效 '${name}' 播放自检异常:`, e);
    return false;
  } finally {
    sound.setOnPlaybackStatusUpdate(null);
  }
}

/**
 * 预加载 + 静音预热常用音效（进入对局时调用）。
 *
 * 必须并行且尽早完成：首步落子前如果还没预热，那一步就仍会踩到"首次入混被吞"的坑。
 * 调用方不需要 await（预热期间界面照常响应），播放路径里会 await 同一个 Promise。
 */
export async function preloadSounds(): Promise<void> {
  await ensureAudioMode();
  await Promise.all(ESSENTIAL_SOUNDS.map((name) => prepareSound(name)));
}

/**
 * 预加载 + 静音预热游戏结束音效（对局进行中后台加载）
 */
export async function preloadGameEndSounds(): Promise<void> {
  await ensureAudioMode();
  await Promise.all(GAME_END_SOUNDS.map((name) => prepareSound(name)));
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
 * 原生侧 applyNewStatus() 先调 updateVolumeMuteAndDuck()（此刻焦点可能刚被
 * 放弃，音量被压到 0），之后才在 playPlayerWithRateAndMuteIfNecessary() 里
 * 拿回焦点并第二次更新音量。正常路径上音量会被纠正回来，万一没有这里兜一次。
 * 正常路径**不产生任何额外原生调用**。
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
 * 取得可立即出声的对象，尽量不等「后台预热」。
 *
 * 【C-82】预热在进入对局时就已在后台跑。若此刻预热还没结束，等待它等于让
 * 第一步音效等完整个预热（最坏 1.27s），这正是用户报的"慢一拍"。因此这里
 * 只给一个很短的等待窗口（FIRST_PLAY_MAX_WAIT_MS）：预热恰好在这段窗口内
 * 结束就等它（免费），否则**让预热中止**、直接把已加载的对象交给正式播放。
 *
 * 为什么是"中止后交接"而不是"并行各玩各的"：同一条 Audio.Sound 只能有一个播放头。
 * 并行跑的话，预热的收尾（pause + setPosition(0)）会把正式播放刚起播的那一遍掐掉，
 * 表现为"又不出声"；更隐蔽的是**音量**：预热期间音量是 0，收尾才恢复，若不等它
 * 收尾就起播，那一遍会**静音地播完**。
 *
 * 所以交接必须是有序的：先让预热退出循环，再等它把收尾做完（只是恢复音量，
 * 不再动播放头），然后才把这条音轨交给正式播放。预热退出循环最多等一个轮询周期
 * （WARMUP_POLL_MS=40ms），交接的代价远小于整段素材（go.mp3 470ms）。
 *
 * 放弃预热只意味着"这条音轨的首次入混没被成功预消费掉"——正式播放这一次会
 * 自己承担首次入混，失败概率约 9%，由 playAndVerify 的播放头自检 + 重发兜底。
 * 换来的是：第一步音效最多等 FIRST_PLAY_MAX_WAIT_MS + 一个轮询周期，
 * 而不是等完整素材。
 */
async function getPlayableSound(name: string): Promise<Audio.Sound | null> {
  const inFlight = warmupTasks.get(name);
  // 没有在途预热（已预热完 / 从未预热）：直接要对象，必要时同步补一次预热。
  if (!inFlight) return prepareSound(name);

  // 已在加载中（对象还没建出来）：此时中止也没有对象可用，只能等，否则这遍必然无声。
  if (!soundCache.has(name)) return inFlight.promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FIRST_PLAY_MAX_WAIT_MS);
  });
  let prepared: Audio.Sound | null = null;
  try {
    prepared = await Promise.race([inFlight.promise, giveUp]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // 预热在这段窗口内正好结束：直接用它，无需任何让步
  if (prepared) return prepared;

  // ① 让预热中止：循环在下一个轮询周期退出，收尾只恢复音量、不再动播放头。
  warmupTasks.delete(name);
  inFlight.abort();
  // ② 等它收尾做完（≤WARMUP_POLL_MS）——音量必须已经恢复，否则正式播放是静音的。
  const handedOver = await inFlight.promise;
  if (handedOver) return handedOver;
  // ③ 预热期间对象被丢弃/重建了：退回到等待新的预热，此时无别的办法。
  return prepareSound(name);
}

export async function playSound(name: string): Promise<void> {
  try {
    await ensureAudioMode();
    const sessionId = soundSessionId;
    const task = (playQueues.get(name) ?? Promise.resolve()).then(async () => {
      for (let attempt = 1; attempt <= PLAY_MAX_ATTEMPTS; attempt++) {
        // 对局已切换/退出：丢弃过期播放请求
        if (sessionId !== soundSessionId) return;

        // 尽量不等在途预热（【C-82】）；已预热完则立即返回同一个对象
        const sound = await getPlayableSound(name);
        if (!sound) return;

        if (await playAndVerify(sound, name)) return;

        console.warn(
          `[SoundManager] 音效 '${name}' 第 ${attempt}/${PLAY_MAX_ATTEMPTS} 遍未真正出声`
        );
        if (attempt >= PLAY_MAX_ATTEMPTS) break;

        // 第 3 遍换新播放器：原地重发已经失败过一次，说明这条音轨确实起不来
        if (attempt >= 2) {
          await discardSound(name);
        }
        if (sessionId !== soundSessionId) return;
        await sleep(RECREATE_DELAY_MS);
      }
      console.warn(`[SoundManager] 音效 '${name}' 重发后仍未出声，放弃本次播放`);
    });
    playQueues.set(name, task);
    await task;
  } catch (e) {
    // 兜底：内层已逐层捕获，此处仅防御意外异常
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
      sound.unloadAsync().catch(() => {
        /* 忽略卸载失败 */
      })
    );
  }
  soundCache.clear();
  prepareCache.clear();
  warmedNames.clear();
  warmupTasks.clear();
  playQueues.clear();
  await Promise.all(promises);
}

export async function stopSound(): Promise<void> {
  // 停止所有正在播放的音效
  const promises: Promise<unknown>[] = [];
  for (const [, sound] of soundCache) {
    promises.push(
      sound.stopAsync().catch(() => {
        /* 停止失败忽略 */
      })
    );
  }
  await Promise.all(promises);
}

export async function unloadSound(): Promise<void> {
  // 兼容旧接口：仅停止当前播放，不卸载缓存
  await stopSound();
}
