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
 *
 * ===========================================================================
 * v8：第四次真机取证——v5 的核心不变式被证伪；死轨必须重建而非重发
 * ===========================================================================
 * 路由修好（v7）之后，同一台真机（PTP-AN10）的 dumpsys media.audio_flinger
 * 显示出**两种**此前被混为一谈的故障形态：
 *
 *   A.【播放了，但增益极低】（音量 3/16 时）
 *      音轨 Server 正常推进 300~500ms（素材完整渲染），
 *      `G db` ≈ -39 —— 这正是华为音量曲线把 3/16 映射到的值。
 *      功率历史峰值 -48~-60dB，扬声器上几乎不可闻。
 *      ⇒ **这不是 bug**：App 不该劫持系统媒体音量；用户把媒体音量调高即恢复
 *        （13/16 时同一链路实测功率峰值 -19.4dB，清晰可闻）。
 *
 *   B.【死轨：播放器 resolve 了，混音器却一帧都没消费】（任何音量下偶发）
 *      真机实测（22:02，音量 13/16）：
 *        AT::add   G db=-inf  PortVol=-6.3  FrmRdy=19008（数据全就绪）
 *        AT::remove G db=-inf  Server=0（0 帧被混音器消费）Flags=0x008(terminated)
 *      同一时刻 dumpsys audio 里 requestAudioFocus(req=3) 成功、焦点就在本应用。
 *      即：**JS 侧 playAsync() 成功 resolve，而原生播放器既没推进播放头、
 *      增益也没写入** —— AudioFlinger 从未激活这条音轨。
 *
 *      由此，v5 的关键断言「playAsync() resolve ⇒ 音量必然已写入、必然在播」
 *      **被真机证伪**。而 v6 的定时补推 playAsync 对形态 B 无效：
 *      ExoPlayer 的 playWhenReady 已是 true，再调 playAsync 是 no-op，
 *      不会触发 TrackSelection 重新激活音轨。
 *
 *   v8 的修法（预防为主 + 检测兜底）：
 *     1. **预热激活（真机复验后确定的最终修复）**：死轨专打「预载后从未播过
 *        的实例的首次激活」（23:13/23:29 两局首两声全灭；22:19 第二声即活；
 *        用户 21:46 局交互多、首声已过激活窗口所以全活）。装载每个实例后
 *        立即静音试播一次：setVolume(0) → playAsync → 80ms（完成 AudioTrack
 *        初始化与 AudioPolicy 激活）→ seek 到素材末尾（立即 ENDED、无声）
 *        → 恢复音量 1，**不回位**（回位交给真正播放的 startSlot）。
 *        ⚠️ v8.1：初版在末尾 seek 回 0 再恢复音量，而 ExoPlayer 在 ENDED +
 *        playWhenReady=true 下 seek 回流会立即重播——整段声音漏了出来
 *        （用户 2026-10-18 反馈"好像没有静音预热"即此）。现在停 ENDED 不回位。
 *        真机复验（00:12）：预热音轨全部 G=-inf、~80ms 即 flush（T/0x600）；
 *        真实走子 G=-6.3dB、444ms 完整渲染（S/0x600），死轨绝迹。
 *     2. **起播双时点自检**（200/450ms positionMillis）：覆盖其它"播放头
 *        真没推进"的设备形态；判死 → 重建实例并补播当声。
 *        ⚠️ 注意 expo-av 的 isPlaying ≡ playWhenReady，真机死轨它也是 true，
 *        不能作为判活依据；而 positionMillis 直读 ExoPlayer（真实），但
 *        真机死轨上 ExoPlayer 时钟照样推进 —— 本机型上此判据偏"判活"，
 *        真正兜底是第 3 条。
 *     3. **1.2s 健康巡检**：系统在 ~1s 回收死 AudioTrack（Flags 0x008），
 *        此后对该实例的任何操作都会抛错 —— 用轻量探针（setPositionAsync）
 *        检出被回收的实例，标记 dead 并重建替补（不补播，当声已错过）。
 *     4. 重建滑窗限流（2 次/10s），防止异常情形下无限重建。
 *
 *   ⚠️ 环境音量提示（非 bug）：媒体音量 3/16 时华为音量曲线映射到 ≈-39dB，
 *      扬声器上基本不可闻 —— App 不劫持系统音量，调高媒体音量即恢复
 *      （13/16 → ≈-19dB，实测清晰可闻）。
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

