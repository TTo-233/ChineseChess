import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  useWindowDimensions,
  BackHandler,
  AppState,
  ScrollView,
  Platform,
  TouchableWithoutFeedback,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
// usePreventRemove 由 @react-navigation/core 提供，经 @react-navigation/native 转出；
// expo-router 6.0.23 自身未导出该 hook（build/exports.d.ts 无此名），故从 react-navigation 取。
// 它拦截的是导航容器的 beforeRemove 事件——iOS 侧滑返回与 Web 浏览器后退键都走这条路径
// （顶部返回按钮与安卓物理返回键是显式 onPress，不经此事件，已各自接 requestExit）。
import { useNavigation, usePreventRemove, type NavigationProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome6 } from '@expo/vector-icons';
import { createInitialState, applyHandicap, cloneGameState, getSelectableMoves, getValidMoves, isMoveKingSafe, makeMove, undoMove, getWinnerSideTag, type GameState } from '@/utils/chess/GameEngine';
import { getMoveBanReason, banReasonNotice } from '@/utils/chess/RuleEngine';
import { HandicapBoard } from '@/components/HandicapBoard';
import { RED_SIDE, BLACK_SIDE, type SideTag } from '@/utils/chess/types';
import ChessBoard from '@/components/ChessBoard';
import GameBottomBar, {
  BOTTOM_BAR_HEIGHT,
  type GameBottomBarActionInput,
  type GameMenuItem,
} from '@/components/GameBottomBar';
import JueShaOverlay from '@/components/JueShaOverlay';
import { AppDialog, AppModal, GameNotice, ModalButton, modalButtonRowStyle, type GameNoticeItem } from '@/components/Modal';
import { useMoveEffect } from '@/hooks/useMoveEffect';
import { useBoardFrame } from '@/hooks/useBoardFrame';
import { useBattleClock } from '@/hooks/useBattleClock';
import { useBattleStateSync } from '@/hooks/useBattleStateSync';
import { playJiangJunSound, playSound, acquireSoundSession, releaseSoundSession } from '@/utils/SoundManager';
import { getOnlineServerUrl } from '@/utils/serverConfig';
import { applyServerNow, serverElapsedMs, serverNow, serverRemainingSec } from '@/utils/serverClock';
import { getRoomSessionToken, peekRoomSessionToken, clearRoomSessionToken } from '@/utils/playerIdentity';
import { BattleSocket } from '@/utils/battleSocket';
import { isActionNotSent, BattleActionRejectedError, type BattleActionType, type BattleMove } from '@/utils/battleProtocol';
import { saveReplay } from '@/utils/replayStorage';
import { useBoardLayoutBudget } from '@/utils/chess/useBoardLayoutBudget';
import { capHostHeightToViewport } from '@/utils/chess/boardLayoutBudget';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { useBackgroundStyle } from '@/utils/chess/backgroundStyleStore';
import {
  SettingSelect,
  formStyles,
  BASE_TIME_OPTIONS,
  TURN_TIME_OPTIONS,
  INCREMENT_OPTIONS,
  BYOYOMI_OPTIONS,
} from '@/components/RoomSettingsControls';
import { FONT } from '@/utils/typography';

const COLORS = {
  background: '#F5F0E8',
  card: '#FFF8F0',
  primary: '#8B6914',
  danger: '#C62828',
  textPrimary: '#3E2723',
  textSecondary: '#5D4037',
  textLight: '#8D6E63',
  border: 'rgba(139, 105, 20, 0.15)',
  success: '#2E7D32',
  borderSolid: '#D7CCC8',   // 浅棕实色边框（与人机对战等其他页面顶栏一致）
  redPiece: '#B22222',
  blackPiece: '#2C2C2C',
};

// 数值屏宽（与人机对战一致：底部操作栏/角标行按屏宽布局，规避部分 Android Yoga 对 stretch 的兼容问题）
// 【C-90】屏宽/屏高改用组件内的 useWindowDimensions（响应式）：原先是模块级
// Dimensions.get('window')，只在首次加载取一次，转屏后不会更新。纵向基准改成
// 「屏幕 50%」后，屏高直接决定棋盘中心线，屏高一旦过期，转屏后棋盘就会明显偏离中线。

function sideStringToTag(side: string): boolean {
  return side === 'red' ? RED_SIDE : !RED_SIDE;
}

// 回合剩余秒数 → m:ss（用于棋盘右上角的倒计时角标）
function formatTurnClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** 基本用时/加秒/读秒/步时下拉选项：见共享组件 @/components/RoomSettingsControls */

/** 标准初始局面：棋子 id → 交叉点坐标（让子幽灵标记定位用，模块级只算一次） */
const INITIAL_PIECE_POS: ReadonlyMap<number, { col: number; row: number }> = (() => {
  const map = new Map<number, { col: number; row: number }>();
  for (const p of createInitialState().pieces) {
    map.set(p.id, { col: p.col, row: p.row });
  }
  return map;
})();

// 对局内可发送的 emoji 表情（涵盖常用情绪与手势）。
// 以 Unicode 码点（数值）在运行时构造为表情字符，源码中不出现字面 emoji。
const EMOJI_CODE_POINTS: number[][] = [
  [0x1f604], // 笑脸
  [0x1f602], // 笑哭
  [0x1f923], // 大笑
  [0x1f60a], // 害羞微笑
  [0x1f60d], // 喜爱
  [0x1f60e], // 得意
  [0x1f914], // 思考
  [0x1f60f], // 坏笑
  [0x1f62e], // 惊讶
  [0x1f622], // 难过
  [0x1f62d], // 大哭
  [0x1f621], // 生气
  [0x1f44d], // 点赞
  [0x1f44e], // 踩
  [0x1f44f], // 鼓掌
  [0x1f64f], // 感谢
  [0x1f4aa], // 加油
  [0x1f389], // 庆祝
  [0x2764, 0xfe0f], // 爱心（含变体选择符）
  [0x1f525], // 火焰
];
const EMOJI_LIST = EMOJI_CODE_POINTS.map(cps => String.fromCodePoint(...cps));
// 单条表情本地展示时长（毫秒）：弹入 → 停留 → 淡出后移除
const EMOJI_DISPLAY_MS = 4000;
// 结算页「返回房间」兜底倒计时（秒）：双方互不干扰意味着都可能不点按钮，
// 到点后本端自动回房间准备界面，避免结算页无限期停留
const RETURN_ROOM_FALLBACK_SECONDS = 10;
/**
 * 【P5】没有实测 RTT 可用时的标定基数（毫秒）。
 *
 * 兜底轮询只在 WebSocket 断开时启用，此时 BattleSocket 拿不到 RTT 采样，
 * 用实测值（串行 6 次 /gameState 共 4332ms → 每次约 722ms）取整为 800ms。
 */
const FALLBACK_RTT_MS = 800;

// 当前正在展示的活跃表情（本地按首次接收时间计时，超时自动移除）
interface ActiveEmoji {
  id: string;
  playerId: string;
  emoji: string;
  receivedAt: number;
}

// 表情气泡：弹入 → 停留 → 淡出缩小，一段自包含的入场/退场动画
function EmojiBubble({ emoji, lifetime }: { emoji: string; lifetime: number }) {
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.sequence([
      Animated.timing(anim, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.back(1.6)),
        useNativeDriver: true,
      }),
      Animated.delay(Math.max(0, lifetime - 640)),
      Animated.timing(anim, { toValue: 0, duration: 380, useNativeDriver: true }),
    ]).start();
  }, [anim, lifetime]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.emojiBubble, { opacity: anim, transform: [{ scale: anim }] }]}
    >
      <Text style={styles.emojiBubbleText}>{emoji}</Text>
    </Animated.View>
  );
}

/**
 * 对局页阶段机。
 *
 * ⚠️ `'countdown'` 是**保留值**：全仓库没有任何 setPhase('countdown')，它当前恒不成立。
 * 选边倒計时用的是独立的 `countdown` 数字 state（阶段仍为 'reveal'）。下面的判断保留
 * 该值是出于防御（若将来把选边倒计时提升为独立阶段即可直接生效），不要据此推断
 * "存在一个倒计时阶段"。
 */
type GamePhase = 'waiting' | 'reveal' | 'countdown' | 'playing' | 'ended';