/**
 * 起播自检的时点（毫秒）与死轨重播等待。
 *
 * 【v8】真机对照实验（PTP-AN10）证明存在「playAsync 成功 resolve、
 * 混音器却一帧都没消费」的死轨形态（v5 的不变式在真机上不成立）：
 *   · 死轨特征：AT::add 后 Server 恒为 0、增益 -inf，~1s 后被以
 *     terminated 移除；同一时刻焦点申请成功、无任何 JS 异常。
 *   · 有效恢复：**换一个全新实例**（22:19 实测新音轨立即正常出声）；
 *     对原实例再调 playAsync 是 no-op（playWhenReady 已为 true）。
 *
 * 自检取 200ms：素材 300~450ms，若播放头在 200ms 时已推进，这条音轨
 * 必然活着（不会再死）；若没推进，就是死轨，立刻重建。正常路径只多
 * 一次 getStatusAsync 往返，不引入任何可感知延迟。
 */
const PLAYBACK_CHECK_MS = 200;
/** 第二自检时点（毫秒）：450ms 处仍未推进才判死（见 verifyAlive 注释）。 */
const PLAYBACK_CHECK_SECOND_MS = 450;
/**
 * 【v8】实例健康巡检时点：1200ms（系统 AudioTrack 回收点 ~1s 之后）。
 * 此时对死实例做任何操作都会抛错——那是唯一可靠的死亡信号。
 */
const DEAD_TRACK_PROBE_MS = 1200;
/**
 * 【v8】预热激活参数。
 * 静音播 80ms 完成 AudioTrack init + AudioPolicy 激活，随后 seek 到末尾
 * 让播放立即结束（无声），再回位、恢复音量。
 * ⚠️ v8.1：不是"播完整段"——那会让预载串行等到素材结束（10 实例 6s+），
 * 拖慢进对局后立刻走子的首次播放。
 */
const WARMUP_ACTIVATE_MS = 80;
/** 读不到素材时长时，seek 目标的兜底值（ExoPlayer 会钳到真实 duration）。 */
const WARMUP_END_FALLBACK_MS = 2000;
/**
 * 自检判活的最小推进量（毫秒）：低于它视为死轨。
 *
 * ⚠️ 阈值必须小于**最短素材的时长**：select.mp3 实测约 26ms——它在 200ms
 * 自检时刻早已播完、播放头停在素材末尾（≈26ms）。判活依据因此是
 * 「播放头推进到过 ≥ 该阈值」的**历史事实**，而不是当前值——真机死轨的
 * Server 恒为 0（从未推进过），而正常播放哪怕播完了也推进过。
 * 为此 createSlot 起播后记录 isPlaying 的轨迹比单点读数可靠：
 * playAsync 成功 + didJustFinish/position≥阈值 两者其一即可判活。
 */
const PLAYBACK_CHECK_MIN_ADVANCE_MS = 20;
/** 判定死轨后，重建实例前的等待（给原生释放坏播放器的时间）。 */
const DEAD_TRACK_REBUILD_DELAY_MS = 80;
/**
 * 【v8 防失控】单个音效名在短时间内允许的最大重建次数。
 * 真机对照里死轨是**偶发**的（22:02 一次、22:19 即正常）；若实现有缺陷
 * 或系统处于某种持续拒绝的状态，无上限的「重建→自检→再重建」会空转打爆
 * CPU 与 AudioTrack 资源（测试曾因此挂死）。到限后放弃本声、保留现场
 * 交给下一次播放的常规重试路径。
 */
const MAX_REBUILDS_PER_RING = 2;
/** 重建计数的滑窗时长（毫秒）。 */
const REBUILD_WINDOW_MS = 10_000;

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
  /**
   * 【v8】该实例是否已被自检判定为死轨（播放器原生层损坏）。
   * 死实例会被 getRing 的重建流程替换掉，不再参与环形取用。
   */
  dead?: boolean;
  /** 【v8】实例标识：重建后自增，供日志区分新旧实例。 */
  bornAt: number;
};

/** 某个音效的实例环。 */
type Ring = {
  slots: Slot[];
  /** 环形游标，保证取用均匀分布而不是扎堆同一实例。 */
  cursor: number;
  /** 上一次起播时刻，用于「同一音效最小间隔」节流。 */
  lastPlayAt: number;
  /** 【v8】该音效名（重建死实例时需要知道重建谁）。 */
  name: string;
  /** 【v8】最近的死轨重建时刻（滑窗限流用，见 MAX_REBUILDS_PER_RING）。 */
  rebuildAt: number[];
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
async function createSlot(name: string, opts?: { skipWarmup?: boolean }): Promise<Slot | null> {
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
    const slot: Slot = { sound, durationMs, busyUntil: 0, dead: false, bornAt: Date.now() };
    if (!opts?.skipWarmup) {
      await warmupSlot(slot, name);
    }
    return slot;
  } catch (e) {
    console.warn(`[SoundManager] 装载音效 '${name}' 失败:`, e);
    return null;
  }
}

/**
 * 【v8 真机预防】实例「预热激活」：静音试播一次，烧掉首次激活的高失败率。
 *
 * 真机对照（PTP-AN10）得出的规律：
 *   · 23:13 / 23:29 两局：进对局后立即走子 → **预载后从未播过的实例**
 *     首次激活双双失败（AudioFlinger：AT::add 后 Server 恒 0、G=-inf、
 *     恰 1s 后被系统回收 Flags 0x008）——expo-av 16.0.8 的 JS API
 *     （positionMillis/isPlaying/isLoaded）对此**完全不可见**；
 *   · 22:19 对照：首声死后，同一实例的第二次 playAsync 由 ExoPlayer
 *     重新 init AudioTrack，**立即恢复正常**（功率 -19.4dB 实测可闻）；
 *   · 用户 21:46 那局：进对局后先有多轮点击交互（select 已播过），
 *     走子时早已过了"首次激活"窗口 → 全部正常。
 *
 * 结论：死轨专打「首次激活」。与其当声不可检测地丢，不如在装载时
 * 用**静音试播**把首次激活烧掉。
 *
 * ⚠️【v8.1 静音窗口修正】最初实现只静音 80ms 后就恢复音量并 seek 回 0——
 * 但 go/eat/goerror 素材长 275~344ms，**剩余部分会完整出声**（用户进对局
 * 时能听到一串走子音）。
 *
 * 修法（既不出声、也不拖慢预载）：静音播 80ms 完成激活后，**直接 seek 到
 * 素材末尾**——ExoPlayer 立即进入 ENDED，剩余音频不会再被渲染。
 *
 * ⚠️⚠️ 关键顺序（真机语义，2026-10-18 修正）：**不要 seek 回 0**。
 * ExoPlayer 在 STATE_ENDED 下只要 playWhenReady=true，seek 回 0 就会
 * **立即重新开始播放**——原实现"末尾 seek(0) 再恢复音量"恰好把整段声音
 * 放了出来（这正是用户反馈"好像没有静音预热"的原因）。
 * 所以预热后**停在 ENDED**、音量恢复为 1，由真正播放时的
 * startSlot（setPositionAsync(0) + playAsync）负责从头起播：
 *   setVolume(0) → playAsync → 80ms（激活窗口）→ setPositionAsync(时长)
 *   [立即 ENDED、无声] → setVolume(1) → 留在 ENDED
 * 单个实例开销 ≈ 80ms + 2 次原生往返，10 个实例串行 ≈ 1.2s。
 *
 * 对既定策略的影响：**不破坏 v5 焦点不变式**——
 * `requiresAudioFocus()`（SimpleExoPlayerData.java:255）只看
 * playWhenReady && !mIsMuted，setVolume(0) 不改变这两个标志，
 * 焦点在预热时申请一次后整局持有；也全程不碰 pauseAsync。
 */