export default function LanBattleScreen() {
  const router = useSafeRouter();
  // 安全区：Screen 已在内容之外施加顶部/底部安全区，预算封顶时需据此扣减可用高度
  const insets = useSafeAreaInsets();
  // 整屏背景（首页「样式设置 → 背景」所选）。未选背景图时不产生任何视觉变化。
  const background = useBackgroundStyle();
  const hasBackground = background.image != null;
  // 返回大厅：优先 back 回到栈中已有的大厅页（replace 只是替换栈顶，会在旧大厅之上
  // 再叠一个新大厅，导致用户在大厅点返回时"又回到了大厅"）；Web 刷新等无栈场景兜底 replace
  const exitToLobby = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/lanGame');
    }
  }, [router]);
  const params = useSafeSearchParams<{
    roomId: string;
    playerId: string;
    playerName: string;
    /** 房间名：由大厅创建/加入时随路由带入，保证首帧标题即为真实房间名（无需等轮询回填） */
    roomName?: string;
    side: string;
  }>();

  const [gameState, setGameState] = useState<GameState>(createInitialState());
  // 【S-1 / §3.1】房间会话凭证：服务端在创建/加入房间时签发，之后所有写操作都靠它鉴权
  // （playerId 退化为显示用标识）。首帧从持久化里恢复——App 被杀掉后重进对局页仍要能续上，
  // 否则玩家会被判断线判负。ref 而非 state：写请求是命令式的，不需要触发重渲染。
  const sessionTokenRef = useRef('');
  // token 恢复完成标记：true 表示已尝试过（无论成功与否），用于避免重复的存储读取
  const tokenResolvedRef = useRef(false);
  // gameState 镜像 ref：供终局结算等异步回调读取最新局面（着法序列）
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;
  // 复盘自动保存守卫：每局仅保存一次（重新对局时重置）
  const replaySavedRef = useRef(false);
  const [selectedPieceId, setSelectedPieceId] = useState<number | null>(null);
  const [validMoves, setValidMoves] = useState<boolean[][] | null>(null);
  const [lastMove, setLastMove] = useState<{ fromCol: number; fromRow: number; toCol: number; toRow: number } | null>(null);
  const [phase, setPhase] = useState<GamePhase>('waiting');
  const phaseRef = useRef<GamePhase>('waiting');
  phaseRef.current = phase;
  const [showSurrenderModal, setShowSurrenderModal] = useState(false);
  // 对局中退出二次确认：返回按钮 / 侧滑返回 / 安卓物理返回键共用一个入口，
  // 由 requestExit 统一决定「直接退出」还是「先弹窗」，避免各入口各写一套判断
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  // 「中途退出」二次确认的导航拦截开关（详见下方 usePreventRemove 处注释）。
  // ref 供 confirmLeaveAndExit / handleBack 同步撤防——等下一帧 state 更新会让确认弹窗被重新弹回；
  // state 驱动 usePreventRemove 的 preventRemove 参数，最终同步给导航容器。
  const [leaveArmed, setLeaveArmed] = useState(false);
  const leaveArmedRef = useRef(false);
  // 弹窗已开标记：Web 端 popstate 兜底在弹窗开着时不再重复触发（连点后退会连弹多次）
  const showLeaveConfirmRef = useRef(false);
  // 「撤销后退」标记：history.go(1) 会自己再触发一次 popstate，用它区分自发回退与撤销回退
  const webPopRestoreRef = useRef(false);
  // 被 beforeRemove 拦下的原始离场动作，确认后原样 dispatch 放行（不能改写成 router.back()）
  const pendingLeaveRef = useRef<{
    nav: Pick<NavigationProp<ReactNavigation.RootParamList>, 'dispatch'>;
    action: Parameters<NavigationProp<ReactNavigation.RootParamList>['dispatch']>[0];
  } | null>(null);
  const [countdown, setCountdown] = useState(3);
  const [gameResult, setGameResult] = useState<{
    winner: string | null;
    isWin: boolean;
    duration: number;
    moveCount: number;
    surrenderBy: string | null;
    isDraw?: boolean; // 和棋（双方同意求和）
  } | null>(null);
  const [jueShaVisible, setJueShaVisible] = useState(false);
  // 终局原因：区分「绝杀/困毙」（播绝杀特效）与「认输/和棋/断线判负/对方离开」（仅普通文字结算）
  const [gameEndReason, setGameEndReason] = useState<'checkmate' | 'resign' | 'draw' | 'disconnect' | 'timeout' | 'leave' | null>(null);
  // 引擎终局细分原因（juesha/kunbi/changjiang/repetition/red_win/black_win），用于结算文案与特效开关
  const [gameOverReason, setGameOverReason] = useState<string>('');
  // 准备阶段：房间名、选边与准备状态
  // 房间名初值取路由带入的 roomName（大厅创建/加入时已知），避免首帧退化为「在线对局」兜底文案；
  // 后续由房间轮询/改名接口回填覆盖为最新值
  const [roomName, setRoomName] = useState(params.roomName || '');
  const [roomPassword, setRoomPassword] = useState<string | null>(null);
  // 【2026-10 审计 P1】是否见过密码明文（即本端确为房主且 token 已恢复）：
  // 服务端收紧后 password 只对持 token 的房主可见，此前把它当作"可能拿不到的正常值"，
  // 但保存设置时若把"没拿到"误当"想清空"，会把真实密码静默清掉。此 ref 区分两者：
  // false = 从未拿到（跳过 password 字段，不修改）；true = 见过（正常直传，允许清空）。
  const passwordSeenRef = useRef(false);
  const [hostId, setHostId] = useState('');
  const [sidePickVisible, setSidePickVisible] = useState(false); // 选边弹窗
  const [readyCountdown, setReadyCountdown] = useState<number | null>(null); // 双方就绪后的 3 秒倒数（null=未倒数）
  const [sidePickStage, setSidePickStage] = useState(false); // 倒数完成进入选边阶段（准备不可再取消）
  const [settingsVisible, setSettingsVisible] = useState(false); // 房间信息/设置弹窗
  // 设置弹窗编辑态（打开时以当前房间值预填；布局与大厅创建房间弹窗一致）
  const [editName, setEditName] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editTurn, setEditTurn] = useState(0); // 步时（秒，0=不限时）
  // 对战设置编辑态（基本用时+加秒制/让子）：局时（秒，0=不限）、加秒（秒）、红方让子 id 列表
  const [editBaseTime, setEditBaseTime] = useState(0);
  const [editIncrement, setEditIncrement] = useState(0);
  const [editByoyomi, setEditByoyomi] = useState(0); // 读秒（秒）编辑态，与 editIncrement 互斥
  const [editHandicap, setEditHandicap] = useState<number[]>([]);
  const [openSelect, setOpenSelect] = useState<null | 'base' | 'turn' | 'inc' | 'byo'>(null); // 弹窗内展开中的下拉
  const [savingSettings, setSavingSettings] = useState(false);
  const [myPreference, setMyPreference] = useState<'red' | 'black' | null>(null);
  const [myReady, setMyReady] = useState(false);
  // 本端准备意向的最新值（避免快速连点时闭包读到旧的 myReady）
  const myReadyRef = useRef(false);
  // 进行中的准备请求数：>0 时忽略新的连点，防止并发请求互相覆盖
  const readyInFlightRef = useRef(0);
  // 「返回房间」10s 兜底倒计时的剩余秒数：结算后开始计时（无论玩家是否已点），
  // 归零即自动切到房间准备界面，避免停在结算页干等对手。
  const [returnRoomCountdown, setReturnRoomCountdown] = useState<number | null>(null);
  // 对方是否已返回房间（服务端 returnedToRoom 下发）：用于在结算页提示对手去留。
  const [opponentReturned, setOpponentReturned] = useState(false);
  const returnToRoomInFlightRef = useRef(false); // 「返回房间」请求在途标记：防止连点并发
  // 最近一次本地切换准备的时间戳：轮询在此宽限窗口内不用服务端旧数据覆盖本端状态，避免按钮回跳
  const lastReadyToggleRef = useRef(0);
  // 最近一次「返回房间」（重赛重置）的时间戳：此后轮询拿到的旧对局状态（phase=playing/旧 gameStartTime）
  // 不得再把本地拉回对局中，否则会跳过准备阶段；仅当服务端开出新局（gameStartTime 更新）才允许进入对局
  // 服务端时钟偏移（serverNow - 本地 Date.now()）：凡与服务端时间戳（sideReveal.time/gameStartAt 等）
  // 比较一律使用校正后的服务端时间，避免双端设备时钟差导致倒数不齐或守卫误判
  const serverTimeOffsetRef = useRef(0);
  // 对局纪元：本端已进入对局的 matchId。重赛后轮询可能先拿到上一局旧快照（phase=playing），
  // 仅当服务端 matchId 大于本端已入局的纪元时才允许再次进入对局（替代跨时钟的时间戳比较）
  const playedMatchIdRef = useRef(0);
  const [opponentReady, setOpponentReady] = useState(false);
  const [opponentPreference, setOpponentPreference] = useState<'red' | 'black' | null>(null);
  // 公示信息：双方选边相同被随机分配时标注
  const [sideRandom, setSideRandom] = useState(false);
  // 选边弹窗切换到"结果公示"视图：选边结束后弹窗保持不动，内容以动画切换为执棋结果
  const [sidePickResultMode, setSidePickResultMode] = useState(false);
  // 结果视图的入场动画（淡入 + 上移）
  const sidePickResultAnim = useRef(new Animated.Value(0)).current;
  // 公示→倒数序列只启动一次；由 ready 响应（上传方）或轮询发现 sideReveal（非上传方）触发
  const revealStartedRef = useRef(false);
  // 是否由本端上传初始局面（双方均准备的那次 ready 响应方）；另一端等待同步，避免重复上传互相覆盖
  const amUploaderRef = useRef(false);
  const uploadedRef = useRef(false);
  // 【C-47】原 revealTimerRef 是死引用：全文件只有 clearTimeout、从未有任何一处给它赋值
  // （公示倒数用的是下面的 countdownTimerRef），会让读者以为公示阶段还有一个 timeout。
  // 已连同 3 处清理点一并删除。
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 吃子/将军特效（含连续将军节流策略）
  const { moveEffect, triggerMoveEffect } = useMoveEffect();
  // 本端走子乐观更新保护：上传在途时轮询可能先拿到走子前的旧局面，直接覆盖会让棋子
  // "回退"、待上传落地后又"重新移动"。记录本端着法后的着法数与时间，轮询到更旧的局面
  // 时跳过覆盖，直到服务端追上（着法数 >= 本端）再恢复同步；超时则判定上传失败放弃保护。
  // 具体的判定与「只延迟局面块」的处理在 hooks/useBattleStateSync 内。
  const pendingSyncRef = useRef<{ historyLen: number; at: number; snapshot: GameState } | null>(null);
  // 【C-90】响应式屏宽/屏高：转屏/分屏后立即更新，棋盘中心线与横向留白跟着重算
  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  // 棋盘可用纵向空间实测（宽屏/纵向空间不足时限制棋盘尺寸，避免挤占底部按钮）
  const [boardAreaH, setBoardAreaH] = useState(0);
  // 与人机对战一致：棋盘与底部操作栏的间距随屏宽自适应（底栏已改为页面固定通栏，
  // 该间距作为底栏的上边距，不再随底栏实测高度浮动）
  const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);
  // 表情下拉栏锚点（兼容回退）：我方名称角标行底边在棋盘容器内的 Y 坐标（onLayout 测得）。
  // 主锚点改为点按瞬间 measureInWindow 实测窗口坐标（见 emojiDropdownTop），onLayout 值仅作回退。
  const [emojiAnchorY, setEmojiAnchorY] = useState(0);
  // 下拉栏竖向锚点（根容器坐标系）：点按名称行时实测行底边的窗口坐标并减去根容器窗口 Y。
  // 动态布局预算（boardPadTop）会在多轮布局中移动名称行，onLayout 相对坐标在部分机型/时序下
  // 会取到中间态旧值（下拉栏错落到棋盘中），因此以点按瞬间的实测坐标为准。
  const myNameRowRef = useRef<View>(null);
  const [emojiDropdownTop, setEmojiDropdownTop] = useState<number | null>(null);
  // 内容宿主（棋盘容器父级）相对根容器的 Y：配合 onLayout 回退锚点换算到根容器坐标系
  const [boardHostY, setBoardHostY] = useState(0);
  // 棋盘高度预算 + 垂直定位留白（口径与对局页一致）：
  // 条件 1 —— 棋盘顶边上方常驻预留「对手名角标行(30)」，棋盘取到预留允许的最大尺寸；
  // 条件 2 —— 内容（上角标行 + 棋盘 + 下角标行 + 底部栏）在宿主内垂直居中；居中时上方预留
  //           不足则整体下移贴住预留区（把下方空白让给棋盘）。
  // 上方流内占位 = 对手名角标行(26+4=30)；下方流内占位 = 我方名角标行(26+4=30)。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出（详见
  // capHostHeightToViewport 注释）。
  // 底栏已移到 boardHost 之外（固定在页面最底端），它占的是宿主之外的高度，
  // 因此以 belowHostHeight 参与封顶，而不是 bottomFlowHeight（口径与观战/回放页一致）。
  // 注意 belowHostHeight 不要加 insets.bottom —— capHostHeightToViewport 已扣过一次
  // bottomInset，重复计入会白白少掉一个安全区的高度。
  // 【C-81】下方那一行角标通过 belowHostSlack 借用底栏上边距 dynamicGap，
  // 使棋盘宽度不受它影响（横向留白口径与人机对战一致，见【C-81】注释）。
  const { maxBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      boardHostY,
      insets.top,
      insets.bottom,
      BOTTOM_BAR_HEIGHT + dynamicGap
    ),
    screenWidth,
    topFlowHeight: 30,
    bottomFlowHeight: 30,
    // 【C-81】下方角标行借用底栏上边距 dynamicGap 这段确实空着的间距。
    // 横向宽度只由 BOARD_H_PADDING 决定，与人机对战保持一致；
    // 借用量恰好等于封顶溢出量，因此最坏情况只是内容贴到底栏上沿，不会压到底栏。
    // 【C-90】纵向基准改为屏幕 50%（棋盘本体居中于物理屏幕中线）：
    // 原先按宿主区间居中会被底栏截断的上移，实测横屏 −29px / 桌面 −35px。
    belowHostSlack: dynamicGap,
    hostTopY: boardHostY,
    viewportHeight: windowHeight,
  });

  // 棋盘真实几何（相对主容器）：供绝杀特效锁定棋盘中心、把结算文字/按钮排到棋盘正下方，
  // 以及把对局中弹窗（悔棋/求和等）与提示条精确对齐到棋盘中心
  const { containerRef, boardRef, boardFrame, containerOrigin, measure: measureBoardFrame } = useBoardFrame();

  // 当前棋盘样式：名称角标行宽度需按样式几何换算棋盘本体宽度（用户可在首页设置中切换样式）
  const boardStyle = useBoardStyle();

  // 绝杀特效弹出前兜底重测：boardPadTop/maxBoardHeight 变化只挪动棋盘（相对父级布局不变，
  // 包裹层 onLayout 可能不触发），此处按绝对坐标重新测量，保证特效对齐的是最新棋盘位置
  useEffect(() => {
    if (!jueShaVisible) return;
    measureBoardFrame();
  }, [jueShaVisible, boardPadTop, maxBoardHeight, measureBoardFrame]);

  // 棋盘本体真实尺寸（外层容器宽=屏宽，onBoardLayout 回报的才是棋盘宽），由 ChessBoard 回报
  const [boardSize, setBoardSize] = useState<{ width: number; height: number } | null>(null);

  // 名称角标行宽度：取棋盘本体宽度并水平居中，使角标行左右边缘与棋盘边缘对齐
  // （宽屏下棋盘因纵向预算被压缩居中，角标行若铺满整屏会贴到屏幕最左/最右）
  const nameRowStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight ?? 0),
    [screenWidth, boardStyle, maxBoardHeight]
  );

  // 底部操作栏宽度：同样跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕
  const bottomBarWidthStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight ?? 0),
    [screenWidth, boardStyle, maxBoardHeight]
  );

  // 绝杀特效对齐用的棋盘框：测量框宽=屏宽（外层容器），按棋盘本体宽度在其中水平居中换算，
  // 得到棋盘本体的真实 x/宽，保证特效中心与按钮宽度口径都落在棋盘本体上
  const jueshaBoardFrame = useMemo(() => {
    if (!boardFrame) return null;
    const w = boardSize?.width ?? boardFrame.width;
    const h = boardSize?.height ?? boardFrame.height;
    return {
      x: boardFrame.x + (boardFrame.width - w) / 2,
      y: boardFrame.y,
      width: w,
      height: h,
    };
  }, [boardFrame, boardSize]);

  // 结算浮层（JueShaOverlay）用的棋盘矩形，单位为其所在宿主容器的坐标系。
  // jueshaBoardFrame 是相对根容器（containerRef）测量的，而浮层实际挂在棋盘内容宿主
  // boardHost 里——该宿主相对根容器向下偏移了 boardHostY（实测 62px），
  // 直接把根容器坐标喂给浮层会让「绝/杀」特效、结果提示条与棋盘底下方按钮整体下移 62px。
  // boardFrame prop 的约定本就是「浮层容器内」的坐标，故在此完成换算。
  const jueshaHostBoardFrame = useMemo(() => {
    if (!jueshaBoardFrame) return null;
    // 宿主是根容器的纵向 flex 子节点、铺满整行宽度，x 方向无偏移，故只换算 y
    return { ...jueshaBoardFrame, y: jueshaBoardFrame.y - boardHostY };
  }, [jueshaBoardFrame, boardHostY]);

  // 对局内提示条（GameNotice）的棋盘中心纵坐标，单位与主容器一致（容器相对）：
  // 提示条挂载在 boardHost 内，而 jueshaBoardFrame 正是相对根容器测量的，
  // 两者相差 boardHostY，需换算；缺测量时返回 undefined 由 GameNotice 退回容器 50% 居中。
  const noticeCenterY = useMemo(() => {
    if (!jueshaBoardFrame) return undefined;
    return jueshaBoardFrame.y + jueshaBoardFrame.height / 2 - boardHostY;
  }, [jueshaBoardFrame, boardHostY]);

  // 对局中弹窗（悔棋/求和请求）的棋盘中心锚点，单位为窗口坐标：
  // boardFrame 是相对主容器的坐标，而 <Modal> 渲染在独立原生窗口、以窗口为坐标系，
  // 两者必须加 containerOrigin（容器自身的窗口原点）才能对齐。缺任一项则返回 null，
  // 由 AppModal 退回 placement 的原有定位。
  const dialogAnchorCenter = useMemo(() => {
    if (!jueshaBoardFrame || !containerOrigin) return null;
    return {
      x: containerOrigin.x + jueshaBoardFrame.x + jueshaBoardFrame.width / 2,
      y: containerOrigin.y + jueshaBoardFrame.y + jueshaBoardFrame.height / 2,
    };
  }, [jueshaBoardFrame, containerOrigin]);

  // 房间设置
  const [turnTimeLimit, setTurnTimeLimit] = useState(0); // 秒，0=不限时
  // 房间对战设置（基本用时+加秒制）：局时/加秒/让子，由房间详情轮询与对局状态负载双向同步
  const [baseTimeSeconds, setBaseTimeSeconds] = useState(0); // 局时（秒），0=不限时（不显示时钟）
  const [roomHandicap, setRoomHandicap] = useState<number[]>([]); // 红方让出的棋子 id 列表
  const roomHandicapRef = useRef<number[]>([]); // 上传初始局面时同步取用，避免闭包陈旧
  const roomIncrementRef = useRef(0); // 加秒（秒），设置弹窗预填用
  const roomByoyomiRef = useRef(0); // 读秒（秒），0=关闭；时钟芯片读秒阶段展示与设置弹窗预填用
  // 局时时钟快照（服务端权威）与钟面文本由 hooks/useBattleClock 提供，
  // 见下方 useBattleClock 调用处的说明
  const [turnTimeLeft, setTurnTimeLeft] = useState(0); // 当前回合剩余秒数
  const lastMoveTimeRef = useRef<number>(0);
  // 房间设置镜像 ref：供 useBattleStateSync 在回调（非渲染期）中读取最新值
  const turnTimeLimitRef = useRef(0);
  turnTimeLimitRef.current = turnTimeLimit;

  const roomId = params.roomId;
  const playerId = params.playerId;
  const mySideRef = useRef(params.side || 'red');
  const [mySide, setMySide] = useState<string>(params.side || 'red');
  const [opponentName, setOpponentName] = useState<string>('');
  // 对局内 emoji 表情：表情栏展开状态、当前活跃表情、已见消息 id 去重
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [activeEmojis, setActiveEmojis] = useState<ActiveEmoji[]>([]);
  const seenEmojiIdsRef = useRef<Set<string>>(new Set());
  // 去重后把表情加入本地活跃列表（我方乐观展示与轮询回显对方表情均走此入口）
  // 声明在轮询 effect 之前，供其依赖与调用
  const addActiveEmoji = useCallback((msg: { id: string; playerId: string; emoji: string }) => {
    if (seenEmojiIdsRef.current.has(msg.id)) return;
    seenEmojiIdsRef.current.add(msg.id);
    setActiveEmojis(prev => [...prev, { id: msg.id, playerId: msg.playerId, emoji: msg.emoji, receivedAt: Date.now() }]);
  }, []);
  // 占用音频会话（联机对局同样播放走子音效，避免首声漏播）。
  // 【v5】引用计数：栈上可能同时存在多个会发声的屏（如 /spectate），
  // 由最后一个使用者离开时才真正释放，避免先弹出的屏拆掉别人的音频。
  useEffect(() => {
    void acquireSoundSession();
    return () => { void releaseSoundSession(); };
  }, []);
  const gameStartTimeRef = useRef<number>(0);
  const [gameDuration, setGameDuration] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false); // 轮询并发防护：慢网下避免请求堆叠、旧响应乱序覆盖新状态

  // 断线重连状态
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);
  const [disconnectCountdown, setDisconnectCountdown] = useState(60); // 断线等待倒计时（秒）
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 会话已终结（房间被销毁/本人被移出/断线判负后房间解散）：
  // 页面必须切到终结态并给出返回大厅入口——Web 端 Alert.alert 是空实现（react-native-web 未实现），
  // 只靠弹窗会导致「服务端房间已销毁、前端 UI 仍停在棋盘」的卡死，因此改用可见的终态浮层。
  const [sessionGone, setSessionGone] = useState<{ title: string; hint: string } | null>(null);
  const sessionGoneRef = useRef(false);
  // 本端曾被服务端标记断线（据此把终态文案区分为「断线判负」而非泛化的「房间已关闭」）
  const selfDisconnectedRef = useRef(false);
  // 页面是否处于后台（Web 切标签页 / 移动端切后台）：心跳携带该标记，服务端据此在节流场景宽容判定
  const pageHiddenRef = useRef(false);
  // 主动退出标记：返回按钮/侧滑等本人主动离开房间时置位。
  // 离开请求会让服务端销毁房间（独住房主）或移出本人，与 2s 轮询存在竞态——
  // 在途轮询可能拿到 404 或「成员列表无本人」，误报「房间已关闭/你已被移出房间」。
  // 置位后轮询入口与告警点双重短路。
  const intentionalExitRef = useRef(false);

  // 在线对局 WebSocket：连接实例、连接状态，以及最新状态处理函数的引用
  // （用 ref 持有处理函数，避免把大量依赖塞进轮询/WS effect 造成频繁重建）
  const battleSocketRef = useRef<BattleSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const applyServerStateRef = useRef<(data: Record<string, unknown>) => void>(() => undefined);

  // 悔棋协商状态
  const [undoPending, setUndoPending] = useState(false); // 我方已发起，等待对方同意
  const undoPendingRef = useRef(false);
  const [undoRequestFromOpponent, setUndoRequestFromOpponent] = useState(false); // 对方发起的悔棋请求
  // 【悔棋深度】对方请求要回退几手（服务端锁定）：弹窗据此措辞，避免同意后才发现撤了几步
  const [opponentUndoDepth, setOpponentUndoDepth] = useState<0 | 1 | 2>(0);
  // 求和协商状态
  const [drawPending, setDrawPending] = useState(false); // 我方已发起求和，等待对方同意
  const drawPendingRef = useRef(false);
  const [drawRequestFromOpponent, setDrawRequestFromOpponent] = useState(false); // 对方发起的求和请求
  // 协商封禁：本局悔棋/求和分别被对方连续拒绝 2 次后，禁止再发起对应请求（服务端权威计数，重赛重置）
  const [undoBlocked, setUndoBlocked] = useState(false);
  const undoBlockedRef = useRef(false);
  const [drawBlocked, setDrawBlocked] = useState(false);
  const drawBlockedRef = useRef(false);

  // ===== 对局内低干扰提示条（GameNotice）=====
  // 重构前这 10 处反馈全部走 `Alert.alert`：react-native-web 未实现它，
  // 导致「长将长捉超限提示」「网络异常」等关键提示在 Web 端完全无显示。
  // 现统一改为覆盖在棋盘上的 GameNotice（3s 自动淡出，不阻塞落子）。
  const [notice, setNotice] = useState<GameNoticeItem | null>(null);
  // key 由文案决定而非自增序号（【提示口径 2026-10】）：GameNotice 只在 key 变化时
  // 重新计时，自增序号会把「每走一步都触发的提示」当成新提示反复重播，提示条
  // 因此常驻刷屏。规则一的判和预警文案自带累计数字（如「已 119 步无吃子…」），
  // 同类预警在走子方交替时内容不变，于是整个过程只响一次。
  // 同文案仍会重新出现的情形：上一条已淡出（notice 变 null），用户可能已经错过。
  const showNotice = useCallback((text: string, detail?: string, duration?: number) => {
    setNotice((prev) =>
      prev && prev.text === text && prev.detail === detail
        ? prev
        : { key: `notice-${text}-${detail ?? ''}`, text, detail, duration }
    );
  }, []);
  const hideNotice = useCallback(() => setNotice(null), []);

  // ===== 断线重连显式上报 =====
  // 「重连成功」以玩家真正回到对局页面为准：服务端仅由 POST /reconnect 清除断线等待，
  // WS/心跳的自动上线仅代表连接层恢复，不代表玩家已回到房间。
  // 触发时机：页面聚焦、App 回到前台、WS 重连成功、从最新对局状态发现自己被标记断线。
  const lastReconnectSentAtRef = useRef(0);
  const sendReconnect = useCallback(async () => {
    if (AppState.currentState !== 'active') return; // 后台的自动上线不算重连成功
    const now = Date.now();
    if (now - lastReconnectSentAtRef.current < 4000) return; // 多触发源节流去重
    lastReconnectSentAtRef.current = now;
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：POST /api/v1/lan/rooms/:roomId/reconnect
       * Body 参数：playerId: string
       */
      await fetch(`${base}/api/v1/lan/rooms/${roomId}/reconnect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 【S-1 / §3.1】鉴权凭证。改造后服务端只认 token，不再接受 body 里的 playerId：
          // 玩家 id 可枚举，任何知道 id 的人都能替对方"重连"清零断线判负倒计时。
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({ playerId }),
      });
    } catch (error) {
      console.error('重连上报失败:', error);
    }
  }, [roomId, playerId]);

  // HTTP 兜底心跳：WS 为主通道（BattleSocket 内部按 2s 发送），此通道用于 WS 断开时的保活与
  // 可见性变化的即时上报。hidden=true 表示页面在后台（浏览器会节流定时器），服务端据此宽容判定。
  const sendHeartbeatNow = useCallback(async () => {
    if (sessionGoneRef.current) return; // 会话已终结（房间已销毁）：不再发送无意义心跳
    try {
      const base = await getOnlineServerUrl();
      await fetch(`${base}/api/v1/lan/rooms/${roomId}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 【S-1 / §3.1】心跳同样凭 token 定位成员：否则任何知道 playerId 的人都能
          // 持续替对方上报心跳，维持 connected=true 规避断线判负。
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({ playerId, hidden: pageHiddenRef.current }),
      });
    } catch (error) {
      console.error('心跳发送失败:', error);
    }
  }, [roomId, playerId]);

  // 会话终结统一处理：房间被销毁 / 本人被移出房间 / 断线判负后房间解散。
  // 服务端权威状态已不可获取（404 或成员列表无本人），此处只做两件事：
  // 切到可见的终态浮层（UI 必须刷新，不能继续停在棋盘上）+ 提供返回大厅入口。
  // 注意：Web 端不可依赖 Alert.alert——react-native-web 的 Alert.alert 是空实现，
  // 只弹窗（不落 UI 状态）正是「房间已销毁但 UI 未刷新」的根因。
  const handleSessionGone = useCallback((reason: 'room-closed' | 'removed' | 'removed-idle') => {
    if (sessionGoneRef.current || intentionalExitRef.current) return; // 主动退出不误报
    sessionGoneRef.current = true;
    // 本端曾被标记断线时，文案按「断线判负」呈现（服务端已判负；房间可能同时被解散）
    const disconnectedLoss = selfDisconnectedRef.current;
    const notice = reason === 'removed-idle'
      ? { title: '已离开房间', hint: '你已被移出房间（连接中断过久）' }
      : reason === 'removed'
        ? disconnectedLoss
          ? { title: '断线判负', hint: '你长时间未回到对局，已被判负' }
          : { title: '已离开对局', hint: '你已不在该房间中' }
        : disconnectedLoss
          ? { title: '断线判负', hint: '你长时间未回到对局，已被判负，房间已关闭' }
          : { title: '对局已结束', hint: '房间已关闭' };
    setSessionGone(notice);
    // 终态浮层必须盖住棋盘，且不能再接受走子：本地阶段切到 ended，停掉心跳与状态轮询
    setPhase('ended');
    // 房间已不存在：结算浮层的「返回房间」等入口必然失败，改用终态浮层统一收口
    setJueShaVisible(false);
    setOpponentDisconnected(false);
    setUndoRequestFromOpponent(false);
    setOpponentUndoDepth(0); // 【悔棋深度】残留的协商深度必须随请求一起清掉
    setDrawRequestFromOpponent(false);
    // 【S-1 / §3.1】会话终结 → 本地凭证已无意义（席位已被服务端移除或房间已销毁），
    // 必须清掉，否则下次进同一 roomId 的房间会带着过期 token，且在存储里无限堆积。
    void clearRoomSessionToken(roomId, playerId);
  }, [roomId, playerId]);

  // 页面可见性变化（Web 切标签页 / 移动端切后台）→ 立即同步服务端：
  // - 进入后台：趁定时器尚未被节流，立刻上报 hidden=true，服务端在宽容窗口内不判定断线
  // - 回到前台：立即上报 hidden=false（清断线等待）+ 补发心跳 + 即时重连被回收的连接，
  //   消除「后台被节流 → 回前台仍处于断线倒计时/已被判负」的缺口
  useEffect(() => {
    const applyVisibility = (hidden: boolean) => {
      pageHiddenRef.current = hidden;
      battleSocketRef.current?.setHidden(hidden);
      if (hidden) return;
      // 回到前台：WS 通道补发心跳并即时重连；HTTP 兜底通道同步补发，并显式上报重连
      void sendHeartbeatNow();
      sendReconnect();
    };
    // AppState 在 Web 端同样由 document 可见性驱动（react-native-web 实现），两端统一走它
    const sub = AppState.addEventListener('change', (state) => {
      applyVisibility(state !== 'active');
    });
    // Web 额外兜底：bfcache 恢复/窗口重新聚焦时 visibilitychange 可能不触发，补两个事件源
    const onResume = () => applyVisibility(false);
    const win = Platform.OS === 'web' && typeof window !== 'undefined' ? window : null;
    win?.addEventListener?.('focus', onResume);
    win?.addEventListener?.('pageshow', onResume);
    // 初始化：进入页面时按当前可见性对齐一次（后台标签页直接打开对局链接的场景）
    applyVisibility(AppState.currentState !== 'active');
    return () => {
      sub?.remove();
      win?.removeEventListener?.('focus', onResume);
      win?.removeEventListener?.('pageshow', onResume);
    };
  }, [sendReconnect, sendHeartbeatNow]);

  // 检查房间状态（等待对手加入/准备）
  useFocusEffect(
    useCallback(() => {
      // 页面聚焦即显式上报重连（覆盖「大厅点击回到对局进入房间」路径）
      sendReconnect();
      const checkRoom = async () => {
        // 已主动退出：离开请求已发出，后续轮询的 404/成员缺失是退出竞态的必然结果，直接短路
        // 会话已终结（房间已销毁/已被移出）：终态浮层已给出，无需继续轮询
        if (intentionalExitRef.current || sessionGoneRef.current) return;
        try {
          const base = await getOnlineServerUrl();
          // 携带 playerId：服务端据此刷新成员活跃时间，等待清扫器不会把 HTTP 轮询活跃但 WS 异常的成员误踢
          const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}?playerId=${encodeURIComponent(playerId)}`, {
            // 【2026-10 审计 P1】服务端已收紧：房间密码仅对持 token 的房主可见。
            // 轮询是房主在设置弹窗中回显密码的数据源（roomPassword ← room.password），
            // 必须带上会话凭证；非房主拿到的 password 恒为 null，UI 显示"无"。
            headers: {
              ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
            },
          });
          // 房间已被销毁（如本人无活跃连接被服务端清扫、房主离开致房间解散、断线判负后房间解散）：
          // 切终态浮层并给出返回大厅入口
          // （响应返回时可能已主动退出——在途请求与退出动作的竞态，须再次检查退出标记）
          if (response.status === 404) {
            handleSessionGone('room-closed');
            return;
          }
          const data = await response.json();
          if (data.room) {
            const room = data.room;
            // 服务端时钟校正：后续所有与服务端时间戳的比较统一使用校正时间
            // 第 3 批：偏移量的写入单点在 @/utils/serverClock 的 applyServerNow（§8 表 #7）
            applyServerNow(serverTimeOffsetRef, room.serverNow);
            // 等待阶段表情同步（兜底通道）：WS 断开时经 2s 轮询仍可收到对方表情，按 id 去重
            if (Array.isArray(room.emojiMessages)) {
              for (const m of room.emojiMessages) {
                if (m && typeof m.id === 'string' && typeof m.emoji === 'string') {
                  addActiveEmoji({ id: m.id, playerId: m.playerId, emoji: m.emoji });
                }
              }
            }
            // 获取房间设置与名称
            setRoomName(room.name || '');
            // 服务端收紧后非房主/无 token 一律为 null；拿到非 null 才标记"见过"
            if (room.password != null) passwordSeenRef.current = true;
            setRoomPassword(room.password ?? null);
            setHostId(room.hostId || '');
            // 服务端存储的 turnTimeLimit 单位为秒，直接使用
            setTurnTimeLimit(room.settings?.turnTimeLimit || 0);
            // 基本用时+加秒制设置与让子（对局状态负载中亦会同步，双通道兜底）
            setBaseTimeSeconds(room.settings?.baseTimeSeconds || 0);
            roomIncrementRef.current = room.settings?.incrementSeconds || 0;
            roomByoyomiRef.current = room.settings?.byoyomiSeconds || 0;
            if (Array.isArray(room.settings?.handicap)) {
              roomHandicapRef.current = room.settings.handicap;
              setRoomHandicap(room.settings.handicap);
            }
            // 获取对手信息（名称/选边/准备状态）
            const opponent = room.players.find((p: any) => p.id !== playerId);
            if (opponent) {
              setOpponentName(opponent.name);
              setOpponentReady(!!opponent.ready);
              setOpponentPreference(opponent.sidePreference ?? null);
            } else {
              setOpponentName('');
              setOpponentReady(false);
              setOpponentPreference(null);
            }
            const me = room.players.find((p: any) => p.id === playerId);
            // 本人已不在成员列表：等待阶段是无活跃连接超时被服务端清扫（如切后台过久），
            // 对局中/结算阶段则是断线判负后房间自愈（服务端移出失联成员）——
            // 两种情况都必须刷新 UI，否则前端会永远停在棋盘/结算页
            if (!me) {
              handleSessionGone(room.phase === 'waiting' && phaseRef.current === 'waiting' ? 'removed-idle' : 'removed');
              return;
            }
            // 等待阶段同步自己的准备/选边状态（对手离开会被服务端重置）
            if (me && phaseRef.current === 'waiting' && !revealStartedRef.current) {
              // 本端刚切换准备或有请求在途时，不用轮询的服务端旧数据覆盖本端状态，避免按钮回跳；
              // 宽限窗口（2.5s > 轮询间隔 2s）后服务端已完成同步，恢复正常对账
              const recentlyToggled = Date.now() - lastReadyToggleRef.current < 2500;
              if (readyInFlightRef.current === 0 && !recentlyToggled) {
                myReadyRef.current = !!me.ready;
                setMyReady(!!me.ready);
              }
              setMyPreference(me.sidePreference ?? null);
            }
            // 公示被取消（对方退出/死连被清扫，服务端已清空公示与统一定时）→ 中止倒数回准备阶段；
            // 已本地进局但服务端未开局（对方在倒数窗口内离开）→ 同样回退，避免单人空局卡死。
            //
            // 必须限定在本端仍处于公示/倒数/对局阶段：结算之后（phaseRef==='ended'）房间被
            // 重置为 waiting 时同样满足 room.phase==='waiting' && !room.sideReveal，而
            // revealStartedRef 自 startRevealSequence 置 true 起要到重置/中止才清回，结算期一直为
            // true，于是本端会被 abortRevealSequence 从结算页硬拽回准备界面——对手点一次
            // 「返回房间」就把我也带走，正是这个条件漏判导致的。
            const inRevealSequence =
              phaseRef.current === 'reveal' ||
              phaseRef.current === 'countdown' ||
              phaseRef.current === 'playing';
            if (room.phase === 'waiting' && !room.sideReveal && !uploadedRef.current && inRevealSequence) {
              abortRevealSequence();
            }
            // 双方已准备且阵营已分配 → 启动公示→倒数序列（只启动一次，倒数锚定服务端统一开局时刻）
            if (room.sideReveal && me?.side && !revealStartedRef.current) {
              startRevealSequence(me.side, !!room.sideReveal.random, room.gameStartAt ?? null);
            }
            // 对局已开始：同步状态
            if (room.phase === 'playing') {
              const roomMatchId = typeof room.matchId === 'number' ? room.matchId : 0;
              if (me?.side) {
                mySideRef.current = me.side;
                setMySide(me.side);
              }
              if (phaseRef.current === 'waiting') {
                // 未经历公示（如刷新重进）→ 直接进入对局。
                // 重赛重置后可能先收到上一局的旧快照（phase=playing + 旧 matchId），
                // 仅当服务端开出新局（matchId 大于本端已入局纪元）才进入对局，否则跳过准备阶段
                if (room.gameStartTime && roomMatchId > playedMatchIdRef.current) {
                  playedMatchIdRef.current = roomMatchId;
                  setPhase('playing');
                  gameStartTimeRef.current = room.gameStartTime;
                }
              } else if (phaseRef.current === 'reveal' || phaseRef.current === 'countdown') {
                // 上传方已开局：提前结束本地公示/倒数序列
                playedMatchIdRef.current = Math.max(playedMatchIdRef.current, roomMatchId);
                finishSequenceEarly();
                if (room.gameStartTime) {
                  gameStartTimeRef.current = room.gameStartTime;
                }
              } else if (phaseRef.current === 'playing') {
                // 本地倒数到点已先进局（新流程不再等待上传结果）：以服务端纪元校准已入局
                // 纪元——重赛后识别「上一局旧快照」（matchId 不增即忽略）依赖该值，非上传方
                // 此前无机会更新它，存在被旧快照误拉回对局的缺口
                playedMatchIdRef.current = Math.max(playedMatchIdRef.current, roomMatchId);
                if (room.gameStartTime && gameStartTimeRef.current === 0) {
                  gameStartTimeRef.current = room.gameStartTime;
                }
              }
            }
            // 兜底：上传方掉线未上传初始局面（公示超过12秒仍在 waiting）→ 本端接管上传
            // （sideReveal.time 为服务端时钟，须用校正后的服务端时间比较）
            if (
              room.sideReveal &&
              room.phase === 'waiting' &&
              !uploadedRef.current &&
              // 第 3 批：走 serverNow（§8 表 #7）
              serverNow(serverTimeOffsetRef) - room.sideReveal.time > 12000
            ) {
              uploadInitialGame();
            }
            // 房间从 ended 回到 waiting → 本端跟随回到准备界面。
            // 「返回房间」是互不干扰语义：对方点他的按钮会重置房间，但**不会**把本端一起拽走——
            // 只有本端自己也点过（returnedToRoom 含 playerId），或结算兜底倒计时归零后
            // 由本端自己发起，才切换。未表态时留在结算页，等自己的倒计时到点或对手离开。
            if (room.phase === 'waiting' && phaseRef.current === 'ended') {
              const returned = (room.returnedToRoom ?? {}) as Record<string, number>;
              const iReturned = !!returned[playerId];
              if (iReturned || returnFallbackFiredRef.current) {
                resetForRematch();
              } else {
                // 房间已被对方重置但本端未表态：**保持结算页与兜底倒计时不变**，让玩家
                // 看到「对方已返回房间」提示后，自己决定点「返回房间」还是等倒计时到点。
                // 早期实现在这里收起浮层（settlementDismissed=true），结果本端还在倒计时中
                // 「返回房间」按钮就被换成了占位——这正是「点了没反应、按钮也消失了」的 BUG。
                // 双方互不干扰的前提是：本端在倒计时结束前，操作入口必须一直在。
              }
            }
          }
        } catch (error) {
          console.error('检查房间状态失败:', error);
        }
      };

      checkRoom();
      const interval = setInterval(checkRoom, 2000);
      return () => clearInterval(interval);
    }, [roomId, playerId, sendReconnect, handleSessionGone])
  );

  // 局时时钟的本地插值（1s 走钟 + 读秒/警示展示）。实现见 hooks/useBattleClock：
  // 它只在 phase === 'playing' 期间持有定时器，并把扣减算术暴露为纯函数 computeClockText。
  // 必须声明在 useBattleStateSync 之前：后者要通过 clockSnapRef 写入服务端快照。
  const { clockText, clockSnapRef } = useBattleClock({
    phase,
    mySide,
    serverTimeOffsetRef,
    byoyomiRef: roomByoyomiRef,
  });

  // 服务端负载 → 页面状态的统一处理（HTTP 轮询响应与 WebSocket state 推送共用）。
  //
  // 实现见 hooks/useBattleStateSync：与观战页共用同一套字段映射，并保证
  // 「本端走子乐观保护」只延迟**局面块**，而 returnedToRoom / 结算 / 重赛跟随 /
  // 协商 / 断线 / 表情等控制信息在任何情况下都照常处理。
  // 旧实现在乐观保护分支直接 return（退出整个函数），会在该着法被服务端拒绝
  // （拒绝时不广播 state）后连续 8 秒丢弃所有状态推送，界面静默卡在旧画面。
  const {
    applyPayload: applyServerState,
    markOptimisticMove,
    rollbackOptimisticMove,
    handleActionRejected,
    resetSyncBaseline,
  } = useBattleStateSync({
    selfId: playerId,
    // mySide 可能因选边结果/重赛而变化，故传取值函数而非快照
    resolveMySide: () => mySideRef.current,
    currentPhase: () => phaseRef.current,
    rematchFollowedFallback: () => returnFallbackFiredRef.current,
    serverTimeOffsetRef,
    lastMoveTimeRef,
    // 【P5】把实测 RTT 交给同步 Hook，乐观保护窗口按线路标定而非写死 8 秒
    rttMs: () => battleSocketRef.current?.rttMs || FALLBACK_RTT_MS,
    turnTimeLimitRef,
    byoyomiRef: roomByoyomiRef,
    clockSnapRef,
    pendingMoveRef: pendingSyncRef,
    pendingUndoRef: undoPendingRef,
    pendingDrawRef: drawPendingRef,
    undoBlockedRef,
    drawBlockedRef,
    selfDisconnectedRef,
    requestReconnect: () => { void sendReconnect(); },
    setGameState,
    setBaseTimeSeconds,
    roomIncrementRef,
    roomByoyomiRef,
    roomHandicapRef,
    setRoomHandicap,
    setUndoBlocked,
    setDrawBlocked,
    setUndoPending,
    setDrawPending,
    setUndoRequestFromOpponent,
    setOpponentUndoDepth,
    setDrawRequestFromOpponent,
    setOpponentDisconnected,
    setDisconnectCountdown,
    handlers: {
      // 局面已应用（未被乐观保护延迟）：同步最近一步光环、对手走棋特效与音效
      onBoardApplied: ({ state, historyLen, prevHistoryLen, lastMove }) => {
        // 最近一步光环：以服务端着法序列为准，仅在着法数变化时更新，避免无效重渲染
        // 【P4】lastMove 由负载直接给出（增量载荷不再下发完整 moveHistory）
        if (historyLen !== prevHistoryLen) {
          setLastMove(
            lastMove
              ? {
                  fromCol: lastMove.fromCol,
                  fromRow: lastMove.fromRow,
                  toCol: lastMove.toCol,
                  toRow: lastMove.toRow,
                }
              : null
          );
        }
        // 对手走棋检测：着法数增加且最后一步是对方的棋子 → 触发吃子/将军特效
        // （自己走棋已在本地 handleMove 触发；悔棋使着法数减少，不满足条件）
        if (historyLen <= prevHistoryLen) return;
        if (!lastMove) return;
        const last = lastMove;
        const mySideTag = sideStringToTag(mySideRef.current);
        // pieceId 16-31 为红方、0-15 为黑方；与本方阵营不同即对手所走
        const isOpponentMove = mySideTag ? last.pieceId < 16 : last.pieceId >= 16;
        if (!isOpponentMove) return;
        // 终局（对方绝杀/困毙我方）时不播，由绝杀特效接管
        triggerMoveEffect(last.capturedPieceId, state.isCheck, phaseRef.current === 'ended');
        // 对手走子音效：将军时播男声将军语音（内置节流），否则吃子/走子音（终局不播）
        if (phaseRef.current !== 'ended') {
          if (state.isCheck) {
            playJiangJunSound();
          } else if (last.capturedPieceId !== -1) {
            playSound('eat');
          } else {
            playSound('go');
          }
        }
      },
      onEnded: ({ winner, isDraw, surrenderBy, endReason, moveCount, duration }) => {
        setGameResult({
          winner,
          isWin: !isDraw && winner === mySideRef.current,
          duration,
          moveCount: moveCount || 0,
          surrenderBy,
          isDraw,
        });
        setPhase('ended');
        setGameEndReason(endReason);
        // 所有结束方式都展示结算界面；其中仅绝杀/困毙播放「绝/杀」特效，
        // 认输/和棋/断线判负由 showEffect 控制为普通文字结算
        setJueShaVisible(true);
      },
      // 房间已被重置为等待中：是否跟随回到准备界面取决于**本端**是否已表态
      // （本端点过「返回房间」或结算兜底倒计时已归零才跟随，否则留在结算页）
      onRematchFollowed: () => resetForRematch(),
      onOpponentReturned: returned => setOpponentReturned(returned),
      onEmoji: message => addActiveEmoji(message),
      onUndoResult: (result, blocked) => {
        showNotice(
          result.reason === 'timeout'
            ? '对方未响应，悔棋请求已取消'
            : blocked
              ? '对方拒绝了悔棋请求，本局不能再发起悔棋'
              : '对方拒绝了悔棋请求'
        );
      },
      onDrawResult: (result, blocked) => {
        showNotice(
          result.reason === 'timeout'
            ? '对方未响应，求和请求已取消'
            : blocked
              ? '对方拒绝了求和请求，本局不能再发起求和'
              : '对方拒绝了求和请求'
        );
      },
      onSelfMarkedDisconnected: () => {
        // 记录「本端曾因断线被标记」：若后续房间被解散，终态文案据此显示为断线判负
        selfDisconnectedRef.current = true;
      },
      // 动作被服务端拒绝或长时间无回执：局面乐观更新已回退、在途协商状态已清理
      onActionFailure: message => showNotice(message),
    },
  });

  // 保持 ref 指向最新的处理函数（轮询/WS 回调经 ref 调用，避免依赖抖动导致 effect 重建）
  useEffect(() => {
    applyServerStateRef.current = applyServerState;
  });

  // 【S-1 / §3.1】会话凭证是否已恢复就绪（供 WS 建连 effect 等待）。
  // 用 state 而非纯 ref：effect 需要在"就绪"这一刻重渲染一次才会执行；
  // tokenResolvedRef 只做「同一 roomId 不重复读存储」的去重。
  const [sessionTokenReady, setSessionTokenReady] = useState(false);

  // 恢复房间会话凭证（异步）：AsyncStorage 读取完成后才能带上 x-session-token。
  // 必须先于 WS 建连：connect() 要读 sessionTokenRef.current 拼 URL，
  // 早于恢复完成就会用空 token 建连、被服务端以「缺少会话凭证」拒绝（该拒绝是致命的，
  // 会进入 FATAL_ERROR_MESSAGES 而不再重连，页面就此静默失效）。
  useEffect(() => {
    if (!roomId || !playerId || tokenResolvedRef.current) return;
    tokenResolvedRef.current = true;
    let cancelled = false;
    void (async () => {
      // 先试内存缓存（大厅刚创建/加入时已写入，绝大多数走这条零异步路径）
      const cached = peekRoomSessionToken(roomId, playerId);
      if (cached) {
        if (cancelled) return;
        sessionTokenRef.current = cached;
        setSessionTokenReady(true);
        return;
      }
      // 缓存未命中：读持久化（App 被杀掉后重进对局页的冷启动路径）
      const token = await getRoomSessionToken(roomId, playerId);
      if (cancelled) return;
      sessionTokenRef.current = token;
      setSessionTokenReady(true);
      if (!token) {
        // 本地没有可用凭证：可能是清了应用数据、换了设备，或房间在服务端已被 GC 后
        // 以同一 roomId 重建。此时所有写操作都会 403、界面空转在准备阶段，
        // 直接切终态让用户回大厅重新加入，别让界面假装"还在房间里"。
        if (!intentionalExitRef.current) handleSessionGone('removed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, playerId, handleSessionGone]);

  // 建立在线对局 WebSocket：实时接收状态推送、发送对局动作；断线自动重连由 BattleSocket 内部处理
  useEffect(() => {
    if (!roomId || !playerId) return;
    // 凭证恢复未完成前不建连：服务端会以「缺少会话凭证」拒绝，而该拒绝是致命的
    //（进入 FATAL_ERROR_MESSAGES 后不再重连）。等上面的恢复 effect 置位后重渲染再连。
    if (!sessionTokenReady) return;
    const socket = new BattleSocket(roomId, playerId, {
      onState: data => applyServerStateRef.current(data),
      onStatusChange: connected => {
        setWsConnected(connected);
        // WS 重连成功且 App 在前台：显式上报重连（后台自动重连不算，sendReconnect 内部有前台校验）
        if (connected) sendReconnect();
      },
      // 服务端判定重连无意义（房间已销毁/本人已被移出房间）：立刻切终态 UI 并给出返回大厅入口。
      // 该回执是断线判负后房间解散时本端唯一的权威信号，必须消费，否则页面会永远停在棋盘上。
      // kind='network'（自动重连用尽）只是长时间离线：会话可能仍有效，绝不能切终态，
      // 否则会误报"房间已关闭"并停掉心跳/轮询；只提示用户，回前台或重新聚焦会重新开始重连。
      onFatalError: (message, kind) => {
        setWsConnected(false);
        if (kind === 'network') {
          showNotice('网络连接已断开', '请检查网络后返回本页面，将自动重新连接', 5000);
          return;
        }
        handleSessionGone(message.includes('不在房间') ? 'removed' : 'room-closed');
      },
      // 服务端拒绝了本端动作（非 request() 通道，如带 reqId 的即时动作）：统一回退乐观更新并提示
      onActionRejected: info => {
        handleActionRejected(
          new BattleActionRejectedError(info.action ?? 'move', info.status, info.message)
        );
      },
      // 协议级失败（「观战者无法执行该操作」「未知消息类型」等）：此前被静默丢弃，
      // 表现为「点了没反应」。服务端文案本身就是面向用户的，直接透出。
      onError: message => showNotice(message),
      // 【P5】被丢弃的动作帧数（连接重建时会补发队列；若整条队列都被挤出，
      // 说明离线时间很长，此时提示用户而不是让着法静默消失）
      onFramesDropped: count => {
        showNotice(`${count} 条操作未能送达`, '连接刚刚恢复，最新的一手可能需要重走', 4000);
      },
      // WS 建连时传入凭证读取器（【S-1 / §3.1】）：connect() 每次重连都重读，
      // 因此凭证刷新后无需重建 BattleSocket 也能带上新 token。
    }, 'player', () => sessionTokenRef.current || null);
    battleSocketRef.current = socket;
    // 同步当前可见性：后台标签页刷新/直接打开对局链接时，连接建立后首个心跳就要带 hidden=true
    socket.setHidden(pageHiddenRef.current);
    socket.connect();
    return () => {
      battleSocketRef.current = null;
      socket.close();
    };
    // sessionTokenReady 是刻意依赖：凭证恢复完成才建连（见上方注释）。
    // 读取走 ref（connect 每轮重连都重读），因此 token 内容变化不会重建本 effect。
  }, [roomId, playerId, sessionTokenReady, sendReconnect, handleSessionGone]);

  // 对局中轮询游戏状态（WebSocket 兜底通道：仅在 WS 未连接时启用）
  useEffect(() => {
    if (phase !== 'playing') return;
    if (wsConnected) return; // WS 已连接时由服务端推送驱动，无需轮询

    const poll = async () => {
      if (pollInFlightRef.current) return; // 上一次轮询未返回则跳过，防止并发乱序
      if (sessionGoneRef.current) return; // 房间已终结：停止无意义轮询
      pollInFlightRef.current = true;
      try {
        const base = await getOnlineServerUrl();
        const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/gameState`);
        // 房间已销毁（断线判负后解散、房主离开等）：404/非 2xx 时 body 不是对局状态负载，
        // 直接交给 applyServerState 会被静默忽略 → 前端停在棋盘上不刷新。此处显式切终态。
        if (response.status === 404) {
          handleSessionGone('room-closed');
          return;
        }
        const data = await response.json();
        applyServerStateRef.current(data);
      } catch (error) {
        console.error('获取游戏状态失败:', error);
      } finally {
        pollInFlightRef.current = false;
      }
    };

    poll();

    // 【P5】轮询周期按实测 RTT 标定，而不是写死 1 秒。
    //
    // 原先固定 1000ms：实测本站线路一次 /gameState 往返约 722ms（串行 6 次总耗时 4332ms），
    // 于是**每一轮定时器触发时上一次请求都还在路上**，pollInFlightRef 只能丢掉一半的轮询，
    // 剩下的又因为周期短于 RTT 而永远追不上——纯粹是把带宽喂给隧道。
    //
    // 改为 max(2000, RTT×3)：既保证轮询之间不重叠（不再浪费一半请求），
    // 又保持兜底通道的可见延迟在几秒内（它只是 WS 断线时的保底，不是主通道）。
    const interval = Math.max(2000, Math.round((battleSocketRef.current?.rttMs || FALLBACK_RTT_MS) * 3));
    pollRef.current = setInterval(poll, interval);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase, roomId, wsConnected, handleSessionGone]);

  // 心跳发送（对局中每5秒发送一次；可见性变化时由上方可见性 effect 立即补发）
  useEffect(() => {
    if (phase !== 'playing') return;

    void sendHeartbeatNow(); // 立即发送一次
    heartbeatRef.current = setInterval(() => { void sendHeartbeatNow(); }, 5000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    };
  }, [phase, sendHeartbeatNow]);

  // 断线等待倒计时
  useEffect(() => {
    if (!opponentDisconnected) return;

    const timer = setInterval(() => {
      setDisconnectCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [opponentDisconnected]);

  // 对局中计时器
  useEffect(() => {
    if (phase !== 'playing') return;

    const timer = setInterval(() => {
      if (gameStartTimeRef.current > 0) {
        // 第 3 批 / §8 #7：gameStartTime 来自服务端载荷，须用校正后的服务端时间求差
        setGameDuration(serverElapsedMs(serverTimeOffsetRef, gameStartTimeRef.current));
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [phase]);

  // 进入对局的本地初始化（不触碰服务端）
  const enterPlayingLocal = () => {
    setSelectedPieceId(null);
    setValidMoves(null);
    setLastMove(null);
    setPhase('playing');
    // 【C-40】步时锚点必须落在服务端时间轴上（与 useBattleStateSync 写入的服务端
    // lastMoveTime 同源），否则下次快照覆盖后倒计时会跳一次。
    // 第 3 批：走 serverNow（§8 表 #7）
    lastMoveTimeRef.current = serverNow(serverTimeOffsetRef);
    setTurnTimeLeft(turnTimeLimit);
  };

  // 请求开局（仅上传方/接管方执行一次）
  //
  // 【S-8】服务端已删除「客户端上传完整初始局面」的旧协议：开局时由 startPlayingRoom()
  // 自行 buildInitialState() 生成权威初始局面（含让子），客户端不再有任何机会改写它。
  // 因此这里只剩"请服务端开局"一步，且**必须读回校验**——/start 被拒（对方在倒数期间退出、
  // 公示已被清理、token 失效等）时本端不能自认为已开局，否则会带着空/过期局面继续走子。
  const uploadInitialGame = async () => {
    // 不能提前置 uploadedRef.current = true：只有确认服务端已开局才置位，
    // 失败必须留出重试机会（轮询与接管路径都依赖它）。
    if (uploadedRef.current) return;
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：POST /api/v1/lan/rooms/:roomId/start
       * 鉴权：请求头 x-session-token（或 body.sessionToken）
       * Body 参数：playerId: string（仅供日志/兼容，服务端已不再据此鉴权）
       */
      const startResp = await fetch(`${base}/api/v1/lan/rooms/${roomId}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({ playerId }),
      });
      const startData = await startResp.json();
      if (!startData?.success) {
        // 开局被服务端拒绝 → 不置位；本端是否留在对局由轮询对账决定
        // （服务端 waiting + 公示清空 → 自动回退准备阶段）
        uploadedRef.current = false;
        // 【S-1】403 身份校验失败：本端 token 已失效（例如房间被 GC 后重建、或
        // 幂等重入时被重新签发）。按会话终结处理，否则后续每 2s 轮询都会静默空转，
        // 玩家会一直卡在"准备完成但对不了局"的界面。
        if (startResp.status === 403) {
          clearRoomSessionToken(roomId, playerId);
          handleSessionGone('removed');
        }
        return;
      }
      // 记录本局纪元：重赛后旧快照（旧 matchId）不得再把本端拉回对局
      if (typeof startData.matchId === 'number') {
        playedMatchIdRef.current = Math.max(playedMatchIdRef.current, startData.matchId);
      }
      // 开局成功即视为本端已对齐服务端权威局面（旧协议下这里还要上传并读回校验，
      // 现已删除——权威局面由服务端自建，客户端无从、也无权改写）
      uploadedRef.current = true;
      // 【第 3 批 / §8 #7】开局时刻取**服务端时间轴**：该值随后要与服务端载荷里的
      // gameStartTime 做差算局时，本机 Date.now() 会引入设备时钟偏差（表现为局时忽长忽短）。
      // 服务端还没广播 gameStartTime 时，这里给一个同坐标系的值，后续会被真实值覆盖。
      gameStartTimeRef.current = serverNow(serverTimeOffsetRef);
    } catch (error) {
      // uploadedRef 未置位，故本次失败天然允许后续轮询/接管重试
      console.error('请求开局失败:', error);
    }
  };

  // 开始对局（倒数结束）：立即本地进入对局——服务端统一定时会在开局时刻到点后自动开局
  // （≤1s 生效），不再依赖上传方 /start 成功；上传方改为后台提交初始局面，
  // 避免上传请求失败/延迟导致本端永久卡在公示阶段（无法走子、无操作按钮）
  const startGame = () => {
    enterPlayingLocal();
    if (amUploaderRef.current) {
      uploadInitialGame(); // 后台执行：失败由服务端自动开局 + 轮询对账兜底
    }
  };

  // 选边结果视图入场动画：切换到结果公示时淡入 + 上移
  useEffect(() => {
    if (sidePickResultMode) {
      sidePickResultAnim.setValue(0);
      Animated.timing(sidePickResultAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  }, [sidePickResultMode, sidePickResultAnim]);

  // 公示执棋结果：选边弹窗保持不动，内容动画切换为执棋结果，倒数到服务端统一开局时刻后开局（只启动一次）
  // gameStartAt 由服务端在公示时锚定（sideReveal.time + 3s），双端以校正后的服务端时间倒数，
  // 保证两台设备读秒一致、同一时刻开局；无锚点（异常兜底）时按本地 3 秒倒数
  const startRevealSequence = (assignedSide: string, random: boolean, gameStartAt: number | null) => {
    if (revealStartedRef.current) return;
    revealStartedRef.current = true;
    mySideRef.current = assignedSide;
    setMySide(assignedSide);
    setSideRandom(random);
    // 弹窗保持打开，内容切换到结果公示视图（不再使用独立公示/倒数浮层）；
    // 让子直分跳过选边阶段时弹窗尚未打开，此处兜底开启
    setSidePickVisible(true);
    setSidePickResultMode(true);
    setPhase('reveal');
    // 第 3 批：锚点与采样统一走 serverNow（§8 表 #7）
    // 页面此前本地定义了一个同名 lambda，与本模块导入的 serverNow 功能相同，
    // 两份同义写法并存正是「改一处漏一处」的来源，这里去掉本地影子。
    const anchor = gameStartAt ?? (serverNow(serverTimeOffsetRef) + 3000);
    const serverTick = () => serverNow(serverTimeOffsetRef);
    setCountdown(Math.max(1, Math.ceil((anchor - serverTick()) / 1000)));
    // 250ms 采样：两端轮询发现公示存在时间差，锚定倒数可自动对齐到同一开局时刻
    countdownTimerRef.current = setInterval(() => {
      const remain = Math.ceil((anchor - serverTick()) / 1000);
      if (remain > 0) {
        setCountdown(remain);
      } else {
        if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setSidePickVisible(false); // 开局前关闭选边弹窗
        setSidePickResultMode(false);
        startGame();
      }
    }, 250);
  };

  // 公示期间对方退出房间：服务端已清空公示，本端中止倒数、回到准备阶段
  const abortRevealSequence = () => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    revealStartedRef.current = false;
    amUploaderRef.current = false;
    setSidePickVisible(false);
    setSidePickResultMode(false);
    setSidePickStage(false);
    setMyPreference(null);
    setOpponentPreference(null);
    setReadyCountdown(null);
    setPhase('waiting');
  };

  // 对方已开局时提前结束本地公示/倒数序列（两端轮询存在时间差）
  const finishSequenceEarly = () => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    setSidePickVisible(false);
    setSidePickResultMode(false);
    enterPlayingLocal();
  };

  // 选边（双方均准备后开启；对方选定前可自由更改，双方选定后自动公示；让子房间跳过选边）
  const handlePickSide = async (side: 'red' | 'black') => {
    if (!myReady || !opponentReady || revealStartedRef.current) return;
    if (roomHandicapRef.current.length > 0) return;
    const prev = myPreference;
    setMyPreference(side); // 乐观更新
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：POST /api/v1/lan/rooms/:roomId/side
       * Body 参数：playerId: string, side: 'red' | 'black'
       */
      const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/side`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({ playerId, side }),
      });
      const data = await response.json();
      if (!data.success) {
        setMyPreference(prev); // 失败回滚
        return;
      }
      // 第 3 批：偏移量写入走 applyServerNow（§8 表 #7）
      applyServerNow(serverTimeOffsetRef, data.serverNow);
      if (data.sideAssigned) {
        // 双方均已选边：本端为上传方，以服务端锚定的统一开局时刻公示倒数
        amUploaderRef.current = true;
        const me = data.players?.find((p: any) => p.id === playerId);
        if (me?.side) {
          startRevealSequence(me.side, data.sideReveal?.random ?? false, data.gameStartAt ?? null);
        }
      }
    } catch (error) {
      console.error('选边失败:', error);
      setMyPreference(prev); // 失败回滚
    }
  };

  // 打开房间信息/设置弹窗：以当前房间值预填编辑态
  const handleOpenSettings = () => {
    setEditName(roomName);
    setEditPassword(roomPassword || '');
    setEditTurn(turnTimeLimit > 0 ? turnTimeLimit : 0); // 秒，0=不限时
    setEditBaseTime(baseTimeSeconds);
    setEditIncrement(roomIncrementRef.current);
    setEditByoyomi(roomByoyomiRef.current);
    setEditHandicap(roomHandicapRef.current);
    setOpenSelect(null);
    setSettingsVisible(true);
  };

  // 保存房间设置（仅房主、仅等待阶段；成功后在弹窗内给已保存反馈）
  const handleSaveSettings = async () => {
    if (savingSettings) return;
    const trimmedName = editName.trim();
    if (!trimmedName) return;
    setSavingSettings(true);
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：PATCH /api/v1/lan/rooms/:roomId/settings
       * Body 参数：playerId: string, name: string, password: string,
       *   turnTimeSeconds: number, baseTimeSeconds: number, incrementSeconds: number,
       *   byoyomiSeconds: number, handicap: number[]
       */
      const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          // 【S-1 / §3.1】房主校验改由 token 决定（服务端不再信任 body.playerId）
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({
          playerId,
          name: trimmedName,
          // 【2026-10 审计 P1】password 仅对持 token 的房主可见。若弹窗打开时本端还从未
          // 拿到过密码明文（token 异步恢复完成前的轮询竞态），editPassword 为空串只是
          // "还不知道密码"，不是"想清除密码"——此时不传 password（undefined=不修改），
          // 避免把真实密码误清空。见过密码之后（含真实清空操作）恢复直传语义。
          ...(passwordSeenRef.current === true || roomPassword === null ? { password: editPassword.trim() } : {}),
          turnTimeSeconds: editTurn,
          baseTimeSeconds: editBaseTime,
          // 加秒与读秒互斥（UI 已保证二选一，此处再兜底）；不限时时均不生效
          incrementSeconds: editBaseTime > 0 && editByoyomi === 0 ? editIncrement : 0,
          byoyomiSeconds: editBaseTime > 0 && editIncrement === 0 ? editByoyomi : 0,
          handicap: editHandicap,
        }),
      });
      const data = await response.json();
      if (data.success && data.room) {
        // 立即应用新值（轮询也会同步）
        setRoomName(data.room.name || trimmedName);
        // 保存走房主 token，响应里带密码明文；同上维护 passwordSeenRef
        if (data.room.password != null) passwordSeenRef.current = true;
        setRoomPassword(data.room.password ?? null);
        setTurnTimeLimit(data.room.settings?.turnTimeLimit || 0);
        setBaseTimeSeconds(data.room.settings?.baseTimeSeconds || 0);
        roomIncrementRef.current = data.room.settings?.incrementSeconds || 0;
        roomByoyomiRef.current = data.room.settings?.byoyomiSeconds || 0;
        if (Array.isArray(data.room.settings?.handicap)) {
          roomHandicapRef.current = data.room.settings.handicap;
          setRoomHandicap(data.room.settings.handicap);
        }
        setSettingsVisible(false);
      }
    } catch (error) {
      console.error('保存房间设置失败:', error);
    } finally {
      setSavingSettings(false);
    }
  };

  // 准备/取消准备切换：仅在双方未同时就绪前可取消；双方就绪进入倒数/选边/公示后
  // 一律锁定不可取消（公示界面也不再提供取消入口），避免与统一定时产生状态分叉
  const handleReady = async () => {
    if (sidePickStage || revealStartedRef.current) return; // 选边与公示阶段不可取消
    if (readyInFlightRef.current > 0) return; // 有准备请求在途：忽略连点，避免并发请求互相覆盖
    // 用 ref 取最新意向，避免快速连点时闭包读到旧的 myReady 而发送重复请求
    const next = !myReadyRef.current;
    myReadyRef.current = next;
    lastReadyToggleRef.current = Date.now();
    setMyReady(next); // 乐观更新
    if (!next && readyCountdown !== null) setReadyCountdown(null); // 取消准备同时中止本地倒数
    readyInFlightRef.current += 1;
    // 失败兜底重试一次（间隔 600ms）：覆盖服务端阶段刚切换/网络抖动/服务短暂不可用
    // 导致的假性失败——两次均失败才回滚，杜绝「已准备」被瞬时弹回「准备」（跳回）
    let data: {
      success?: boolean;
      bothReady?: boolean;
      autoRevealed?: boolean;
      sideReveal?: { time: number; random: boolean; handicap?: boolean } | null;
      gameStartAt?: number | null;
      players?: { id: string; ready: boolean; side: 'red' | 'black' | null; sidePreference: 'red' | 'black' | null }[];
      message?: string;
    } | null = null;
    try {
      const base = await getOnlineServerUrl();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          /**
           * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
           * 接口：POST /api/v1/lan/rooms/:roomId/ready
           * Body 参数：playerId: string, ready: boolean（false 表示取消准备）
           */
          const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/ready`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
            },
            body: JSON.stringify({ playerId, ready: next }),
          });
          data = await response.json();
          if (data?.success) break;
          console.error(`准备被服务端拒绝(第${attempt + 1}次):`, data?.message ?? data);
        } catch (error) {
          data = null;
          console.error(`准备请求失败(第${attempt + 1}次):`, error);
        }
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 600));
        }
      }
      if (!data?.success) {
        myReadyRef.current = !next;
        setMyReady(!next); // 两次均失败才回滚
        // 成员身份类拒绝（已被移出房间/房间不存在）：切终态 UI 并给出返回大厅入口
        const msg = typeof data?.message === 'string' ? data.message : '';
        if (msg.includes('不在房间') || msg.includes('房间不存在')) {
          handleSessionGone(msg.includes('房间不存在') ? 'room-closed' : 'removed');
        }
        return;
      }
      if (next && data.bothReady) {
        setOpponentReady(true); // 双方均已准备 → 触发 3 秒倒数（让子房间除外：服务端已直分公示）
      }
      // 让子直分：本端为触发方 → 担任上传方并即刻开始公示倒数（跳过选边）
      if (next && data.autoRevealed && data.sideReveal) {
        const assigned = data.players?.find(p => p.id === playerId)?.side;
        if (assigned) {
          amUploaderRef.current = true;
          startRevealSequence(assigned, false, data.gameStartAt ?? null);
        }
      }
    } catch (error) {
      console.error('准备流程异常:', error);
      myReadyRef.current = !next;
      setMyReady(!next); // 前置调用（如获取服务地址）失败 → 回滚
    } finally {
      readyInFlightRef.current -= 1;
    }
  };

  // 判断是否是自己的回合
  const isMyTurn = phase === 'playing' && gameState.sideTag === sideStringToTag(mySide);

  // 双方是否均已准备（均准备后进入选边环节）
  const bothReady = myReady && opponentReady;

  // 双方就绪 → 启动 3 秒倒数；任意方取消（本地或轮询感知）→ 中止倒数并退出选边阶段
  // 让子房间跳过选边：不启动倒数，等待服务端直分公示（ready 响应或轮询发现 sideReveal）
  useEffect(() => {
    if (phase !== 'waiting') return;
    if (bothReady) {
      if (roomHandicapRef.current.length > 0) return;
      if (readyCountdown === null && !sidePickStage && !revealStartedRef.current) {
        setReadyCountdown(3);
      }
      return;
    }
    if (readyCountdown !== null) setReadyCountdown(null);
    if (sidePickStage && !revealStartedRef.current) {
      // 对方在选边阶段取消了准备：回退到准备阶段，清空选边意向并关闭弹窗
      setSidePickStage(false);
      setSidePickVisible(false);
      setMyPreference(null);
      setOpponentPreference(null);
    }
  }, [phase, bothReady, readyCountdown, sidePickStage]);

  // 倒数推进：每秒减一，归零后进入选边阶段并自动弹出选边弹窗
  useEffect(() => {
    if (readyCountdown === null) return;
    if (readyCountdown <= 0) {
      setReadyCountdown(null);
      setSidePickStage(true);
      setSidePickVisible(true);
      return;
    }
    const timer = setTimeout(() => {
      setReadyCountdown(c => (c === null ? null : c - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [readyCountdown]);

  // 处理棋子点击
  const handlePiecePress = (pieceId: number) => {
    if (!isMyTurn || phase !== 'playing') return;

    const piece = gameState.pieces[pieceId];
    if (!piece.alive) return;

    // 棋子ID 0-15 是黑方，16-31 是红方
    const pieceSideTag = pieceId < 16 ? BLACK_SIDE : RED_SIDE;

    // 点击己方棋子：选中并计算落点提示
    if (pieceSideTag === sideStringToTag(mySide)) {
      setSelectedPieceId(pieceId);
      // 落点提示仅按棋子自身走法判定（不因被将军而只剩应将点，避免变相提示）
      setValidMoves(getSelectableMoves(gameState, pieceId));
      return;
    }

    // 点击对方棋子：已选中己方棋子且目标位置合法时吃子
    if (selectedPieceId !== null && validMoves && validMoves[piece.col]?.[piece.row]) {
      handleMove(piece.col, piece.row);
    }
  };

  // 处理走棋/空白处点击
  const handleMove = (toCol: number, toRow: number) => {
    if (selectedPieceId === null || !isMyTurn || phase !== 'playing') return;

    // 落点不在棋子走法内（含过期/空选）：取消选中，恢复默认状态
    if (!validMoves || !validMoves[toCol]?.[toRow]) {
      setSelectedPieceId(null);
      setValidMoves(null);
      return;
    }

    // 送将拦截（2026-09 线上事故修复）：与本地对局页同一口径，落点提示仍给出全部
    // 走点（保持 4ccdae5 的观感），但真的要点下去时，若这步走后己方将/帅仍会被攻击
    // （含将帅照面/白脸将），就地拦下并说明原因，不落子、也不上报服务端。
    // 必须拦在本地这一层：服务端 Pikafish 不会吃将，送将后局面会永久僵在非法状态。
    //
    // 同本地对局页：**不清选中态**，让用户直接改点另一个落点（少一次"点棋子"）。
    if (!isMoveKingSafe(gameState, selectedPieceId, toCol, toRow)) {
      showNotice('着法送将，请另走');
      return;
    }

    // 长将长捉超限禁着（规则二）：一方达到阈值后，再走会继续长将/长捉的着法
    // 预超过阈值，该落点被禁——拦下落子（不上报服务端）并按理由提示变招。
    // 拦的是超限着法本身，变招始终合法。
    //
    // 必须拦在本地这一层：服务端 lanGame.ts 虽也会拒绝（权威裁决，防客户端伪造），
    // 但那时已经发过网络请求，白跑一趟且要等回执才知道被拒。
    // 同送将拦截：**不清选中态**，玩家直接改点另一个落点。
    const banReason = getMoveBanReason(gameState, selectedPieceId, toCol, toRow);
    if (banReason) {
      showNotice(banReasonNotice(banReason));
      return;
    }

    const result = makeMove(gameState, selectedPieceId, toCol, toRow);

    // 吃子/将军特效（终局时不播，由绝杀特效接管）
    triggerMoveEffect(result.captured, result.isCheck, result.isGameOver);
    // 走子音效：将军时播男声将军语音（替代走子音，避免混音重叠），否则吃子/走子音
    if (result.isCheck && !result.isGameOver) {
      playJiangJunSound(); // 男声将军语音（内置节流）
    } else if (result.captured !== -1) {
      playSound('eat');
    } else {
      playSound('go');
    }

    const piece = gameState.pieces[selectedPieceId];
    // 记录乐观更新：上传落地前轮询不得用旧局面覆盖（防棋子回退重走）。
    // 同时保存走子前快照，供服务端拒绝/无回执时回退（见 handleActionRejected）
    markOptimisticMove(result.newState.moveHistory.length, gameState);
    setGameState(result.newState);
    setSelectedPieceId(null);
    setValidMoves(null);
    setLastMove({
      fromCol: piece.col,
      fromRow: piece.row,
      toCol,
      toRow,
    });

    // 规则提示（规则一判和类的到点前一步预警，如「下着将满 120 步判和」）
    if (result.newState.ruleState?.notice) {
      showNotice(result.newState.ruleState.notice);
    }

    // 服务端权威走子上报（方案 0.2.5 / P0）：只发着法，服务端以同一规则引擎
    // 裁决（含长将长捉判定与终局）；本地结果为乐观展示，随后被服务端广播覆盖
    sendPlayerMove({ pieceId: selectedPieceId, toCol, toRow });

    // 检查是否绝杀/困毙/长将长捉规则终局/将帅被吃（本地乐观结算，服务端广播为准）
    if (result.isGameOver) {
      const isDraw = result.newState.gameStatus === 'draw';
      setJueShaVisible(true);
      setGameOverReason(result.gameOverReason);
      // 绝杀/困毙 → 播放绝杀特效；长将/长捉判负、和棋等规则终局 → 仅文字结算
      setGameEndReason(isDraw ? 'draw' : 'checkmate');
      if (isDraw) {
        setGameResult({
          winner: null,
          isWin: false,
          // eslint-disable-next-line react-hooks/purity -- 事件回调中计算对局时长
          duration: serverElapsedMs(serverTimeOffsetRef, gameStartTimeRef.current),
          moveCount: result.newState.moveHistory.length,
          surrenderBy: null,
          isDraw: true,
        });
      } else {
        // 引擎判定真实胜方（长将/长捉判负时走棋方可能为败方，不能默认走棋方获胜）
        const winnerSide: 'red' | 'black' = getWinnerSideTag(result.newState) === RED_SIDE ? 'red' : 'black';
        const isWin = winnerSide === mySide;
        setGameResult({
          winner: winnerSide,
          isWin,
          // eslint-disable-next-line react-hooks/purity -- 事件回调中计算对局时长
          duration: serverElapsedMs(serverTimeOffsetRef, gameStartTimeRef.current),
          moveCount: result.newState.moveHistory.length,
          surrenderBy: null,
        });
      }
      setPhase('ended');
    }
    // 重置限时计时器
    // eslint-disable-next-line react-hooks/purity -- 事件回调中重置计时起点
    // 【C-40】锚点落在服务端时间轴上（理由同 enterPlayingLocal）；第 3 批走 serverNow
    lastMoveTimeRef.current = serverNow(serverTimeOffsetRef);
    setTurnTimeLeft(turnTimeLimit);
  };

  // 动作类型 → HTTP 兜底端点（与 WebSocket 消息类型同名）
  const HTTP_ACTION_PATH: Record<BattleActionType, string> = {
    // 【S-8】服务端已把「上传完整局面」的旧协议分支删除，改名 POST /rooms/:roomId/move，
    // 只接受 { move: { pieceId, toCol, toRow } }。旧名 gameState 已被 GET（只读局面）占用。
    move: 'move',
    surrender: 'surrender',
    undo: 'undo',
    undoResponse: 'undoResponse',
    draw: 'draw',
    drawResponse: 'drawResponse',
    emoji: 'emoji',
  };

  // 统一的动作发送：WS 优先并等待服务端 ack，失败时按语义分流。
  //
  // 旧实现只判断「帧是否发出」（send() 的返回值），服务端是否接受完全无人知晓：
  // 服务端在 status >= 400 时**不广播 state**，于是被拒绝的动作（不是你的回合 /
  // 非法走法 / 对方已连续拒绝 2 次 …）既没有回退也没有提示，界面静默卡住。
  //
  // 现在按三类失败分流（见 utils/battleProtocol）：
  //   · 帧未发出        → 回退 HTTP（连接不可用时的兜底）
  //   · 服务端明确拒绝   → 绝不回退 HTTP（会绕过裁决），回退本地乐观更新并提示
  //   · 等待回执超时     → 结果未知，同样回退本地乐观更新并提示，不盲目重试
  const sendBattleAction = async (type: BattleActionType, payload: Record<string, unknown>) => {
    // 连接可用时经 WS 等待服务端裁决；不可用则直接走 HTTP 兜底
    const socket = battleSocketRef.current;
    let deliveredOverWs = false;
    if (socket?.isConnected) {
      try {
        await socket.request(type, payload);
        deliveredOverWs = true;
      } catch (error) {
        // 帧未发出（刚断开）→ 交给 HTTP 兜底；服务端拒绝/超时 → 回退乐观更新并提示
        if (!isActionNotSent(error)) {
          handleActionRejected(error);
          return;
        }
      }
    }
    if (deliveredOverWs) return;

    // HTTP 兜底：仅在本端无法经 WS 送达时使用
    try {
      const base = await getOnlineServerUrl();
      const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/${HTTP_ACTION_PATH[type]}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 【S-1 / §3.1】与 WS 通道同一套鉴权：服务端不再从 body 读 playerId
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({ playerId, ...payload }),
      });
      // 【S-14】原实现不读 response.ok 与 body.success：被服务端拒绝的动作（不是你的回合 /
      // 非法走法 / 协商已被对方处理 / token 失效）会静默失败——界面不回滚也不提示，
      // 用户以为已认输/已悔棋，实际服务端什么都没做。
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        if (response.status === 403) {
          // 身份失效：清掉本地 token 并切终态，避免后续动作反复 403 空转
          clearRoomSessionToken(roomId, playerId);
          handleSessionGone('removed');
          return;
        }
        showNotice('操作未被服务端接受', typeof errBody?.message === 'string' ? errBody.message : undefined);
      }
    } catch (error) {
      console.error(`发送动作失败(${type}):`, error);
      showNotice('网络异常，操作发送失败');
    }
  };

  // 服务端权威走子上报（方案 P0「服务端权威裁决」）：只发着法，
  // 服务端负责校验（轮次/走法合法）并以同一规则引擎 makeMove 裁决与广播
  const sendPlayerMove = async (move: BattleMove) => {
    await sendBattleAction('move', { move });
  };

  /**
   * 终局结算（本地乐观结算，最终以服务端广播为准）。
   * @param settled  终局后的局面（走完那一步的 newState；无可走着法时直接传当前局面）
   * @param reason   终局原因（'juesha' | 'kunbi' | 长将长捉/和棋等，传给结算特效）
   * @param loserSideOverride  指定判负方；不传时由局面 gameStatus 推导
   */
  const settleFromState = (
    settled: GameState,
    reason: string,
    loserSideOverride?: SideTag
  ) => {
    // 和棋只看局面自身的 gameStatus；显式指定判负方时（无合法着法判负）不可能是和棋。
    // 顺序不能反：判定困毙/绝杀时传入的局面还是"走子前"的状态，gameStatus 恒为 playing，
    // 若先算 isDraw 再判 override，会把"因无着法可走而判负"错误地结算成和棋。
    const isDraw = loserSideOverride === undefined && settled.gameStatus === 'draw';
    setJueShaVisible(true);
    setGameOverReason(reason);
    setGameEndReason(isDraw ? 'draw' : 'checkmate');
    if (isDraw) {
      setGameResult({
        winner: null,
        isWin: false,
        // eslint-disable-next-line react-hooks/purity -- 事件回调中计算对局时长
        duration: serverElapsedMs(serverTimeOffsetRef, gameStartTimeRef.current),
        moveCount: settled.moveHistory.length,
        surrenderBy: null,
        isDraw: true,
      });
    } else {
      // 引擎判定真实胜方（长将/长捉判负时走棋方可能为败方，不能默认走棋方获胜）；
      // 显式指定判负方时（无合法着法判负）以指定方为准
      const winnerSide: 'red' | 'black' = loserSideOverride !== undefined
        ? (loserSideOverride === RED_SIDE ? 'black' : 'red')
        : (getWinnerSideTag(settled) === RED_SIDE ? 'red' : 'black');
      setGameResult({
        winner: winnerSide,
        isWin: winnerSide === mySide,
        // eslint-disable-next-line react-hooks/purity -- 事件回调中计算对局时长
        duration: serverElapsedMs(serverTimeOffsetRef, gameStartTimeRef.current),
        moveCount: settled.moveHistory.length,
        surrenderBy: null,
      });
    }
    setPhase('ended');
  };

  // 超时兜底走棋。
  // ⚠️ 这里的"走一步"必须是**合法**着法（走后己方将/帅不被攻击）：
  // getValidMoves 只判棋子走法形状、含送将着法，若随机到送将（尤其走将入攻击格），
  // 局面会进入"被将却无人应招"的非法状态，而对方端引擎（本地 AI/皮卡鱼）都不会靠
  // 吃将来补救，绝杀/困毙也不触发 → 对局永久僵住。
  // 因此先按 isMoveKingSafe 过滤；**过滤后为空说明该方已无任何合法着法**，即已被
  // 将死或困毙（中国象棋两者均判负），此时判负终局，绝不退回"随便送一步"。
  const doRandomMove = () => {
    if (!gameState) return;

    const mySideTag = sideStringToTag(mySide);
    // 收集所有己方棋子的可走落点（getValidMoves 只判棋子走法形状，不含王安全过滤）
    const allMoves: { pieceId: number; col: number; row: number }[] = [];
    for (const piece of gameState.pieces) {
      if (!piece.alive) continue;
      // mySideTag 为 RED_SIDE(true) 时己方是红方（ID 16-31），为 BLACK_SIDE(false) 时己方是黑方（ID 0-15）
      const isMyPiece = mySideTag ? piece.id >= 16 : piece.id < 16;
      if (!isMyPiece) continue;
      const moves = getValidMoves(gameState, piece.id);
      for (let c = 0; c < 9; c++) {
        for (let r = 0; r < 10; r++) {
          if (moves[c]?.[r]) {
            allMoves.push({ pieceId: piece.id, col: c, row: r });
          }
        }
      }
    }

    const safeMoves = allMoves.filter((m) => isMoveKingSafe(gameState, m.pieceId, m.col, m.row));

    if (safeMoves.length === 0) {
      // 己方无任何不送将的着法 → 已被将死（被将军）或困毙（未被将军）。
      // 用引擎判据分类，只影响展示文案，终局结果同为判负。
      const checked = !!gameState.isCheck;
      settleFromState(gameState, checked ? 'juesha' : 'kunbi', mySideTag ? BLACK_SIDE : RED_SIDE);
      return;
    }

    // 随机选择一个走法
    const randomMove = safeMoves[Math.floor(Math.random() * safeMoves.length)];
    const result = makeMove(gameState, randomMove.pieceId, randomMove.col, randomMove.row);
    if (!result) return;

    // 吃子/将军特效（终局时不播，由绝杀特效接管）
    triggerMoveEffect(result.captured, result.isCheck, result.isGameOver);
    // 走子音效：将军时播男声将军语音（替代走子音，避免混音重叠），否则吃子/走子音
    if (result.isCheck && !result.isGameOver) {
      playJiangJunSound(); // 男声将军语音（内置节流）
    } else if (result.captured !== -1) {
      playSound('eat');
    } else {
      playSound('go');
    }

    // 记录乐观更新（含走子前快照，供服务端拒绝时回退）
    markOptimisticMove(result.newState.moveHistory.length, gameState);
    setGameState(result.newState);
    setSelectedPieceId(null);
    setValidMoves(null);
    // 同步「最近一步」光环（超时随机走棋与手动走棋一致，展示落点光环）
    const movedPiece = gameState.pieces[randomMove.pieceId];
    setLastMove({
      fromCol: movedPiece.col,
      fromRow: movedPiece.row,
      toCol: randomMove.col,
      toRow: randomMove.row,
    });

    // 服务端权威走子上报（同手动走棋）
    sendPlayerMove({ pieceId: randomMove.pieceId, toCol: randomMove.col, toRow: randomMove.row });

    // 检查是否绝杀/困毙/长将长捉规则终局/将帅被吃（本地乐观结算，服务端广播为准）
    if (result.isGameOver) {
      settleFromState(result.newState, result.gameOverReason);
    }
    // 【C-40】超时走棋后同样把锚点放回服务端时间轴，否则下一次快照会把倒计时拉回 0
    // 第 3 批：走 serverNow（§8 表 #7）
    lastMoveTimeRef.current = serverNow(serverTimeOffsetRef);
    setTurnTimeLeft(turnTimeLimit);
  };

  // 限时倒计时
  useEffect(() => {
    if (phase !== 'playing' || turnTimeLimit <= 0) return;

    const timer = setInterval(() => {
      // 【C-40】lastMoveTimeRef 是服务端时间戳（useBattleStateSync 写入 data.lastMoveTime），
      //   必须与校正后的服务端时间比较，不能直接用本机 Date.now()：两端设备时钟有差时
      //   （常见于用户手动改时间、系统未自动校时）elapsed 会被算成负值或远超真实值 ——
      //   前者让剩余时间不降，后者让 remaining 立刻归零，于是 doRandomMove() 替用户走棋。
      //   偏移量的定义与用法见上面 serverTimeOffsetRef 的注释与 useBattleClock 内同一套约定。
      //   第 3 批起这条路径走 @/utils/serverClock 的 serverRemainingSec（§8 表 #7）
      const remaining = serverRemainingSec(serverTimeOffsetRef, turnTimeLimit, lastMoveTimeRef.current);
      setTurnTimeLeft(remaining);

      // 【C-41】悔棋/求和协商期间服务端会冻结棋钟（clockPausedAt 非空），
      //   此时步时也必须跟着冻结：否则钟面看着在走（computeClockText 已按锚点冻结，
      //   但这里没读），remaining 会走成 0 并触发 doRandomMove()，把协商中的这步棋替用户走掉；
      //   服务端随后会静默清掉 pendingUndo/pendingDraw（驳回或超时），用户以为自己已经悔过棋。
      if (clockSnapRef.current?.clockPausedAt != null) return;

      // 超时随机走一步棋
      if (remaining <= 0 && isMyTurn) {
        doRandomMove();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [phase, turnTimeLimit, isMyTurn]);

  // 复盘自动保存：对局进入 ended（绝杀/困毙/认输/断线判负/超时判负）时保存完整着法到本地历史，每局仅一次
  useEffect(() => {
    if (phase !== 'ended' || !gameResult || replaySavedRef.current) return;
    replaySavedRef.current = true;
    const finalState = gameStateRef.current;
    const winnerSide = gameResult.winner === 'red' || gameResult.winner === 'black'
      ? gameResult.winner
      : null;
    saveReplay({
      timestamp: Date.now(),
      mode: 'lan',
      moveCount: finalState.moveHistory.length,
      moves: finalState.moveHistory,
      firstMoveSide: 'red', // 在线对局固定红先
      winnerSide,
      mySide: mySide === 'black' ? 'black' : 'red',
      handicap: roomHandicapRef.current.length > 0 ? roomHandicapRef.current : undefined, // 让子局回放需从让子局面起摆
      note: `对手·${opponentName || '未知'}`,
    }).catch(() => undefined);
  }, [phase, gameResult, mySide, opponentName]);

  // 认输
  const handleSurrender = async () => {
    setShowSurrenderModal(false);
    // 结算界面由服务端状态广播推送驱动（ack 仅用于暴露「服务端拒绝/超时」）
    await sendBattleAction('surrender', {});
  };

  // 【P5】服务端已走手数：增量载荷不再下发完整 moveHistory（见 buildGameStatePayload）。
  // 悔棋入口的「本局还没走过子」等判断改读这里。
  const moveCount = gameState.moveHistory?.length ?? 0;

  // 本次悔棋应退的手数（0 = 不可悔棋），与服务端 resolveUndoDepth 同一判据：
  //   - 轮到对方（我刚走完、对方还没回应）→ 1 手，正是此前悔棋按钮点不动的那个窗口；
  //   - 轮到自己 → 2 手（撤双方各一步），需要至少走过 2 手。
  // 换边关系由「每走一手 sideTag 必翻转」保证：轮到对方 ⇔ 最后一手是我走的，
  // 故不需要再回头检查棋谱里最后一手的阵营（那只会引入与服务端不一致的第二判据）。
  // moveCount 用本地合并后的完整棋谱长度，服务端用的是快照栈长度；
  // 二者在本局正常推进时始终相等（每手压 1 个快照），故用它判「走过几手」是安全的。
  const canUndoDepth: 0 | 1 | 2 = (() => {
    if (phase !== 'playing' || moveCount < 1) return 0;
    if (isMyTurn) return moveCount >= 2 ? 2 : 0;
    return 1;
  })();

  // 悔棋（需对方同意）
  //
  // 【S-2】改造前本函数在本地 undoMove 两步后把「目标局面」随请求提交给服务端，
  // 而服务端在对方同意时**直接采纳**这份客户端上传的局面——等于把权威局面交给
  // 任一方任意改写（可以伪造"对手少子、自己多子"的局面）。现在服务端保存自己的
  // 走子前快照栈（stateHistory），对方同意时从自己的快照回退，客户端不再上传局面。
  //
  // 【悔棋深度】本次退几手由**服务端**按当前局面判定（resolveUndoDepth）：
  //   - 轮到我走 → 退 2 手（撤自己上一手 + 对方应的那手），与旧行为一致；
  //   - 对方该走（我刚走完、对方还没回应）→ 退 1 手（只撤自己刚走的那一手）。
  // 客户端用 canUndoDepth 复刻同一判据，使按钮的可用状态与服务端一致、点击即时生效；
  // 真正回退仍以服务端快照为准，本地 undoMove 只做「有资格发请求」的前置校验。
  const handleUndo = async () => {
    if (undoPendingRef.current) return;
    if (undoBlockedRef.current) {
      showNotice('对方已连续拒绝 2 次，本局不能再发起悔棋');
      return;
    }

    const depth = canUndoDepth;
    if (depth === 0) {
      showNotice('还没有可回退的着法');
      return;
    }

    // 守卫：本地 moveHistory 必须能退 depth 步，否则不发请求。
    // undoMove 末尾会 recomputeRuleState 全量重放；增量载荷下由
    // useBattleStateSync 的 mergeHistory 负责补齐完整历史。
    let probe = gameState;
    for (let i = 0; i < depth; i += 1) {
      const next = undoMove(probe);
      if (!next) return;
      probe = next;
    }

    // 先进入「等待对方同意」态：服务端拒绝或超时时由 handleActionRejected 回退该态
    undoPendingRef.current = true;
    setUndoPending(true);
    await sendBattleAction('undo', {});
  };

  // 响应对方的悔棋请求
  const handleUndoResponse = async (agreed: boolean) => {
    setUndoRequestFromOpponent(false);
    setOpponentUndoDepth(0); // 【悔棋深度】已响应，不再需要展示回退手数
    // 处理结果由服务端状态广播推送；ack 仅用于暴露「服务端拒绝/超时」
    await sendBattleAction('undoResponse', { agreed });
  };

  // 求和（需对方同意）：发送求和请求，对方同意则以和棋结束对局
  const handleDrawRequest = async () => {
    if (drawPendingRef.current || phase !== 'playing') return;
    if (drawBlockedRef.current) {
      showNotice('对方已连续拒绝 2 次，本局不能再发起求和');
      return;
    }

    // 先进入「等待对方同意」态：服务端拒绝或超时时由 handleActionRejected 回退该态
    drawPendingRef.current = true;
    setDrawPending(true);
    await sendBattleAction('draw', {});
  };

  // 响应对方的求和请求：和棋结算由服务端状态广播推送驱动
  const handleDrawResponse = async (agreed: boolean) => {
    setDrawRequestFromOpponent(false);
    await sendBattleAction('drawResponse', { agreed });
  };

  // ===== 对局内 emoji 表情互动 =====
  // 是否可使用表情：对手已加入且处于准备/对局阶段
  const canUseEmoji = !!opponentName && (phase === 'waiting' || phase === 'playing');

  // 房间设置弹窗的编辑权限：仅房主、仅等待阶段。
  // 提取出来是因为该弹窗的「表单区」与 AppModal 的「footer 按钮区」是两棵子树
  // （见 C-81），两边都要用同一份判据，否则会出现表单只读、却仍显示「保存」的错配。
  const canEditSettings = phase === 'waiting' && hostId === playerId;

  // 切换表情下拉栏：打开瞬间用 measureInWindow 实测名称行位置（窗口坐标 → 根容器坐标），
  // 确保下拉栏精确落在名称行正下方；测量接口不可用时退化为 onLayout 相对坐标锚点
  const toggleEmojiPicker = useCallback(() => {
    if (!canUseEmoji) return;
    if (emojiPickerOpen) {
      setEmojiPickerOpen(false);
      return;
    }
    type Measurable = { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void };
    const row = myNameRowRef.current as unknown as Measurable | null;
    const host = containerRef.current as unknown as Measurable | null;
    if (row?.measureInWindow && host?.measureInWindow) {
      row.measureInWindow((_rx, ry, _rw, rh) => {
        host.measureInWindow!((_hx, hy) => {
          setEmojiDropdownTop(Math.max(ry - hy + rh + 6, 0));
          setEmojiPickerOpen(true);
        });
      });
    } else {
      setEmojiDropdownTop(null);
      setEmojiPickerOpen(true);
    }
  }, [canUseEmoji, emojiPickerOpen, containerRef]);

  // 发送表情：本地立即展示在我方名称左侧，同时上传供对方轮询获取
  const handleSendEmoji = useCallback(async (emoji: string) => {
    setEmojiPickerOpen(false);
    const id = `${playerId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    addActiveEmoji({ id, playerId, emoji });
    // 对方经服务端广播实时收到（按 id 去重）；ack 仅用于暴露「服务端拒绝/超时」
    await sendBattleAction('emoji', { emoji, id });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendBattleAction 每次渲染重建，纳入依赖会破坏本回调的稳定语义
  }, [playerId, addActiveEmoji]);

  // 我方活跃表情（显示在我方名称左侧）/ 对方活跃表情（显示在对方名称右侧）
  const myEmojis = useMemo(() => activeEmojis.filter(e => e.playerId === playerId), [activeEmojis, playerId]);
  const opponentEmojis = useMemo(() => activeEmojis.filter(e => e.playerId !== playerId), [activeEmojis, playerId]);

  // 让子幽灵标记：被让出的棋子在对局棋盘的初始位置半透明展示 + 红色「让」角标，
  // 让双方开局前即明确哪些棋子被让。仅在开局前（等待/选边/公示）展示——
  // 开局与结算阶段让子方即以排除让子后的局面对弈，棋盘不再展示让子棋子及其标记
  const ghostPieces = useMemo(
    () => {
      if (phase === 'playing' || phase === 'ended') return [];
      return roomHandicap
        .map(id => {
          const pos = INITIAL_PIECE_POS.get(id);
          return pos ? { id, col: pos.col, row: pos.row } : null;
        })
        .filter((g): g is { id: number; col: number; row: number } => g !== null);
    },
    [roomHandicap, phase]
  );

  // 棋局开始前的展示用局面：存在让子时，本地标准初始局面需同步移除被让棋子，
  // 棋盘才能在被让位置渲染幽灵标记（否则被正常棋子占据而遮蔽，误导用户以为不让子）；
  // playing/ended 阶段直接用服务端局面（权威局面由服务端 startPlayingRoom() 自建并应用让子）
  const displayGameState = useMemo(() => {
    if (roomHandicap.length === 0) return gameState;
    if (phase === 'playing' || phase === 'ended') return gameState;
    return applyHandicap(cloneGameState(gameState), roomHandicap);
  }, [gameState, roomHandicap, phase]);

  // 活跃表情超时自动移除（略晚于淡出动画完成，避免提前消失）
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveEmojis(prev => {
        const now = Date.now();
        const next = prev.filter(e => now - e.receivedAt <= EMOJI_DISPLAY_MS + 400);
        return next.length === prev.length ? prev : next;
      });
    }, 800);
    return () => clearInterval(timer);
  }, []);

  // 阶段切换导致不可用（如进入结算）时自动收起表情栏
  useEffect(() => {
    if (!canUseEmoji && emojiPickerOpen) setEmojiPickerOpen(false);
  }, [canUseEmoji, emojiPickerOpen]);

  // 「返回房间」10s 兜底倒计时：进入结算即开始计时（不点按钮也会到点自动回房间）。
  // 目的：结算页不能无限期停留等待对手决策——双方互不干扰意味着谁都不点就谁都不动，
  // 到点自动收起结算并把本端切回房间准备界面，与点了按钮的效果一致。
  useEffect(() => {
    if (phase !== 'ended' || sessionGone) return;
    setReturnRoomCountdown(RETURN_ROOM_FALLBACK_SECONDS);
    const timer = setInterval(() => {
      setReturnRoomCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      clearInterval(timer);
      setReturnRoomCountdown(null);
    };
  }, [phase, sessionGone]);

  // 兜底倒计时归零 → 与主动点「返回房间」等价：发请求并切回准备界面。
  // 经 ref 调用以避开 handleReturnToRoom 的声明顺序（它是普通 async 函数，非 useCallback），
  // ref 每轮渲染刷新，始终指向最新实现。
  // 初始为空实现，由下方「每轮渲染刷新指向」的 effect 在首帧后填入 handleReturnToRoom
  const returnToRoomRef = useRef<() => void>(() => undefined);
  const returnFallbackFiredRef = useRef(false);
  useEffect(() => {
    if (returnRoomCountdown !== 0 || returnFallbackFiredRef.current) return;
    returnFallbackFiredRef.current = true;
    returnToRoomRef.current();
  }, [returnRoomCountdown]);

  // 重新进入结算（新一局终局）时重置兜底触发标记
  useEffect(() => {
    if (phase !== 'ended') returnFallbackFiredRef.current = false;
  }, [phase]);

  // 重置本地状态回到准备阶段（重新对局）
  const resetForRematch = () => {
    if (countdownTimerRef.current) { clearInterval(countdownTimerRef.current); countdownTimerRef.current = null; }
    setGameState(createInitialState());
    setSelectedPieceId(null);
    setValidMoves(null);
    setLastMove(null);
    setPhase('waiting');
    setGameResult(null);
    setGameDuration(0);
    setJueShaVisible(false);
    setGameEndReason(null);
    setReturnRoomCountdown(null);
    setOpponentReturned(false);
    gameStartTimeRef.current = 0;
    // 注意：playedMatchIdRef（已入局纪元）刻意不重置——重赛后轮询若先拿到上一局旧快照
    // （phase=playing + 旧 matchId），须凭它识别并忽略，避免跳过准备阶段直接进入对局
    // 准备阶段状态重置：重新选边与准备
    setMyPreference(null);
    setMyReady(false);
    myReadyRef.current = false;
    readyInFlightRef.current = 0;
    // 宽限窗口内轮询不用服务端旧数据覆盖本端准备状态，避免重赛后被旧状态误置为「已准备」
    lastReadyToggleRef.current = Date.now();
    setOpponentReady(false);
    setOpponentPreference(null);
    setSideRandom(false);
    revealStartedRef.current = false;
    amUploaderRef.current = false;
    uploadedRef.current = false;
    setReadyCountdown(null);
    setSidePickStage(false);
    setSidePickVisible(false);
    setSidePickResultMode(false);
    resetSyncBaseline(); // 清除走子乐观保护基线（含回滚快照）
    selfDisconnectedRef.current = false; // 新一局重新计算断线状态（避免沿用上一局的断线判负文案）
    replaySavedRef.current = false; // 重新对局允许再次自动保存复盘
    // 悔棋协商状态重置
    // 【C-46 顺带修复】此前重赛只复位求和协商，漏了悔棋：上一局残留的 undoPending 会让
    // 新一局的悔棋按钮一直停在「等待对方同意」（服务端已随重赛清空 pendingUndo）。
    undoPendingRef.current = false;
    setUndoPending(false);
    setUndoRequestFromOpponent(false);
    setOpponentUndoDepth(0);
    // 求和协商状态重置
    drawPendingRef.current = false;
    setDrawPending(false);
    setDrawRequestFromOpponent(false);
    // 协商封禁状态重置（服务端重赛时已清零，本地同步复位避免旧封禁残留）
    undoBlockedRef.current = false;
    setUndoBlocked(false);
    drawBlockedRef.current = false;
    setDrawBlocked(false);
    // emoji 表情状态重置
    setEmojiPickerOpen(false);
    setActiveEmojis([]);
    seenEmojiIdsRef.current = new Set();
  };

  // 结算后的「返回房间」：把本端退回房间准备界面，随后可自行准备/选边。
  // 与 /rematch 的关键差别在**谁被重置**：/rematch 由发起者单方面把对手一起拽回准备阶段
  // （用户反馈的「对方也被返回房间」）。本接口同样把房间重置为 waiting，但客户端只在
  // **本端**切到准备界面；对手端仅在轮询发现「自己也被标记返回」或结算兜底倒计时归零时才切换，
  // 因此双方互不干扰，各自决定何时离开结算页。
  const handleReturnToRoom = async () => {
    if (returnToRoomInFlightRef.current) return; // 防连点
    returnToRoomInFlightRef.current = true;
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：POST /api/v1/lan/rooms/:roomId/returnToRoom
       * Body 参数：playerId: string
       */
      const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/returnToRoom`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 【S-1 / §3.1】鉴权凭证（服务端不再从 body 读 playerId）
          ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
        },
        body: JSON.stringify({ playerId }),
      });
      const data = await response.json();
      if (!data.success) {
        console.error('返回房间被服务端拒绝:', data);
        const msg = typeof data?.message === 'string' ? data.message : '';
        if (msg.includes('不在房间') || msg.includes('房间不存在')) {
          handleSessionGone(msg.includes('房间不存在') ? 'room-closed' : 'removed');
          return;
        }
        return;
      }
    } catch (error) {
      console.error('返回房间失败:', error);
      return;
    } finally {
      returnToRoomInFlightRef.current = false;
    }
    // 服务端已把房间重置为等待中 → 同步本端到准备界面
    resetForRematch();
  };

  // 每轮渲染刷新兜底回调指向，保持指向最新闭包。必须放在组件体顶层：
  // 若塞进 handleReturnToRoom 内部，只有成功请求后才会更新，会漏掉首次渲染与失败重试场景，
  // 兜底倒计时归零时可能调用到上一轮（或空）实现。
  useEffect(() => {
    returnToRoomRef.current = handleReturnToRoom;
  });

  // 返回：通知服务端离开房间后再返回（房间无人时服务端自动销毁，等待期离开会重置对手状态）。
  // 确认「中途退出」后才真正离开：实际离开动作（leave 请求 + 回大厅）都在 handleBack 里，
  // 本函数只负责在**对局进行中**拦一道二次确认。
  //
  // 覆盖阶段：playing（正在下棋）与 reveal / countdown（公示与开局倒数——此时退出同样会
  // 让对方等不到对手，语义上与 playing 一致）。waiting（准备阶段，退出不判负）与
  // ended（结算阶段，已有独立的「返回房间/退出房间」按钮）不拦，保持原一键返回。
  //
  // 用 phaseRef 而非 phase 读取阶段：安卓物理返回键的监听只订阅一次（避免每次渲染重新
  // 订阅），回调里拿到的是注册那一刻的闭包，必须读 ref 才能拿到最新阶段。
  const requestExit = useCallback(() => {
    const p = phaseRef.current;
    if (p === 'playing' || p === 'reveal' || p === 'countdown') {
      showLeaveConfirmRef.current = true;
      setShowLeaveConfirm(true);
      return;
    }
    handleBackRef.current();
  }, []);

  // 等待离开请求落地（上限 800ms 兜底）再跳转：否则大厅聚焦轮询可能在离开生效前查到旧成员身份，
  // 误显示「回到对局/未开始房间」的回连提醒
  //
  // 本函数是「已确认的离场」收口：所有调用方（顶部返回按钮经 requestExit、结算期「退出房间」、
  // sessionGone 浮层、confirmLeaveAndExit）都已就绪，故第一件事就是撤防 + 置主动退出标记。
  // 撤防不可省：下面的 exitToLobby() 本身也是一次导航，会触发 beforeRemove；若拦截仍开着，
  // 退出动作会被自己的对话框再拦一次（点了没反应 / 弹窗循环）。
  const handleBack = useCallback(async () => {
    // 先置主动退出标记：抑制离开请求与 2s 轮询竞态导致的「房间已关闭/你已被移出房间」误报
    intentionalExitRef.current = true;
    leaveArmedRef.current = false;
    setLeaveArmed(false);
    showLeaveConfirmRef.current = false;
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：POST /api/v1/lan/rooms/:roomId/leave
       * Body 参数：playerId: string
       */
      await Promise.race([
        fetch(`${base}/api/v1/lan/rooms/${roomId}/leave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 【S-1 / §3.1】离场也凭 token：否则陌生人可用 playerId 把别人踢出房间
            ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
          },
          body: JSON.stringify({ playerId }),
        }).catch((err: unknown) => console.error('离开房间请求失败:', err)),
        new Promise(resolve => setTimeout(resolve, 800)),
      ]);
    } catch (err: unknown) {
      console.error('离开房间请求失败:', err);
    }
    // 离开房间的语义目标始终是大厅，经 exitToLobby 有栈 back、无栈（Web 刷新）replace 兜底
    exitToLobby();
  }, [roomId, playerId, exitToLobby]);

  // handleBack 最新引用：供安卓返回键监听与路由拦截回调调用，
  // 避免 useSafeRouter 每次渲染返回新对象导致监听反复订阅/退订
  const handleBackRef = useRef(handleBack);
  handleBackRef.current = handleBack;

  // 拦截「不经过返回按钮/物理返回键」的离场路径：iOS 侧滑返回手势、Web 浏览器后退键、
  // 以及任何 router.back()/replace() 的程序化跳转。它们都触发导航容器的 beforeRemove 事件，
  // 这里在**对局进行中**先弹二次确认；等待/结算阶段不拦（结算阶段有独立按钮与倒计时兜底）。
  //
  // 确认后必须 nav.dispatch(**原对象** action) 放行，不能改成再调一次 router.back()：
  //  1. 被拦的可能是 replace/goto 等非 pop 动作，重放成 back 会跳去错误页面；
  //  2. 原 action 身上带 react-navigation 内部的 VISITED_ROUTE_KEYS 标记（见
  //     @react-navigation/core 的 useOnPreventRemove.shouldPreventRemove），重放它会让
  //     拦截判定走「已处理过该路由」分支直接放行；若换成 router.back() 生成的新动作没有该
  //     标记，会被自己的 usePreventRemove 再次拦下，形成死循环。
  const navigation = useNavigation();
  // 仅在对局进行中武装拦截。waiting（准备阶段，退出不判负）与 ended（结算阶段，已有独立的
  // 「返回房间/退出房间」按钮和 10s 自动返回兜底）都不拦。
  const inGamePhase = phaseRef.current === 'playing' || phaseRef.current === 'reveal' || phaseRef.current === 'countdown';
  useEffect(() => {
    // 阶段离开对局、或已确认退出（intentionalExitRef）后都必须撤防：拦截开着会让
    // handleBack 的 exitToLobby()、结算期的「返回房间」跳转全部被自己的对话框拦下。
    const armed = inGamePhase && !intentionalExitRef.current;
    if (leaveArmedRef.current === armed) return;
    leaveArmedRef.current = armed;
    setLeaveArmed(armed);
  }, [inGamePhase]);
  usePreventRemove(leaveArmed, ({ data }) => {
    pendingLeaveRef.current = { nav: navigation, action: data.action };
    showLeaveConfirmRef.current = true;
    setShowLeaveConfirm(true);
  });

  // Web 端浏览器后退键的独立兜底：expo-router 的 popstate 处理器在「历史项带缓存 state」时
  // 走 navigation.resetRoot(record.state)，它把 CommonActions.reset 直接 dispatch 到 root 容器
  // （@react-navigation/core 的 BaseNavigationContainer.resetRoot），**绕过了** useOnAction 里
  // 的 shouldPreventRemove 判定门 —— 于是浏览器后退会直接离开对局页、usePreventRemove 拦不住。
  // iOS 侧滑返回不经过这里，仍由 usePreventRemove 覆盖（实测那条路径会先触发
  // usePreventRemove(action=RESET)，再落到本兜底的 popstate，二者不冲突）。
  //
  // 做法：自己监听 popstate。若此刻处于对局中且尚未确认退出，就先用 history.go(1) 把这次后退
  // 原样撤销（页面与 URL 都回到对局页），再弹二次确认；确认后走 handleBack 主动跳大厅，
  // 不依赖浏览器历史，因此撤销历史是安全的。
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onPopState = () => {
      // go(1) 撤销自身触发的回退 popstate：expo-router 仍需处理它（把路由重置回对局页），
      // 但我们不能再弹一次窗，否则会与用户点「继续对局」后的下一次后退互相触发。
      if (webPopRestoreRef.current) {
        webPopRestoreRef.current = false;
        return;
      }
      if (!leaveArmedRef.current || showLeaveConfirmRef.current) return;
      // 先置标记并弹窗，再撤销历史：go(1) 是异步的（会再触发一次 popstate），
      // 若顺序颠倒，第二次 popstate 到达时 confirmOpen 仍为 false，会被当成新的后退而重复弹窗。
      webPopRestoreRef.current = true;
      showLeaveConfirmRef.current = true;
      setShowLeaveConfirm(true);
      window.history.go(1);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 确认「中途退出」：先离开房间，再放行被拦下的原始离场动作（或走 handleBack 收口）。
  // intentionalExitRef 提前置位，让本端的 2s 轮询/WS 在跳转前不再报「房间已关闭」误报。
  //
  // 关键：必须先撤防（leaveArmedRef）再触发任何导航。confirmLeaveAndExit 的两条分支最终
  // 都会产生一次导航（dispatch 原 action / handleBack→exitToLobby），而那些导航本身也会触发
  // beforeRemove；若此时拦截仍处于开启状态，同一个对话框会被立刻重新弹回来（死循环）。
  // 撤防走 ref + 强制重渲染，usePreventRemove 的 preventRemove 参数下一帧才变为 false，
  // 所以这里同步调用 setState 触发一次重渲染即可让 effect 及时更新 setPreventRemove。
  const confirmLeaveAndExit = useCallback(() => {
    setShowLeaveConfirm(false);
    showLeaveConfirmRef.current = false;
    leaveArmedRef.current = false;
    setLeaveArmed(false);
    intentionalExitRef.current = true;
    const pending = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    if (!pending) {
      // 顶部返回按钮 / 安卓物理返回键路径：不在 beforeRemove 流程内，交 handleBack 统一收口
      handleBackRef.current();
      return;
    }
    const { nav, action } = pending;
    void getOnlineServerUrl()
      .then(base =>
        fetch(`${base}/api/v1/lan/rooms/${roomId}/leave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
          },
          body: JSON.stringify({ playerId }),
        })
      )
      .catch(() => undefined)
      .then(() => nav.dispatch(action));
  }, [roomId, playerId]);

  // 卸载即视为主动退出：覆盖 iOS 侧滑等不经 handleBack 的退出路径，
  // 抑制卸载后仍在途的轮询触发「房间已关闭」误报
  useEffect(() => () => { intentionalExitRef.current = true; }, []);

  // 卸载兜底：iOS 侧滑返回等不经过返回键/返回按钮的退出路径不会触发 handleBack，
  // 组件卸载时补发一次离开请求，避免等待阶段残留成员身份导致大厅误显示回连提醒
  // （与 handleBack 的离开请求幂等兼容，重复调用服务端返回 404 无副作用）。
  // 仅限原生端：Web 端页面刷新 / HMR 热更新同样触发组件卸载，若补发离开会把自己
  // 误移出房间（刷新后 URL 恢复回到对局页却已不是成员，一切操作报「玩家不在房间中」）；
  // Web 端真正关闭页面的场景由服务端等待清扫器（30s 无连接）兜底清理。
  useEffect(() => {
    if (Platform.OS === 'web') return;
    return () => {
      getOnlineServerUrl()
        .then(base =>
          fetch(`${base}/api/v1/lan/rooms/${roomId}/leave`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(sessionTokenRef.current ? { 'x-session-token': sessionTokenRef.current } : {}),
            },
            body: JSON.stringify({ playerId }),
          })
        )
        .catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 【C-44】公示倒数定时器此前只在 abortRevealSequence / finishSequenceEarly /
  // resetForRematch 三条业务分支里清理，没有 unmount 清理：用户在「公示 → 倒数开局」
  // 这几秒内直接返回/退房（甚至 Web 刷新）时，250ms 的 countdownTimerRef 会继续跑并对
  // 已卸载组件 setState，对局已经开始时还会再调一次 startGame()。这里补一个只做清理的
  // 空依赖 effect（【C-47】原 revealTimerRef 是只 clear 不赋值的死引用，已连同清理点删除）。
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, []);

  // 安卓系统返回键（侧边返回手势）：对局进行中先弹二次确认，其余阶段与顶部返回按钮一致——
  // 先离开房间再返回。若走默认 pop 路由则不会触发离开请求，导致房间残留/未真正退出房间。
  // （有 Modal 打开时由 Modal 自行接管返回键，此处不会触发）
  useEffect(() => {
    const onHardwareBack = () => {
      requestExit();
      return true; // 拦截默认返回，交由 requestExit 统一处理
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    return () => sub.remove();
  }, [requestExit]);

  // 双方均准备后进入 3 秒倒数（准备按钮上显示），倒数期间任意一方可取消准备；
  // 倒数完成自动弹出选边弹窗（选边仅通过弹窗进行）
  const isRed = mySide === 'red';

  // ===== 底部操作栏配置（2026-10 改造：顶部标题栏下线，入口全部收到底栏）=====
  // 对局中：菜单 / 认输 / 求和 / 悔棋（产品指定顺序）
  // 等待准备：菜单 / 准备；结算：菜单 / 返回房间 / 退出房间
  const lanMenuItems: GameMenuItem[] = useMemo(
    () => [
      {
        key: 'settings',
        icon: 'gear',
        label: '房间设置',
        // 服务端仅允许等待阶段改房间设置（PATCH /lan/rooms/:id/settings 见 handleSaveSettings），
        // 对局中禁用并保持可见，让玩家知道入口在哪、为何不可用
        disabled: phase === 'playing' || settingsVisible,
        onPress: handleOpenSettings,
      },
      { key: 'exit', icon: 'door-open', label: '退出对局', onPress: requestExit },
    ],
    [phase, settingsVisible, handleOpenSettings, requestExit]
  );

  const lanBarActions: GameBottomBarActionInput[] = useMemo(() => {
    const menu: GameBottomBarActionInput = { key: 'menu', icon: 'bars', label: '菜单' };
    if (phase === 'waiting') {
      // 等待阶段：仅保留准备按钮（随时可点）。双方就绪后按钮显示 3 秒倒数，
      // 倒数期间再次点击即取消准备；倒数完成进入选边阶段后锁定不可取消
      return [
        menu,
        {
          key: 'ready',
          icon: 'circle-check',
          label: myReady ? '已准备' : '准备',
          disabled: sidePickStage,
          onPress: handleReady,
          badge: myReady && readyCountdown !== null ? readyCountdown : null,
        },
      ];
    }
    if (phase === 'ended') {
      /* 结算阶段的唯一操作入口：棋盘停在最终局面，去留在这里决定——
         「返回房间」把**本端**退回房间准备界面（handleReturnToRoom；不再调 /rematch，
         那是房间级重置且会把对手一起拽回），「退出房间」离开。
         另标注兜底倒计时与对手去留：双方互不干扰，谁都不点则到点各自自动返回。
         结算浮层只承担结果告知，不再重复提供这两个动作。

         注意：本分支**不随对手动作收起**。对手点「返回房间」只会重置房间并下发
         returnedToRoom，本端仍留在结算页、按钮与倒计时都保留，由玩家自己决定；
         早期实现在此隐藏入口（settlementDismissed），导致对手一返回，本端倒计时
         中途按钮变「占位」——即用户报告的「点了没反应、按钮也消失了」。 */
      return [
        menu,
        {
          key: 'return',
          icon: 'rotate-right',
          label: opponentReturned ? '对手已返回' : '返回房间',
          // 兜底倒计时改用角标承载（底栏标签位只有 2~4 字宽度），文字保持稳定
          badge: returnRoomCountdown !== null ? returnRoomCountdown : null,
          onPress: handleReturnToRoom,
        },
        { key: 'leave', icon: 'door-open', label: '退出房间', onPress: handleBack },
      ];
    }
    // 对局中：认输 / 求和 / 悔棋
    return [
      menu,
      { key: 'surrender', icon: 'flag', label: '认输', onPress: () => setShowSurrenderModal(true) },
      {
        key: 'draw',
        icon: 'handshake',
        label: drawPending ? '求和中' : drawBlocked ? '求和已禁' : '求和',
        disabled: drawPending || drawBlocked,
        onPress: handleDrawRequest,
      },
      {
        key: 'undo',
        icon: 'rotate-left',
        label: undoPending
          ? '等待同意'
          : undoBlocked
            ? '悔棋已禁'
            : canUndoDepth === 1
              ? '退1手'
              : '悔棋',
        disabled: canUndoDepth === 0 || undoPending || undoBlocked,
        onPress: handleUndo,
      },
    ];
  }, [
    phase,
    myReady,
    readyCountdown,
    sidePickStage,
    handleReady,
    opponentReturned,
    returnRoomCountdown,
    handleReturnToRoom,
    handleBack,
    drawPending,
    drawBlocked,
    handleDrawRequest,
    undoPending,
    undoBlocked,
    canUndoDepth,
    handleUndo,
  ]);

  // 公示/倒数/绝杀阶段隐藏底栏内容但保留占位，避免棋盘位置跳动
  const bottomBarHidden =
    phase === 'reveal' || phase === 'countdown' || (phase === 'playing' && jueShaVisible);

  return (
    // 【2026-10】去掉 'bottom' 安全区：底部操作栏是主容器的最后一个子节点（固定通栏），
    // 自己用 insets.bottom 撑开内边距。Screen 再补一次底部安全区会让底栏悬在
    // Home Indicator 之上，透明黑底断在半空。
    <Screen
      safeAreaEdges={['top', 'left', 'right']}
      backgroundImage={background.image}
      // 深色背景图（华彩红顶 / 茶室木梁）下黑色状态栏图标看不清，切成浅色
      statusBarStyle={background.tone === 'dark' ? 'light' : 'dark'}
    >
      <View style={[styles.container, hasBackground && styles.containerTransparent]} ref={containerRef}>
        {/* 棋盘内容宿主（相对定位；2026-10 起顶部标题栏下线，宿主直接顶到安全区下方） */}
        <View
          style={styles.boardHost}
          onLayout={(e) => {
            setBoardAreaH(e.nativeEvent.layout.height);
            setBoardHostY(e.nativeEvent.layout.y);
          }}
        >
          {/* 棋盘区域：与人机对战一致——棋盘直接挂在水平居中容器中（屏宽居中逻辑由
              ChessBoard 外层容器承担），名字角标为棋盘上下独立行，不再悬浮遮挡棋盘；
              顶部留白由预算控制：优先垂直居中，预留不足时整体下移贴住预留区 */}
          <View style={[styles.boardContainer, { paddingTop: boardPadTop }]}>
            {/* 对手名角标行：棋盘上方独立行，左对齐（未加入时显示等待提示） */}
            <View style={[styles.nameRow, nameRowStyle]} pointerEvents="none">
              <View style={styles.nameChip}>
                <View
                  style={[
                    styles.nameChipDot,
                    !opponentName && styles.nameChipDotWaiting,
                    phase === 'waiting' && opponentName && !opponentReady && styles.nameChipDotNotReady,
                  ]}
                />
                <Text style={styles.nameChipText} numberOfLines={1}>
                  {/* 对局中/结算中拿不到对手，只可能是对手已离席（服务端已判负），
                      不能仍说「等待对手加入」；等待阶段才是真的在等人 */}
                  {opponentName || (phase === 'waiting' ? '等待对手加入' : '对手已离开')}
                </Text>
                {phase === 'waiting' && opponentName !== '' && (
                  <View style={[styles.readyTag, opponentReady ? styles.readyTagOn : styles.readyTagOff]}>
                    <Text style={[styles.readyTagText, opponentReady ? styles.readyTagTextOn : styles.readyTagTextOff]}>
                      {opponentReady ? '已准备' : '未准备'}
                    </Text>
                  </View>
                )}
              </View>

              {/* 对手局时时钟（基本用时+加秒制，服务端快照 1s 插值，≤30s 且轮其走棋时告警红显） */}
              {phase === 'playing' && clockText.opp !== null && (
                <View style={[styles.nameChip, styles.timerChip]}>
                  <FontAwesome6 name="hourglass-half" size={10} color={clockText.oppUrgent ? COLORS.danger : COLORS.textLight} />
                  <Text style={[styles.timerChipText, clockText.oppUrgent && styles.timerChipTextUrgent]}>
                    {clockText.opp}
                  </Text>
                </View>
              )}

              {/* 对方发送的表情气泡：显示在对方名称角标右侧 */}
              {opponentEmojis.map(e => (
                <EmojiBubble key={e.id} emoji={e.emoji} lifetime={EMOJI_DISPLAY_MS} />
              ))}

              {/* 回合倒计时：统一显示在棋盘右上方，与对方名称同一行对齐（对局开启限时且进入对局后显示） */}
              {phase === 'playing' && turnTimeLimit > 0 && (
                <View style={[styles.nameChip, styles.timerChipPinned]}>
                  <FontAwesome6
                    name="clock"
                    size={11}
                    color={turnTimeLeft <= 30 && isMyTurn ? COLORS.danger : COLORS.textLight}
                  />
                  <Text style={[styles.timerChipText, turnTimeLeft <= 30 && isMyTurn && styles.timerChipTextUrgent]}>
                    {formatTurnClock(turnTimeLeft)}
                  </Text>
                </View>
              )}
            </View>

            {/* 棋盘几何测量包裹层：绝杀特效据此锁定棋盘中心/底边（collapsable=false 保证 Android 可测量） */}
            <View ref={boardRef} onLayout={measureBoardFrame} collapsable={false}>
            <ChessBoard
              gameState={displayGameState}
              selectedPieceId={selectedPieceId}
              validMoves={validMoves}
              lastMove={lastMove}
              isFlipped={!isRed}
              onPiecePress={handlePiecePress}
              onEmptyPress={handleMove}
              onMove={handleMove}
              playerSide={mySide as 'red' | 'black'}
              maxBoardHeight={maxBoardHeight}
              moveEffect={moveEffect}
              // 【提示口径 2026-10】不再向棋盘下发 banMoves 标红：提示统一收敛到
              // 「阈值前一步的一次性提示条」。banMoves 本身仍在 RuleState 里计算，
              // 因为 AI 择优（isMoveBanned）要用它过滤会走进僵局的着法。
              banMoves={null}
              onBoardLayout={setBoardSize}
              ghostPieces={ghostPieces}
            />
            </View>

            {/* 我方名角标行：棋盘下方独立行，右对齐。点击名称角标在其正下方展开表情下拉栏；
                ref 用于点按瞬间实测窗口坐标锚定下拉栏；onLayout 值仅作回退锚点 */}
            <View
              ref={myNameRowRef}
              style={[styles.nameRow, styles.nameRowMe, nameRowStyle]}
              pointerEvents="box-none"
              onLayout={(e) => {
                const { y, height } = e.nativeEvent.layout;
                setEmojiAnchorY(y + height);
              }}
            >
              {/* 我方发送的表情气泡：显示在我方名称角标左侧 */}
              {myEmojis.map(e => (
                <EmojiBubble key={e.id} emoji={e.emoji} lifetime={EMOJI_DISPLAY_MS} />
              ))}
              {/* 我方局时时钟（基本用时+加秒制；轮我方走棋且 ≤30s 时告警红显） */}
              {phase === 'playing' && clockText.mine !== null && (
                <View style={[styles.nameChip, styles.timerChipMine]}>
                  <FontAwesome6 name="hourglass-half" size={10} color={clockText.mineUrgent ? COLORS.danger : COLORS.textLight} />
                  <Text style={[styles.timerChipText, clockText.mineUrgent && styles.timerChipTextUrgent]}>
                    {clockText.mine}
                  </Text>
                </View>
              )}
              {/* 我方名称角标：可点击展开/收起表情栏（含表情入口图标提示） */}
              <TouchableOpacity
                style={styles.nameChip}
                onPress={toggleEmojiPicker}
                disabled={!canUseEmoji}
                activeOpacity={0.8}
              >
                <Text style={styles.nameChipText} numberOfLines={1}>{params.playerName}</Text>
                <View style={[styles.nameChipDot, phase === 'waiting' && !myReady && styles.nameChipDotNotReady]} />
                {phase === 'waiting' && (
                  <View style={[styles.readyTag, myReady ? styles.readyTagOn : styles.readyTagOff]}>
                    <Text style={[styles.readyTagText, myReady ? styles.readyTagTextOn : styles.readyTagTextOff]}>
                      {myReady ? '已准备' : '未准备'}
                    </Text>
                  </View>
                )}
                {canUseEmoji && (
                  <FontAwesome6 name="face-smile" size={12} color={emojiPickerOpen ? COLORS.primary : COLORS.textLight} />
                )}
              </TouchableOpacity>
            </View>

          {/* 对方断线等待浮层 */}
          {opponentDisconnected && phase === 'playing' && (
            <View style={styles.overlay}>
              <View style={styles.disconnectCard}>
                <Text style={styles.disconnectTitle}>对方已断线</Text>
                <Text style={styles.disconnectHint}>等待对方重新连接...</Text>
                <Text style={styles.disconnectCountdown}>{disconnectCountdown}s</Text>
                <Text style={styles.disconnectSubHint}>倒计时结束后对方未重连将判负</Text>
              </View>
            </View>
          )}

          {/* 结算浮层：绝杀/困毙播放「绝/杀」特效；长将判负（二将一还）、认输/和棋/断线判负仅普通文字结算。
              只告知结果，不带操作按钮——「再来一局 / 退出房间」统一放在底部操作栏，避免重复入口 */}
          {jueShaVisible && (
            <JueShaOverlay
              visible={jueShaVisible}
              boardFrame={jueshaHostBoardFrame}
              showEffect={
                gameEndReason === 'checkmate' &&
                gameOverReason !== 'changjiang' &&
                gameResult?.isDraw !== true
              }
              resultText={
                gameResult
                  ? gameResult.isDraw
                    ? (
                      gameOverReason === 'mutual_long_check' ? '双方长将，判和！'
                      : gameOverReason === 'mutual_long_chase' ? '双方长捉，判和！'
                      : gameOverReason === 'natural_limit' ? '自然限招，判和！'
                      : gameOverReason === 'total_limit' ? '达到总步数上限，判和！'
                      : gameOverReason === 'no_attacking' ? '双方无进攻子力，判和！'
                      : '双方不变，和棋！'
                    )
                    : gameOverReason === 'changjiang'
                      ? (gameResult.isWin ? '对手长将判负，你获胜！' : '你方长将判负')
                      : gameResult.surrenderBy
                        ? (gameResult.surrenderBy === playerId ? '你选择了认输' : '对手选择了认输')
                        : gameEndReason === 'leave'
                          ? (gameResult.isWin ? '对方离开了对局，你获胜' : '你离开了对局')
                          : gameEndReason === 'disconnect'
                            ? (gameResult.isWin ? '对方断线，你获胜' : '你断线超时判负')
                            : gameEndReason === 'timeout'
                              ? (gameResult.isWin ? '对方超时，你获胜' : '你超时判负')
                              : gameResult.isWin ? '恭喜获胜！' : '对局失败'
                  : ''
              }
            />
          )}

          {/* 会话终结浮层：房间已销毁 / 本人已被移出 / 断线判负后房间解散。
              服务端已无该房间（404 或成员列表无本人），结算数据不可再获取，
              因此只给可见的终态说明 + 返回大厅入口，杜绝「房间没了但 UI 还停在棋盘」。 */}
          {sessionGone && (
            <View style={styles.overlay}>
              <View style={styles.disconnectCard}>
                <Text style={styles.disconnectTitle}>{sessionGone.title}</Text>
                <Text style={styles.disconnectHint}>{sessionGone.hint}</Text>
                <TouchableOpacity style={styles.sessionGoneButton} onPress={handleBack} activeOpacity={0.85}>
                  <Text style={styles.sessionGoneButtonText}>返回大厅</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* 对局内低干扰提示条（含长将长捉超限/接近阈值提示，替代重构前的 10 处 Alert.alert，
              Web 端此前完全不显示）：
              绝对定位在棋盘中心、pointerEvents="box-none" 不阻塞落子，3s 后自动淡出。
              centerY 为 noticeCenterY：棋盘中心换算到本提示条所属 boardHost
              坐标系的纵坐标（换算在 noticeCenterY 内完成）。缺测量时传 undefined，
              组件退回 50% 居中。结算浮层展示期间让位，避免与结果文字重叠。 */}
          <GameNotice
            notice={jueShaVisible ? null : notice}
            centerY={noticeCenterY}
            onHide={hideNotice}
          />
        </View>
        </View>

        {/* 表情下拉栏：点击我方名称角标后在其正下方展开，宽度适配屏幕，单行横滑选取
            （展示不全时左右滑动）。挂载于根容器：锚点为点按瞬间实测的窗口坐标
            （换算为根容器坐标），回退为 onLayout 相对坐标 + 宿主偏移 */}
        {emojiPickerOpen && canUseEmoji && (
          <View
            style={[
              styles.emojiDropdown,
              { top: emojiDropdownTop ?? (boardHostY + emojiAnchorY + 6), width: Math.max(screenWidth - 24, 0) },
            ]}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.emojiDropdownContent}
            >
              {EMOJI_LIST.map(em => (
                <TouchableOpacity
                  key={em}
                  style={styles.emojiDropdownCell}
                  onPress={() => {
                    handleSendEmoji(em);
                    setEmojiPickerOpen(false);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.emojiDropdownCellText}>{em}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* 选边弹窗（双方均准备后开启；双方选定前可自由更改）。
            强交互场景：blockBackButton 阻断 Android 物理返回键，避免误退出弹窗留下未落地的状态 */}
        <AppModal
          visible={sidePickVisible}
          onClose={() => undefined}
          blockBackButton
        >
          {sidePickResultMode ? (
                /* 选边结果公示：选边结束后弹窗保持不动，内容以动画切换为执棋结果，3 秒后开局 */
                <Animated.View
                  style={[
                    styles.sideResultWrap,
                    {
                      opacity: sidePickResultAnim,
                      transform: [
                        {
                          translateY: sidePickResultAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [26, 0],
                          }),
                        },
                      ],
                    },
                  ]}
                >
                  <Text style={styles.modalTitle}>执棋结果</Text>
                  {roomHandicap.length > 0 && (
                    <Text style={styles.sideResultHandicap}>红方让子先行</Text>
                  )}
                  <Text style={[styles.sideResultMain, isRed ? styles.revealSideRed : styles.revealSideBlack]}>
                    您将：{isRed ? '执红先手' : '执黑后手'}
                  </Text>
                  {sideRandom && <Text style={styles.sideResultRandom}>双方选边相同，已随机分配</Text>}
                  <Text style={styles.sideResultWish}>祝您旗开得胜</Text>
                  <Text style={styles.sideResultCountdown}>{countdown} 秒后开局</Text>
                </Animated.View>
              ) : (
                <>
                  <Text style={styles.modalTitle}>选择执棋方</Text>
                  <View style={styles.sidePickRow}>
                    {/* 执红：本端/对方选定后以红色描边 + 右上角「我方/对手」小字标注 */}
                    <TouchableOpacity
                      style={[
                        styles.sidePickBtn,
                        (myPreference === 'red' || opponentPreference === 'red') && styles.sidePickBtnRed,
                      ]}
                      onPress={() => handlePickSide('red')}
                      activeOpacity={0.8}
                    >
                      {(myPreference === 'red' || opponentPreference === 'red') && (
                        <View style={styles.sidePickBadges}>
                          {myPreference === 'red' && (
                            <View style={[styles.sideBadge, { backgroundColor: COLORS.primary }]}>
                              <Text style={styles.sideBadgeTextSolid}>我方</Text>
                            </View>
                          )}
                          {opponentPreference === 'red' && (
                            <View style={[styles.sideBadge, styles.sideBadgeOutline, { borderColor: COLORS.primary }]}>
                              <Text style={[styles.sideBadgeTextOutline, { color: COLORS.primary }]}>对手</Text>
                            </View>
                          )}
                        </View>
                      )}
                      <View style={[styles.sideDot, styles.sideDotRed]} />
                      <Text
                        style={[
                          styles.sidePickBtnText,
                          (myPreference === 'red' || opponentPreference === 'red') && styles.sidePickBtnTextActive,
                        ]}
                      >
                        执红先手
                      </Text>
                    </TouchableOpacity>
                    {/* 执黑：本端/对方选定后以黑色描边 + 右上角「我方/对手」小字标注 */}
                    <TouchableOpacity
                      style={[
                        styles.sidePickBtn,
                        (myPreference === 'black' || opponentPreference === 'black') && styles.sidePickBtnBlack,
                      ]}
                      onPress={() => handlePickSide('black')}
                      activeOpacity={0.8}
                    >
                      {(myPreference === 'black' || opponentPreference === 'black') && (
                        <View style={styles.sidePickBadges}>
                          {myPreference === 'black' && (
                            <View style={[styles.sideBadge, { backgroundColor: '#3C2A1E' }]}>
                              <Text style={styles.sideBadgeTextSolid}>我方</Text>
                            </View>
                          )}
                          {opponentPreference === 'black' && (
                            <View style={[styles.sideBadge, styles.sideBadgeOutline, { borderColor: '#3C2A1E' }]}>
                              <Text style={[styles.sideBadgeTextOutline, { color: '#3C2A1E' }]}>对手</Text>
                            </View>
                          )}
                        </View>
                      )}
                      <View style={[styles.sideDot, styles.sideDotBlack]} />
                      <Text
                        style={[
                          styles.sidePickBtnText,
                          (myPreference === 'black' || opponentPreference === 'black') && styles.sidePickBtnTextActive,
                        ]}
                      >
                        执黑后手
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.modalHint}>
                    双方选定后公示执棋结果（选边相同将随机分配），对方选定前可自由更改
                  </Text>
                </>
              )}
        </AppModal>

        {/* 房间信息/设置弹窗（顶栏齿轮打开；房主在等待阶段可修改；布局与大厅创建房间弹窗一致）。
            设置类弹窗允许物理返回键关闭（AppModal 默认行为） */}
        <AppModal
          visible={settingsVisible}
          onClose={() => setSettingsVisible(false)}
          title="房间设置"
          /* 【C-81】按钮行交给 AppModal 的 footer：卡片封顶时只让表单区收缩滚动，
             「取消/保存」恒在卡片下沿内侧。修掉的是真机上按钮被顶出卡片、压在背景棋盘上
             且点不到的溢出（此前靠 children 内 ScrollView 的 flexShrink 无法生效）。 */
          footer={
            <View style={modalButtonRowStyle}>
              <ModalButton
                label={canEditSettings ? '取消' : '关闭'}
                variant="secondary"
                onPress={() => setSettingsVisible(false)}
              />
              {canEditSettings && (
                <ModalButton
                  label="保存"
                  onPress={handleSaveSettings}
                  loading={savingSettings}
                  disabled={!editName.trim()}
                />
              )}
            </View>
          }
        >
          {/* 由 AppModal 的 bodyContent 承载：高度富余时按内容高度展示，
              超出卡片上限时这一层先收缩、由 ScrollView 内部滚动。 */}
          <ScrollView style={styles.settingsScroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {(() => {
                const canEdit = canEditSettings;
                const showOnlyHostHint = !canEdit && phase === 'waiting';
                // 展示值：编辑模式取编辑态，查看模式取房间实际值
                const baseVal = canEdit ? editBaseTime : baseTimeSeconds;
                const turnVal = canEdit ? editTurn : turnTimeLimit;
                const incVal = canEdit ? editIncrement : roomIncrementRef.current;
                const byoVal = canEdit ? editByoyomi : roomByoyomiRef.current;
                const hcVal = canEdit ? editHandicap : roomHandicap;
                return (
                  <>
                    {openSelect && (
                      <TouchableWithoutFeedback onPress={() => setOpenSelect(null)}>
                        <View style={formStyles.selectBackdrop} />
                      </TouchableWithoutFeedback>
                    )}

                    {/* 房间号（分享用，只读） */}
                    <View style={formStyles.fieldRowInline}>
                      <View style={formStyles.fieldCol}>
                        <Text style={formStyles.fieldLabel}>房间号</Text>
                        <View style={formStyles.fieldValueBox}>
                          <Text style={formStyles.fieldValueText}>{roomId}</Text>
                        </View>
                      </View>
                    </View>

                    {/* 房间名 + 房间密码（同行双列） */}
                    <View style={formStyles.fieldRowInline}>
                      <View style={formStyles.fieldCol}>
                        <Text style={formStyles.fieldLabel}>房间名</Text>
                        {canEdit ? (
                          <TextInput
                            style={formStyles.fieldInput}
                            value={editName}
                            onChangeText={setEditName}
                            maxLength={5}
                            placeholder="5字以内"
                            placeholderTextColor={COLORS.textLight}
                          />
                        ) : (
                          <View style={formStyles.fieldValueBox}>
                            <Text style={formStyles.fieldValueText} numberOfLines={1}>{roomName || '未命名'}</Text>
                          </View>
                        )}
                      </View>
                      <View style={formStyles.fieldCol}>
                        <Text style={formStyles.fieldLabel}>房间密码</Text>
                        {canEdit ? (
                          <TextInput
                            style={formStyles.fieldInput}
                            value={editPassword}
                            onChangeText={(t) => setEditPassword(t.replace(/\D/g, ''))}
                            keyboardType="number-pad"
                            maxLength={6}
                            placeholder="6位数字可留空"
                            placeholderTextColor={COLORS.textLight}
                          />
                        ) : (
                          <View style={formStyles.fieldValueBox}>
                            <Text style={formStyles.fieldValueText}>{roomPassword ? roomPassword : '无'}</Text>
                          </View>
                        )}
                      </View>
                    </View>

                    <Text style={formStyles.settingsSectionTitle}>对战设置</Text>
                    <View style={[formStyles.selectGrid, (openSelect === 'base' || openSelect === 'turn') && formStyles.selectGridOpen]}>
                      <SettingSelect
                        label="局时"
                        valueText={BASE_TIME_OPTIONS.find(o => o.value === baseVal)?.label ?? `${baseVal}秒`}
                        value={baseVal}
                        options={BASE_TIME_OPTIONS}
                        disabled={!canEdit}
                        open={openSelect === 'base'}
                        onToggle={() => setOpenSelect(openSelect === 'base' ? null : 'base')}
                        onSelect={(v) => { setEditBaseTime(v); if (v === 0) { setEditIncrement(0); setEditByoyomi(0); } setOpenSelect(null); }}
                      />
                      <SettingSelect
                        label="步时"
                        valueText={TURN_TIME_OPTIONS.find(o => o.value === turnVal)?.label ?? `${turnVal}秒`}
                        value={turnVal}
                        options={TURN_TIME_OPTIONS}
                        disabled={!canEdit}
                        open={openSelect === 'turn'}
                        onToggle={() => setOpenSelect(openSelect === 'turn' ? null : 'turn')}
                        onSelect={(v) => { setEditTurn(v); setOpenSelect(null); }}
                      />
                    </View>
                    <View style={[formStyles.selectGrid, (openSelect === 'inc' || openSelect === 'byo') && formStyles.selectGridOpen]}>
                      <SettingSelect
                        label="加秒"
                        valueText={baseVal === 0 ? '不限时' : (INCREMENT_OPTIONS.find(o => o.value === incVal)?.label ?? `${incVal}秒`)}
                        value={baseVal === 0 ? -1 : incVal}
                        options={INCREMENT_OPTIONS}
                        disabled={!canEdit || baseVal === 0 || byoVal > 0}
                        open={openSelect === 'inc'}
                        onToggle={() => setOpenSelect(openSelect === 'inc' ? null : 'inc')}
                        onSelect={(v) => { setEditIncrement(v); if (v > 0) setEditByoyomi(0); setOpenSelect(null); }}
                      />
                      <SettingSelect
                        label="读秒"
                        valueText={baseVal === 0 ? '不限时' : (BYOYOMI_OPTIONS.find(o => o.value === byoVal)?.label ?? `${byoVal}秒`)}
                        value={baseVal === 0 ? -1 : byoVal}
                        options={BYOYOMI_OPTIONS}
                        disabled={!canEdit || baseVal === 0 || incVal > 0}
                        open={openSelect === 'byo'}
                        onToggle={() => setOpenSelect(openSelect === 'byo' ? null : 'byo')}
                        onSelect={(v) => { setEditByoyomi(v); if (v > 0) setEditIncrement(0); setOpenSelect(null); }}
                      />
                    </View>
                    {baseVal > 0 && (
                      <Text style={formStyles.selectHint}>加秒：每走一步补回秒数 · 读秒：局时耗尽后每步固定时长（二选一）</Text>
                    )}
                    {turnVal > 0 && (
                      <Text style={formStyles.selectHint}>步时超时将由系统自动走一步棋</Text>
                    )}

                    <Text style={formStyles.settingsSectionTitle}>让子设置</Text>
                    <HandicapBoard
                      selected={hcVal}
                      onToggle={canEdit ? (id) => {
                        setEditHandicap(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
                      } : undefined}
                      readOnly={!canEdit}
                    />
                    <Text style={formStyles.hcSummary}>
                      {hcVal.length === 0 ? '不让子（标准开局）' : `已让 ${hcVal.length} 枚棋子（红方让子先行）`}
                    </Text>
                    {showOnlyHostHint && (
                      <Text style={styles.modalHint}>仅房主可修改房间信息与设置</Text>
                    )}
                  </>
                );
              })()}
          </ScrollView>
        </AppModal>

        {/* 中途退出二次确认：对局进行中（playing/reveal/countdown）返回时拦一道。
            语义与「认输」等价——服务端 settleAbandonedPlayingRoom 会以 endReason='leave'
            判对方获胜（surrenderBy 为 null，故结算文案走「对方离开了对局」而非「对方认输」）。
            强交互场景阻断物理返回键，避免二次确认期间再被返回键关掉。 */}
        <AppDialog
          visible={showLeaveConfirm}
          title="确认退出对局"
          message="中途退出将自动判负，确定要退出吗？"
          cancelText="继续对局"
          confirmText="退出并判负"
          danger
          blockBackButton
          onCancel={() => { setShowLeaveConfirm(false); showLeaveConfirmRef.current = false; }}
          onConfirm={confirmLeaveAndExit}
        />

        {/* 认输确认弹窗：强交互场景，阻断物理返回键（danger 变体替代原内联背景色覆盖） */}
        <AppDialog
          visible={showSurrenderModal}
          title="确认认输"
          message="确定要认输吗？认输后对手将获胜。"
          cancelText="取消"
          confirmText="确认认输"
          danger
          blockBackButton
          onCancel={() => setShowSurrenderModal(false)}
          onConfirm={handleSurrender}
        />

        {/* 对方悔棋请求：卡片精确居中于棋盘（anchorCenter 用窗口坐标对齐 boardFrame），
            强交互场景阻断物理返回键。
            正文按服务端锁定的 depth 措辞：退 1 手 / 退 2 手，让对方知道同意后到底撤几步 */}
        <AppDialog
          visible={undoRequestFromOpponent}
          title="悔棋请求"
          message={
            opponentUndoDepth === 1
              ? '对方请求悔棋（只撤销其刚走的一手），是否同意？'
              : '对方请求悔棋（撤销双方各一步），是否同意？'
          }
          cancelText="拒绝"
          confirmText="同意"
          confirmVariant="success"
          anchorCenter={dialogAnchorCenter}
          blockBackButton
          onCancel={() => handleUndoResponse(false)}
          onConfirm={() => handleUndoResponse(true)}
        />

        {/* 对方求和请求：同悔棋，居中于棋盘 */}
        <AppDialog
          visible={drawRequestFromOpponent}
          title="求和请求"
          message="对方请求和棋，同意后本局以和棋结束，是否同意？"
          cancelText="拒绝"
          confirmText="同意"
          confirmVariant="success"
          anchorCenter={dialogAnchorCenter}
          blockBackButton
          onCancel={() => handleDrawResponse(false)}
          onConfirm={() => handleDrawResponse(true)}
        />

        {/* 底部操作栏（与人机对战共用 @/components/GameBottomBar，2026-10 第二轮改造）
            位置：主容器的最后一个子节点，固定通栏贴屏幕最底端（此前在 boardHost 内，
            底栏高度变化/棋盘纵向居中都会带着它上下浮动）。
            公示/倒数/绝杀阶段隐藏内容但保留占位，避免棋盘位置跳动。
            对局中：菜单 / 认输 / 求和 / 悔棋 */}
        <GameBottomBar
          widthStyle={bottomBarWidthStyle}
          style={{ marginTop: dynamicGap }}
          bottomInset={insets.bottom}
          hidden={bottomBarHidden}
          actions={lanBarActions}
          menuItems={lanMenuItems}
          // 弹出卡片固定与按钮行同宽（见 GameBottomBarProps.popupWidthMode）：
          // 卡片上沿与我方名角标行纵向相邻，宽度随按键数变化会与角标边界"错位"。
          popupWidthMode="row"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  /**
   * 选中整屏背景图时容器必须让位：容器是 Screen 背景图之后的兄弟节点，
   * 实色底会整块盖住背景图。未选背景图时不加此样式 ⇒ 观感与改造前一致。
   */
  containerTransparent: {
    backgroundColor: 'transparent',
  },
  // 棋盘 + 底部操作栏内容宿主（2026-10 起顶部标题栏下线，宿主直接顶到安全区下方）
  boardHost: {
    flex: 1,
  },
  // 浮层（覆盖在棋盘上方）
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(245, 240, 232, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    // 公示/倒数/断线/结算浮层必须盖住棋盘：棋盘内部（被吃棋子抽屉等）使用了 elevation，
    // Android 上无 elevation 的浮层会被其遮挡而"沉到棋盘下方"，需同时给高 zIndex + elevation
    zIndex: 100,
    elevation: 100,
  },
  // 等待阶段：准备/选边简化按钮（基于底部按钮风格）
  // 选边弹窗：选边按钮行
  sidePickRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6,
    marginBottom: 14,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  sidePickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  sidePickBtnRed: {
    borderColor: COLORS.primary,
    backgroundColor: 'rgba(178,58,46,0.08)',
  },
  sidePickBtnBlack: {
    borderColor: '#3C2A1E',
    backgroundColor: 'rgba(60,42,30,0.08)',
  },
  sideDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  sideDotRed: {
    backgroundColor: COLORS.primary,
  },
  sideDotBlack: {
    backgroundColor: '#3C2A1E',
  },
  sidePickBtnText: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  sidePickBtnTextActive: {
    color: COLORS.textPrimary,
  },
  // 选边按钮右上角「我方/对手」小字标注
  sidePickBadges: {
    position: 'absolute',
    top: -10,
    right: 6,
    flexDirection: 'row',
    gap: 4,
    zIndex: 2,
    elevation: 2,
  },
  sideBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  sideBadgeOutline: {
    backgroundColor: COLORS.card,
  },
  sideBadgeTextSolid: {
    fontSize: FONT.micro,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 13,
  },
  sideBadgeTextOutline: {
    fontSize: FONT.micro,
    fontWeight: '700',
    lineHeight: 13,
  },
  // 选边结果公示（弹窗内容动画切换）
  sideResultWrap: {
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingVertical: 6,
  },
  sideResultMain: {
    fontSize: FONT.displayLg,
    fontWeight: 'bold',
    marginTop: 10,
    marginBottom: 6,
  },
  sideResultRandom: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    marginBottom: 4,
  },
  sideResultHandicap: {
    fontSize: FONT.control,
    fontWeight: '700',
    color: COLORS.primary,
    letterSpacing: 2,
    marginBottom: 10,
  },
  sideResultWish: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  sideResultCountdown: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    marginTop: 14,
  },
  // 房间设置弹窗（卡片壳子与遮罩已收敛到 AppModal；表单网格样式见共享组件
  // RoomSettingsControls 的 formStyles）。内边距由 AppModal 的 body 统一提供，
  // 这里不再覆盖 paddingHorizontal —— 否则表单标签会贴到卡片边框上。
  // 【C-81】按钮行已移交给 AppModal 的 footer（分页脚区自带分隔线与间距），
  // 原来的 settingsFooter 随之移除；此处只保留表单滚动容器的收缩契约。
  settingsScroll: {
    // 高度富余时按内容高度展示（不强行撑满卡片）；超出卡片上限时先收缩、
    // 由 ScrollView 内部滚动。AppModal 的 bodyContent 已提供同款约束，
    // 这里再写一份是为了让本组件自带该样式名，调用处不必手写内联对象。
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  // 执棋结果公示：仅剩颜色角色（字号由使用处的 FONT.* 决定）
  revealSideRed: {
    color: COLORS.primary,
  },
  revealSideBlack: {
    color: '#3C2A1E',
  },
  // 断线等待卡片
  disconnectCard: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    paddingHorizontal: 40,
    paddingVertical: 32,
    borderWidth: 2,
    borderColor: COLORS.primary,
  },
  disconnectTitle: {
    fontSize: FONT.title,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: 8,
  },
  disconnectHint: {
    fontSize: FONT.body,
    color: COLORS.textSecondary,
    marginBottom: 16,
  },
  disconnectCountdown: {
    fontSize: FONT.countdownCard,
    fontWeight: 'bold',
    color: COLORS.primary,
    marginBottom: 8,
  },
  disconnectSubHint: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
  },
  // 会话终结卡片（房间已销毁/已被移出/断线判负）的主操作按钮
  sessionGoneButton: {
    marginTop: 8,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: COLORS.primary,
  },
  sessionGoneButtonText: {
    fontSize: FONT.control,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  // 棋盘
  // 与人机模式一致：容器无额外 padding，棋盘由 ChessBoard 自身按屏宽居中
  boardContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  // 名字角标行：棋盘上下独立行（不遮挡棋盘），宽度在渲染处以数值屏宽传入
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 26,
    marginBottom: 4,
    paddingHorizontal: 12,
  },
  nameRowMe: {
    justifyContent: 'flex-end',
    marginBottom: 0,
    marginTop: 4,
  },
  // 名字角标（药丸形描边小标签）
  nameChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D7CCC8',
    paddingVertical: 4,
    paddingHorizontal: 10,
    maxWidth: '46%',
  },
  nameChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#2E7D32',
  },
  // 局时角标：与名字角标同款药丸，紧贴名字内侧。
  // nameRow 没有 gap，两行内药丸之间的间距唯一来源就是各自的 margin；
  // 对方行是普通 row（marginLeft = 名称与局时之间），我方行是 nameRowMe 右对齐镜像
  // （marginRight 才是名称与局时之间，若沿用 marginLeft 会变成行尾外侧而贴死）。
  // 故两者取同值，保证上下两侧「名字↔局时」间距一致。
  timerChip: {
    marginLeft: 6,
  },
  // 我方局时：右对齐镜像行，用 marginRight 与对方行的 marginLeft 对称
  timerChipMine: {
    marginRight: 6,
  },
  // 回合倒计时：同款药丸但语义不同——它属于行尾右对齐的一枚（与对方局时共用 marginLeft 会把它推走）
  timerChipPinned: {
    marginLeft: 'auto',
  },
  timerChipText: {
    fontSize: FONT.caption,
    fontWeight: '700',
    color: COLORS.textPrimary,
    fontVariant: ['tabular-nums'],
  },
  timerChipTextUrgent: {
    color: COLORS.danger,
  },
  nameChipDotWaiting: {
    backgroundColor: COLORS.textLight,
  },
  nameChipDotNotReady: {
    backgroundColor: '#BDBDBD',
  },
  readyTag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
  },
  readyTagOn: {
    borderColor: '#2E7D32',
    backgroundColor: 'rgba(46, 125, 50, 0.12)',
  },
  readyTagOff: {
    borderColor: '#BDBDBD',
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
  },
  readyTagText: {
    fontSize: FONT.micro,
    fontWeight: '600',
  },
  readyTagTextOn: {
    color: '#2E7D32',
  },
  readyTagTextOff: {
    color: '#9E9E9E',
  },
  nameChipText: {
    fontSize: FONT.caption,
    fontWeight: '600',
    color: COLORS.textPrimary,
    flexShrink: 1,
  },
  // ===== 对局内 emoji 表情互动 =====
  // 表情气泡：名称角标旁的圆角小气泡（弹入/淡出动画由组件内 Animated 驱动）
  emojiBubble: {
    marginHorizontal: 5,
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  emojiBubbleText: {
    // 表情为图形符号，字号随气泡尺寸微调，不套用正文字阶
    fontSize: 18,
    lineHeight: 22,
  },
  // 表情下拉栏：棋盘容器内的浮层（绝对定位于我方名称行正下方，宽度适配屏幕），
  // 单行横滑展示全部表情，展示不全时左右滑动选取；点选任意表情后自动收起
  emojiDropdown: {
    position: 'absolute',
    left: 0,
    zIndex: 60,
    backgroundColor: COLORS.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
    marginHorizontal: 12,
    shadowColor: COLORS.primary,
    shadowOpacity: 0.14,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  emojiDropdownContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  emojiDropdownCell: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiDropdownCellText: {
    // 表情为图形符号，字号随 44x44 单元格尺寸定，不套用正文字阶
    fontSize: 26,
    lineHeight: 32,
  },
  // 底部操作栏的视觉与交互已收敛到共享组件 @/components/GameBottomBar
  // （固定高度 BOTTOM_BAR_HEIGHT + 「菜单」向上弹出列表），各模式共用一份实现。
  // 弹窗遮罩/卡片/标题/按钮样式已收敛到 @/components/Modal
  // （AppModal 提供遮罩+卡片壳子，AppDialog 提供标题+正文+按钮，ModalButton 提供按钮变体），
  // 尺寸与配色统一走 @/constants/modal 的 Design Tokens。
  modalTitle: {
    fontSize: FONT.title,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    textAlign: 'center',
  },
  modalHint: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    textAlign: 'center',
    marginTop: 2,
    marginBottom: 4,
  },
});