async function warmupSlot(slot: Slot, name: string): Promise<void> {
  try {
    await slot.sound.setVolumeAsync(0);
    await slot.sound.playAsync();
    // 静音播一小段：AudioTrack init + AudioPolicy 激活都发生在这一段里
    // （真机死轨的"首次激活失败"就是在这里被烧掉的）。
    await sleep(WARMUP_ACTIVATE_MS);
    // 跳到素材末尾让播放立即结束（无声音）；时长为 0（读不到）时用 2s 兜底，
    // ExoPlayer 会把超出的 seek 钳到 duration，同样立即 ENDED。
    const endPos = slot.durationMs > 0 ? slot.durationMs : WARMUP_END_FALLBACK_MS;
    await slot.sound.setPositionAsync(endPos);
    // 恢复音量：此刻播放器处于 ENDED，不会出声。
    // ⚠️ 这里**不能**再 seek 回 0 —— ENDED + playWhenReady=true 下 seek
    // 回到开头会立即重新播放（声音就漏出来了）。
    await slot.sound.setVolumeAsync(1);
  } catch (e) {
    // 预热失败不阻塞装载：真机上焦点申请总归能成功（req=3 实测），
    // 失败极罕见；就算首播仍踩死轨，还有 1.2s 巡检重建兜底。
    console.warn(`[SoundManager][v8] '${name}' 预热激活失败（不阻塞）:`, e);
    try {
      await slot.sound.setVolumeAsync(1);
    } catch {
      /* 复原失败忽略 */
    }
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
    const ring: Ring = { slots, cursor: 0, lastPlayAt: 0, name, rebuildAt: [] };
    rings.set(name, ring);
    return ring;
  })();

  ringTasks.set(name, task);
  return task;
}

/** 从环里取一个可用实例：优先空闲，其次取最早空闲的那个；跳过死实例。 */
function acquireSlot(ring: Ring): Slot | null {
  const now = Date.now();
  const alive = ring.slots.filter((s) => !s.dead);
  if (alive.length === 0) return null;

  let chosen: Slot | null = null;
  for (let i = 0; i < alive.length; i++) {
    const idx = (ring.cursor + i) % alive.length;
    const slot = alive[idx];
    if (slot.busyUntil <= now) {
      chosen = slot;
      ring.cursor = (alive.indexOf(slot) + 1) % alive.length;
      break;
    }
  }

  if (!chosen) {
    // 全都占着（极少见）：拿最早空闲的那个，宁可截断也不静默。
    chosen = alive.reduce((a, b) => (a.busyUntil <= b.busyUntil ? a : b));
    ring.cursor = (alive.indexOf(chosen) + 1) % alive.length;
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
 * 增益才恢复正常（成因与真机数据见 VOLUME_REINFORCE_DELAYS_MS 的注释）。
 *
 * 【v8 追加】起播自检：playAsync() resolve **不再等于**真的在播——
 * 真机对照实验抓到过「resolve 成功但混音器 0 帧消费」的死轨
 * （详见文件头 v8 一节）。200ms 时读一次播放头：
 *   · 推进了 → 音轨活着，收工；
 *   · 没推进 → 死轨：标记 dead 并**重建全新实例**重播一次
 *     （对死实例再调 playAsync 是 no-op，重建是唯一有效恢复手段）。
 */
/**
 * 【v8】起播自检 + 死轨重建。
 *
 * ⚠️ 真机判据修正记录（PTP-AN10，23:13 对照实验）：
 *   · 死轨形态：AT::add 后 Server 恒 0、G=-inf，**恰好 1s 后被系统回收**
 *     （Flags 0x000→0x008，疑似 Android 14+ 的 idle AudioTrack 回收）；
 *   · 该回收发生在原生层，ExoPlayer 的 positionMillis 照常推进
 *     （getExtraStatusFields 直读 mSimpleExoPlayer.getCurrentPosition()），
 *     **JS 侧无从分辨**——双时点 position 判据在真机上恒判活，自检空转；
 *   · 但实例被系统回收后，下一次对它的 setPositionAsync/playAsync **必然抛错**
 *     （AudioTrack 已 release）→ 落进既有的"换实例重试"路径。
 *
 * 因此本函数做两件事：
 *   1. 双时点 position 判活（覆盖"播放头真的没推进"的设备/形态）；
 *   2. 【1.2s 巡检】系统回收点(1s)之后读一次状态并对实例做一次轻量探针
 *      （setPositionAsync(0)）：
 *        · 探针成功 → 实例还活着（正常轨）；
 *        · 探针抛错 → 实例已被系统回收 → 标记 dead、立即重建替补。
 *      巡检不重播当前声（已错过），只为**下一声**准备好健康实例。
 * 每一步都打 console.warn，保证真机上可在 Metro 日志观测整条链路。
 */
async function verifyAlive(slot: Slot, name: string, isAlive: () => boolean): Promise<void> {
  if (!isAlive() || slot.dead) return;

  const readOnce = async (): Promise<'alive' | 'dead' | 'pending'> => {
    try {
      const st = await slot.sound.getStatusAsync();
      if (!st.isLoaded) return 'dead';
      if (st.didJustFinish === true) return 'alive';
      if (
        typeof st.positionMillis === 'number' &&
        st.positionMillis >= PLAYBACK_CHECK_MIN_ADVANCE_MS
      ) {
        return 'alive';
      }
      return 'pending';
    } catch {
      return 'dead';
    }
  };

  const first = await readOnce();
  if (first === 'alive') return;
  if (!isAlive() || slot.dead) return;
  if (first === 'pending') {
    await sleep(PLAYBACK_CHECK_SECOND_MS - PLAYBACK_CHECK_MS);
    if (!isAlive() || slot.dead) return;
    const second = await readOnce();
    if (second === 'alive') return;
    if (second === 'pending') {
      // 双时点播放头都停在 0：某些设备上死轨 position 照样推进读不出来，
      // 但也确有"真的没推进"的形态——按死轨处理。
      console.warn(`[SoundManager][v8] '${name}' 双时点播放头未推进，判死重建`);
    }
  }

  // 起播自检判死：当声还没播出去 → 重建后立刻重播一次
  await markDeadAndRebuild(slot, name, isAlive, true);
}

/**
 * 【v8】1.2s 实例健康巡检：系统 AudioTrack 回收点之后，用一次轻量探针
 * 检出"已被回收"的死实例并重建替补（不重播当前声，已错过）。
 */
async function healthProbe(slot: Slot, name: string, isAlive: () => boolean): Promise<void> {
  if (!isAlive() || slot.dead) return;
  try {
    // 探针：seek 到当前位置（不动播放状态）。实例若已被系统回收，
    // 原生层会抛 IllegalStateException——那就是死亡信号。
    const st = await slot.sound.getStatusAsync();
    if (!isAlive() || slot.dead) return;
    if (!st.isLoaded) {
      slot.dead = true;
      console.warn(`[SoundManager][v8] '${name}' 巡检：实例已卸载（系统回收），重建替补`);
      await markDeadAndRebuild(slot, name, isAlive, false);
      return;
    }
    await slot.sound.setPositionAsync(Math.max(0, st.positionMillis ?? 0));
    // 探针成功：实例健康，无需处理
  } catch {
    if (!isAlive() || slot.dead) return;
    slot.dead = true;
    console.warn(`[SoundManager][v8] '${name}' 巡检：实例操作抛错（已被系统回收），重建替补`);
    await markDeadAndRebuild(slot, name, isAlive, false);
  }
}

/**
 * 【v8】把死实例移出环并重建替补（滑窗限流）。
 * @param replay 重建完成后是否用新实例把这一声补播出去
 * （自检判死时 true——当声还没播出；巡检判死时 false——当声已错过）。
 */
async function markDeadAndRebuild(
  slot: Slot,
  name: string,
  isAlive: () => boolean,
  replay: boolean
): Promise<void> {
  slot.dead = true;
  await slot.sound.unloadAsync().catch(() => {
    /* 卸载失败忽略 */
  });
  if (!isAlive()) return;
  let ring = rings.get(name);
  if (!ring) return;

  // 重建上限：防止异常情形下无限重建（见 MAX_REBUILDS_PER_RING 注释）
  const nowMs = Date.now();
  ring.rebuildAt = ring.rebuildAt.filter((t) => nowMs - t < REBUILD_WINDOW_MS);
  if (ring.rebuildAt.length >= MAX_REBUILDS_PER_RING) {
    console.warn(`[SoundManager][v8] '${name}' 重建次数达上限（${MAX_REBUILDS_PER_RING}/${REBUILD_WINDOW_MS}ms）`);
    return;
  }
  ring.rebuildAt.push(nowMs);

  await sleep(DEAD_TRACK_REBUILD_DELAY_MS);
  if (!isAlive()) return;
  ring = rings.get(name);
  if (!ring) return;
  // 一次性清掉环里所有死实例，再补足到环大小
  const alive = ring.slots.filter((s) => !s.dead);
  for (const d of ring.slots.filter((s) => s.dead)) {
    await d.sound.unloadAsync().catch(() => {
      /* 已卸载/卸载失败忽略 */
    });
  }
  ring.slots = alive;
  const need = Math.max(1, ringSizeOf(name) - ring.slots.length);
  let firstFresh: Slot | null = null;
  for (let i = 0; i < need; i++) {
    const fresh = await createSlot(name);
    if (fresh) {
      fresh.busyUntil = Date.now() + TAIL_GUARD_MS;
      ring.slots.push(fresh);
      if (!firstFresh) firstFresh = fresh;
      console.warn(`[SoundManager][v8] '${name}' 已重建替补实例（环内 ${ring.slots.length} 个）`);
    }
  }
  // 自检判死场景：当声还没播出去 → 用新实例补播（巡检场景 replay=false，已错过）
  if (replay && firstFresh) {
    try {
      await startSlot(firstFresh, name, isAlive);
    } catch {
      /* 补播失败：交给调用方既有重试路径，绝不抛出 */
    }
  }
}

async function startSlot(slot: Slot, name: string, isAlive: () => boolean): Promise<void> {
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

  // 【v8】起播自检（不阻塞 playSound 返回）：
  //   · 双时点（200/450ms）position 判活 → 判死重建；
  //   · 1.2s 健康巡检 → 检出被系统回收的实例并重建替补。
  const checkTimer = setTimeout(() => {
    void verifyAlive(slot, name, isAlive);
  }, PLAYBACK_CHECK_MS);
  const probeTimer = setTimeout(() => {
    void healthProbe(slot, name, isAlive);
  }, DEAD_TRACK_PROBE_MS);

  // 自检定时器也要纳入卸载清理（与补推定时器同一注册表）
  timers.push(checkTimer);
  timers.push(probeTimer);
}

/**
 * 播放一个音效。**永不抛出**。
 *
 * 失败语义：
 *   · playAsync() reject（焦点申请被拒等）→ 换实例重试 + 复位音频模式（v5 语义）；
 *   · playAsync() resolve 但播放头不推进（死轨，v8 真机实测形态）→
 *     由 startSlot 的起播自检发现并**重建实例**重播。
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
      if (!slot) {
        // 全部实例都是死轨（理论上到不了：死实例会被立即重建替换）。
        // 重建一个再播，宁可慢一点也不静默。
        const fresh = await createSlot(name);
        if (!fresh) return;
        ring.slots.push(fresh);
        try {
          await startSlot(fresh, name, () => mySession === sessionId);
          return;
        } catch (e) {
          console.warn(`[SoundManager] '${name}' 重建实例后仍播放失败:`, e);
          await resetFocusForRetry();
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
      }
      try {
        await startSlot(slot, name, () => mySession === sessionId);
        return; // resolve 即代表这一遍已下发成功（死轨由自检兜底，见 startSlot）
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