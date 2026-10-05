import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  TouchableWithoutFeedback,
  Pressable,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { AppModal, ModalButton, modalButtonRowStyle } from '@/components/Modal';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  getOnlineServerUrl,
  getOnlineServerProfile,
  setOnlineServerUrl,
  setOnlineServerProfile,
  resetOnlineServerUrl,
  migrateLegacyServerUrl,
  testServerConnection,
  SERVER_PROFILES,
  DEFAULT_SERVER_URL,
  latencyTier,
} from '@/utils/serverConfig';
import { getPlayerId, getPlayerName, savePlayerName, setRoomSessionToken } from '@/utils/playerIdentity';
import { HandicapBoard } from '@/components/HandicapBoard';
import {
  SettingSelect,
  formStyles,
  BASE_TIME_OPTIONS,
  TURN_TIME_OPTIONS,
  INCREMENT_OPTIONS,
  BYOYOMI_OPTIONS,
} from '@/components/RoomSettingsControls';
import { FONT } from '@/utils/typography';
import {
  TITLE_BAR_PADDING_HORIZONTAL,
  TITLE_BAR_PADDING_VERTICAL,
  BACK_BUTTON_SIZE,
} from '@/constants/chrome';

const COLORS = {
  background: '#F5F0E8',
  card: '#FFF8F0',
  primary: '#8B6914',
  textPrimary: '#3E2723',
  textSecondary: '#5D4037',
  textLight: '#8D6E63',
  border: 'rgba(139, 105, 20, 0.15)',
  success: '#2E7D32',
  danger: '#C62828',
};

/**
 * 「自定义地址」的解锁门槛：连续点击弹窗标题服务器设置达到该次数才显示。
 * 面向普通玩家只开放两条预置节点；自建服务端 / 内网地址等场景再走隐藏入口。
 */
const CUSTOM_UNLOCK_TAP_COUNT = 5;
/** 两次点击间隔超过该毫秒数即视为中断，重新从 1 次开始数 */
const CUSTOM_UNLOCK_TAP_WINDOW_MS = 3000;

/**
 * 延迟档位 → 文字样式。
 *
 * 取色沿用本文件已有的 success #2E7D32 与 danger #C62828；黄色补一个与同一宣纸底
 * (#F5F0E8) 对比度足够的琥珀色，不用 global.css 里的 --warning（那是 Web 侧
 * oklch 值，RN StyleSheet 无法消费 CSS 变量）。
 * 档位与阈值（200ms / 400ms）见 @/utils/serverConfig 的 latencyTier。
 */
function latencyToneStyle(tier: 'fast' | 'fair' | 'slow') {
  return tier === 'fast'
    ? styles.profileLatencyFast
    : tier === 'fair'
      ? styles.profileLatencyFair
      : styles.profileLatencySlow;
}

/** 让子 id → 棋子字（红方：21/22 马，23/24 车，25/26 炮，27~31 兵） */
function handicapPieceChar(id: number): string | null {
  if (id === 23 || id === 24) return '车';
  if (id === 21 || id === 22) return '马';
  if (id === 25 || id === 26) return '炮';
  if (id >= 27 && id <= 31) return '兵';
  return null;
}

/** 让子明细摘要：按车/马/炮/兵顺序去重拼接（大厅房间标签用，最长 4 字）
 *  【C-71】补默认值：服务端未下发 handicap 字段时 ids 为 undefined，
 *  `ids.map` 直接抛 TypeError → 整个房间列表 FlatList 渲染失败（白屏）。
 *  同函数的 filteredRooms 已用 `(r.hostName ?? '')` 兜过底，说明协议漂移确实被考虑过。 */
function handicapSummary(ids: number[] = []): string {
  const chars = new Set(ids.map(handicapPieceChar).filter((c): c is string => c !== null));
  return ['车', '马', '炮', '兵'].filter(c => chars.has(c)).join('');
}

// ===== 对战设置选项与 SettingSelect 下拉：见共享组件 @/components/RoomSettingsControls =====
// ===== 让子小棋盘：见共享组件 @/components/HandicapBoard =====

interface Room {
  id: string;
  name: string;
  hostName: string;
  createdAt: string;
  playerCount: number;
  phase: 'waiting' | 'playing';
  hasPassword: boolean;
  turnTimeLimit: number; // 房间设置：每轮限时（秒），0=不限时
  baseTimeSeconds: number; // 房间设置：局时（秒），0=不限时
  incrementSeconds: number; // 房间设置：加秒（秒）
  byoyomiSeconds: number; // 房间设置：读秒（秒），0=关闭
  handicapCount: number; // 房间设置：让子枚数（>0 展示让子标签）
  handicap: number[]; // 房间设置：让出的棋子 id（让子标签展示明细：车/马/炮/兵）
  spectatable: boolean; // 是否可观战（对战中的房间）
  spectatorCount: number; // 当前观战人数
}

// 当前账号所属的未结束房间（断线重连入口的数据结构，来自 GET /rooms/active）
interface ActiveRoom {
  id: string;
  name: string;
  phase: 'waiting' | 'playing';
  mySide: 'red' | 'black' | null;
  disconnected: boolean; // 服务端视角我是否处于断线状态
  opponentName: string;
  opponentConnected: boolean;
}

export default function LanGameScreen() {
  const router = useSafeRouter();
  const [rooms, setRooms] = useState<Room[]>([]);
  // 玩家身份（持久化：ID 与昵称设置后再次进入不变）
  const [playerId, setPlayerId] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // 对战设置（基本用时+加秒制）：局时默认 5 分钟；步时默认不限（超时随机走一步的旧行为仅在选择后启用）
  const [baseTime, setBaseTime] = useState(300); // 局时（秒），0=不限时
  const [turnLimit, setTurnLimit] = useState(0); // 步时（秒），0=不限
  const [increment, setIncrement] = useState(0); // 加秒（秒）
  const [byoyomi, setByoyomi] = useState(0); // 读秒（秒），0=关闭；与加秒互斥
  const [openSelect, setOpenSelect] = useState<'base' | 'turn' | 'inc' | 'byo' | null>(null); // 当前展开的下拉
  // 让子设置：红方让出的棋子 id（兵/车/马/炮，21~31）
  const [handicap, setHandicap] = useState<number[]>([]);
  // 创建房间：房间名与密码（可选）
  const [roomName, setRoomName] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [createError, setCreateError] = useState('');
  // 加入密码房间：密码输入弹窗
  const [passwordRoom, setPasswordRoom] = useState<Room | null>(null);
  const [joinPassword, setJoinPassword] = useState('');
  const [joinError, setJoinError] = useState('');
  // 列表加入失败的内联提示（实机 Alert 不可用，统一页面内联反馈）
  const [actionError, setActionError] = useState('');
  // 断线重连闭环：当前账号所属的未结束房间（waiting/playing），存在即置顶提供「回到对局」入口
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(null);

  // 服务器配置
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [serverStatus, setServerStatus] = useState<'unknown' | 'ok' | 'fail'>('unknown');
  const [showServerModal, setShowServerModal] = useState(false);
  const [serverInput, setServerInput] = useState('');
  /**
   * 当前选中的预置线路 id；为空表示正在用自定义地址（或环境变量地址），
   * 此时两个预置节点都不高亮，提示用户"当前为自定义地址"。
   */
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  /** 各线路的实测探测结果（毫秒）；null = 未探测或探测失败 */
  const [profileLatency, setProfileLatency] = useState<Record<string, number | null>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  /**
   * 自定义地址是否已解锁。
   *
   * 面向普通玩家只开放两条预置节点，手填地址容易误改导致连不上，因此默认隐藏；
   * 连续点击弹窗标题【自定义地址解锁所需的连续点击次数】次后才显示（自建服务端、
   * 内网地址等预置之外的场景仍要能配）。解锁状态只在本页会话内存活，关闭弹窗即失效。
   */
  const [customUnlocked, setCustomUnlocked] = useState(false);
  const unlockTapCountRef = useRef({ count: 0, tappedAt: 0 });

  // 房间码加入
  // 房间大厅搜索关键词：模糊匹配房间号/房间名/房主名（实时过滤列表）
  const [searchQuery, setSearchQuery] = useState('');

  // 获取实际使用的昵称（输入框内容，持久化模块保证非空）
  const getActualName = () => {
    return playerName.trim();
  };

  // 加载服务器地址并探测连通性
  const refreshServer = useCallback(async () => {
    const url = await getOnlineServerUrl();
    setServerUrl(url);
    setSelectedProfileId((await getOnlineServerProfile())?.id ?? null);
    setServerStatus('unknown');
    const latency = await testServerConnection(url, 4000);
    setServerStatus(latency !== null ? 'ok' : 'fail');
    if (latency !== null) {
      // 把实测值回填到对应线路，供弹窗里显示"实测 xxxms"
      const profile = await getOnlineServerProfile();
      if (profile) setProfileLatency((prev) => ({ ...prev, [profile.id]: latency }));
    }
  }, []);

  // 获取房间列表
  const fetchRooms = useCallback(async () => {
    try {
      const base = await getOnlineServerUrl();
      const response = await fetch(`${base}/api/v1/lan/rooms`);
      // 【C-55】fetch 只有网络层失败才会 reject；4xx/5xx 的响应对象照样 resolve，
      // 下面的 response.json() 会把 {"success":false,"error":"...","message":"..."}
      // 解析成对象，于是 data.rooms 为 undefined → setRooms([]) ——
      // 服务端报错被伪装成「大厅里一个房间都没有」。
      if (!response.ok) throw new Error(`获取房间列表失败：HTTP ${response.status}`);
      const data = await response.json();
      setRooms(data.rooms || []);
    } catch (error) {
      console.error('获取房间列表失败:', error);
    }
  }, []);

  // 查询当前账号是否有未结束的对局/房间（断线重连闭环的数据源）
  const fetchActiveRoom = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：GET /api/v1/lan/rooms/active
       * Query 参数：playerId: string
       */
      const response = await fetch(`${base}/api/v1/lan/rooms/active?playerId=${encodeURIComponent(id)}`);
      // 【C-56】同上：不判 response.ok 时，500 的 {"error":...} 会被当成
      // 「没有活跃对局」→ data.room 为 undefined → 断线重连入口静默消失。
      if (!response.ok) throw new Error(`查询活跃对局失败：HTTP ${response.status}`);
      const data = await response.json();
      setActiveRoom(data.room ?? null);
    } catch (error) {
      console.error('查询活跃对局失败:', error);
    }
  }, []);

  // 页面聚焦时加载持久化身份（昵称回填，再次进入不变）、刷新服务器状态与房间列表；
  // 身份就绪后启动统一轮询：房间列表 + 活跃对局（断线重连提醒）
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let interval: ReturnType<typeof setInterval> | null = null;
      (async () => {
        const [id, name] = await Promise.all([getPlayerId(), getPlayerName()]);
        if (cancelled) return;
        setPlayerId(id);
        setPlayerName(name);
        fetchActiveRoom(id);
        interval = setInterval(() => {
          fetchRooms();
          fetchActiveRoom(id);
        }, 3000);
      })();
      refreshServer();
      fetchRooms();
      return () => {
        cancelled = true;
        if (interval) clearInterval(interval);
      };
    }, [refreshServer, fetchRooms, fetchActiveRoom])
  );

  /**
   * 旧版本用户迁移：老版本把默认地址硬编码为 Cloudflare 并在首次启动时写盘，
   * 不迁移的话存量用户升级后仍停在 500ms 线路上。详见 serverConfig.migrateLegacyServerUrl。
   */
  useFocusEffect(
    useCallback(() => {
      migrateLegacyServerUrl();
    }, [])
  );

  /** 打开服务器设置弹窗 */
  const handleOpenServerModal = () => {
    setServerInput(serverUrl);
    setTestResult(null);
    // 每次打开都重新要求解锁，避免上次解锁后长期敞着自定义地址
    unlockTapCountRef.current = { count: 0, tappedAt: 0 };
    setCustomUnlocked(false);
    setShowServerModal(true);
  };

  /**
   * 连续点击弹窗标题若干次后解锁「自定义地址」区。
   *
   * 用 ref 计数而不是 state：点击频繁且只在达到阈值时才需要触发重渲染。
   * 超过【解锁阈值】的点击间隔（防止"今天点过 3 次、明天再点 2 次"也算连续）即重新计数。
   */
  const handleServerTitleTap = () => {
    const now = Date.now();
    if (now - unlockTapCountRef.current.tappedAt > CUSTOM_UNLOCK_TAP_WINDOW_MS) {
      unlockTapCountRef.current = { count: 1, tappedAt: now };
    } else {
      unlockTapCountRef.current = {
        count: unlockTapCountRef.current.count + 1,
        tappedAt: now,
      };
    }
    if (unlockTapCountRef.current.count >= CUSTOM_UNLOCK_TAP_COUNT) {
      unlockTapCountRef.current = { count: 0, tappedAt: 0 };
      setCustomUnlocked(true);
    }
  };

  // 切换到某条预置线路：立即落盘 + 关闭弹窗 + 刷新大厅
  const handleSelectProfile = async (id: string) => {
    setShowServerModal(false);
    setTestResult(null);
    await setOnlineServerProfile(id);
    refreshServer();
    fetchRooms();
  };

  // 测试连接
  const handleTestServer = async () => {
    setTesting(true);
    setTestResult(null);
    const latency = await testServerConnection(serverInput);
    setTesting(false);
    setTestResult(latency !== null ? `连接成功（${latency}ms）` : '连接失败，请检查地址或穿透隧道');
    return latency !== null;
  };

  // 保存服务器地址
  const handleSaveServer = async () => {
    await setOnlineServerUrl(serverInput);
    setShowServerModal(false);
    refreshServer();
    fetchRooms();
  };

  // 恢复默认地址
  const handleResetServer = async () => {
    await resetOnlineServerUrl();
    setShowServerModal(false);
    refreshServer();
    fetchRooms();
  };

  // 回到未结束的对局/房间（断线重连闭环：房间页会以成员身份同步服务端状态，
  // 取代旧流程中成员误点「观战」进入自己房间、看到空席位的问题）
  const handleBackToRoom = (target?: ActiveRoom) => {
    const room = target ?? activeRoom;
    if (!room || !playerId) return;
    router.push('/lanBattle', {
      roomId: room.id,
      playerId,
      playerName: getActualName(),
      // 断线重连时 activeRoom 已带房间名，首帧即显示真实标题
      roomName: room.name,
      side: room.mySide ?? 'red',
      // 【C-72】isHost 已删除：lanBattle 全文 0 处引用它，房主身份一律取服务端负载里的
      // room.hostId（:676 setHostId、:2813 canEdit）。留着这个死参数会让人误以为
      // 房主身份靠路由传递，从而写出"改路由参数就能当房主"的错误假设。
    });
  };

  // 进入观战：对战中的房间可以旁观者身份观看，不参与对局
  const handleSpectate = (room: Room) => {
    // 本人是该房间成员时不应进入观战（否则会看到自己和空席位占位），引导回到对局。
    // 注意：本人是成员但已被移出（对局中对方离开后自己先退出等）时 activeRoom 可能已失效，
    // 此时服务端会因席位不完整拒绝观战，错误页会给出「对局已有玩家离开」的终态说明。
    if (activeRoom && activeRoom.id === room.id) {
      handleBackToRoom(activeRoom);
      return;
    }
    router.push('/spectate', { roomId: room.id, roomName: room.name });
  };

  // 点击创建房间 → 弹出设置（房间名默认置空，留空由服务端按房间数量增序自动命名）
  const handleCreatePress = () => {
    setRoomName('');
    setRoomPassword('');
    setCreateError('');
    setOpenSelect(null);
    setShowSettings(true);
  };

  // 确认创建房间
  const handleConfirmCreate = async () => {
    const name = getActualName();
    if (!name || !playerId) {
      setCreateError('昵称加载中，请稍候再试');
      return;
    }
    savePlayerName(name); // 创建时同步保存昵称修改
    const turnTimeSeconds = turnLimit; // 步时（秒），0=不限
    const baseTimeSeconds = baseTime; // 局时（秒），0=不限时
    // 不限时时加秒/读秒均不生效；加秒与读秒互斥（UI 已保证二选一，此处再兜底）
    const incrementSeconds = baseTimeSeconds > 0 && byoyomi === 0 ? increment : 0;
    const byoyomiSeconds = baseTimeSeconds > 0 && increment === 0 ? byoyomi : 0;

    setLoading(true);
    setCreateError('');
    try {
      const base = await getOnlineServerUrl();
      /**
       * 服务端文件：chinese-chess-server/src/routes/lanGame.ts
       * 接口：POST /api/v1/lan/rooms
       * Body 参数：playerName: string, playerId: string,
       *   turnTimeSeconds: number, baseTimeSeconds: number, incrementSeconds: number,
       *   byoyomiSeconds: number, handicap: number[], roomName?: string, password?: string
       */
      const response = await fetch(`${base}/api/v1/lan/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerName: name,
          playerId,
          turnTimeSeconds,
          baseTimeSeconds,
          incrementSeconds,
          byoyomiSeconds,
          handicap,
          roomName: roomName.trim() || undefined,
          password: roomPassword.trim() || undefined,
        }),
      });
      // 【C-57】不判 response.ok 时，服务端 500 的 {"error":...} 与 4xx 的参数校验错误
      // 会走同一条 else 分支，catch 里的「无法连接对战服务器」覆盖掉了真实原因
      // （限流 500 / 参数 400 / 房间名超长），用户只看到一个误导性的网络提示。
      // 只有 5xx 与非 JSON 响应才当作服务端故障抛给 catch，4xx 保留 data.message 原文。
      if (!response.ok && response.status >= 500) {
        throw new Error(`创建房间失败：HTTP ${response.status}`);
      }
      const data = await response.json();

      if (data.roomId) {
        setShowSettings(false);
        // 【S-1 / §3.1】服务端签发的房间会话凭证（256 bit）。此后所有写操作都靠它鉴权，
        // playerId 退化为显示用标识。先持久化再跳转：对局页首帧就要用它拼 WS URL。
        if (typeof data.sessionToken === 'string' && data.sessionToken) {
          await setRoomSessionToken(data.roomId, playerId, data.sessionToken);
        }
        router.push('/lanBattle', {
          roomId: data.roomId,
          playerId,
          playerName: name,
          // 一并带上服务端最终的房间名（含留空时自动生成的「房间N」），进入对局页首帧即可显示
          roomName: data.room?.name,
          side: 'red',
          // 【C-72】isHost 死参数已删除，房主身份由服务端 room.hostId 决定
        });
      } else {
        // 第 3 批：失败 body 形状全端统一为 { success:false, error:<机器码>, message:<中文> }，
        // `error` 不再是给人看的文案，展示一律读 message
        setCreateError(
          typeof data.message === 'string' && data.message.trim()
            ? data.message
            : '创建房间失败',
        );
      }
    } catch (error) {
      console.error('创建房间失败:', error);
      setCreateError('无法连接对战服务器，请检查服务器设置');
    } finally {
      setLoading(false);
    }
  };

  // 加入房间（有密码的房间先弹密码输入框）
  const handleJoinRoom = (room: Room) => {
    setActionError('');
    if (room.hasPassword) {
      setPasswordRoom(room);
      setJoinPassword('');
      setJoinError('');
      return;
    }
    doJoinRoom(room.id, '', room.name);
  };

  // 执行加入请求（roomName 为大厅列表中的房间名，用于进入对局页首帧即显示标题）
  const doJoinRoom = async (roomId: string, password: string, roomName?: string) => {
    const name = getActualName();
    if (!name || !playerId) {
      setActionError('昵称加载中，请稍候再试');
      return;
    }
    savePlayerName(name); // 加入时同步保存昵称修改
    setLoading(true);
    setJoinError('');
    try {
      const base = await getOnlineServerUrl();
      const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName: name, playerId, password: password || undefined }),
      });
      // 【C-58】不判 response.ok 时，服务端 500 的 {"error":...} 会落到
      // 「加入房间失败」的兜底分支，密码弹窗被关掉、用户以为房间不存在。
      // 4xx 仍有业务语义（needPassword / 密码错误），照常解析 body；
      // 只有 5xx 与非 JSON 响应才当作传输/服务端故障走 catch。
      if (!response.ok && response.status >= 500) {
        throw new Error(`加入房间失败：HTTP ${response.status}`);
      }
      const data = await response.json();

      if (data.success) {
        setPasswordRoom(null);
        // 【S-1 / §3.1】接住服务端签发的会话凭证（幂等重入会重新签发，旧 token 立即失效，
        // 所以这里每次成功都要覆盖写）。
        if (typeof data.sessionToken === 'string' && data.sessionToken) {
          await setRoomSessionToken(roomId, playerId, data.sessionToken);
        }
        router.push('/lanBattle', {
          roomId,
          playerId,
          playerName: name,
          // 房间名取自大厅列表项（加入前即已知），避免对局页首帧显示兜底文案
          roomName: data.room?.name ?? roomName,
          side: 'black',
          // 【C-72】isHost 死参数已删除，房主身份由服务端 room.hostId 决定
        });
      } else if (data.needPassword) {
        // 需要密码或密码错误：弹出/保留密码框并提示
        setPasswordRoom(prev => prev ?? { id: roomId, name: `房间 ${roomId}`, hostName: '', createdAt: '', playerCount: 1, phase: 'waiting', hasPassword: true, turnTimeLimit: 0, baseTimeSeconds: 0, incrementSeconds: 0, byoyomiSeconds: 0, handicapCount: 0, handicap: [], spectatable: false, spectatorCount: 0 });
        setJoinError(password ? (data.message || '房间密码错误') : '该房间需要密码');
      } else {
        setPasswordRoom(null);
        setActionError(data.message || '加入房间失败');
      }
    } catch (error) {
      console.error('加入房间失败:', error);
      setPasswordRoom(null);
      setActionError('无法连接对战服务器，请检查服务器设置');
    } finally {
      setLoading(false);
    }
  };

  // 密码弹窗确认加入
  const handlePasswordJoin = () => {
    if (!passwordRoom) return;
    if (!joinPassword.trim()) {
      setJoinError('请输入房间密码');
      return;
    }
    doJoinRoom(passwordRoom.id, joinPassword.trim(), passwordRoom.name);
  };

  // 返回
  const handleBack = () => {
    router.back();
  };

  // 房间大厅模糊搜索：房间号/房间名/房主名的大小写不敏感包含匹配，实时过滤
  const filteredRooms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter(r =>
      r.id.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      (r.hostName ?? '').toLowerCase().includes(q)
    );
  }, [rooms, searchQuery]);

  // 服务器连接状态展示（顶部标题下方状态条）
  const statusColor =
    serverStatus === 'ok' ? COLORS.success : serverStatus === 'fail' ? COLORS.danger : COLORS.textLight;
  const statusLabel = serverStatus === 'ok' ? '已连接' : serverStatus === 'fail' ? '无法连接' : '检测中…';

  return (
    <Screen>
      <View style={styles.container}>
        {/* 顶部栏（右上角：服务器设置入口） */}
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backBtn} onPress={handleBack}>
            <FontAwesome6 name="chevron-left" size={20} color={COLORS.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.topTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>在线对局</Text>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={handleOpenServerModal}
            accessibilityLabel="服务器设置"
          >
            <FontAwesome6 name="gear" size={18} color={COLORS.textPrimary} />
          </TouchableOpacity>
        </View>

        {/* 服务器连接状态（顶部标题下方，仅显示连接状态） */}
        <View style={styles.serverStatusBar}>
          <View
            style={[
              styles.statusDot,
              serverStatus === 'ok'
                ? styles.statusOk
                : serverStatus === 'fail'
                  ? styles.statusFail
                  : styles.statusUnknown,
            ]}
          />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          {/* 昵称输入（修改后自动保存，再次进入不变） */}
          <View style={styles.nameSection}>
            <Text style={styles.nameLabel}>你的昵称</Text>
            <TextInput
              style={styles.nameInput}
              value={playerName}
              onChangeText={setPlayerName}
              onBlur={() => savePlayerName(playerName)}
              placeholder="输入昵称"
              placeholderTextColor={COLORS.textLight}
              maxLength={12}
            />
          </View>

          {/* 创建房间 */}
          <View style={styles.createSection}>
            <TouchableOpacity
              style={[styles.createBtn, loading && styles.createBtnDisabled]}
              onPress={handleCreatePress}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.createBtnText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>创建房间</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* 操作失败内联提示 */}
          {actionError ? (
            <View style={styles.actionErrorBar}>
              <FontAwesome6 name="circle-exclamation" size={13} color={COLORS.danger} />
              <Text style={styles.actionErrorText}>{actionError}</Text>
            </View>
          ) : null}

          {/* 断线重连提醒：当前账号有未结束的对局/房间时置顶显示，一键以成员身份回到房间页 */}
          {activeRoom && (
            <View style={styles.reconnectBanner}>
              <View style={styles.reconnectInfo}>
                <View style={styles.reconnectIconWrap}>
                  <FontAwesome6 name="rotate-right" size={15} color="#FFFFFF" />
                </View>
                <View style={styles.reconnectTexts}>
                  <Text style={styles.reconnectTitle}>
                    {activeRoom.phase === 'playing' ? '你有进行中的对局' : '你有未开始的房间'}
                  </Text>
                  <Text style={styles.reconnectSub} numberOfLines={1}>
                    {activeRoom.name}
                    {activeRoom.opponentName ? ` · 对手 ${activeRoom.opponentName}` : ''}
                    {activeRoom.disconnected ? ' · 已断线' : ''}
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.reconnectBtn}
                onPress={() => handleBackToRoom()}
                activeOpacity={0.85}
              >
                <Text style={styles.reconnectBtnText}>
                  {activeRoom.phase === 'playing' ? '回到对局' : '回到房间'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* 房间列表（含对局状态：等待中/准备中/对战中） */}
          <View style={styles.roomListSection}>
            {/* 标题行：右侧为模糊搜索框（房间号/房间名/房主名），最右搜索图标 */}
            <View style={styles.roomListHeader}>
              <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>房间大厅</Text>
              <View style={styles.searchBox}>
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="搜索房间号/房间名/房主名"
                  placeholderTextColor={COLORS.textLight}
                  autoCapitalize="none"
                  returnKeyType="search"
                />
                <FontAwesome6 name="magnifying-glass" size={13} color={COLORS.textLight} style={styles.searchIcon} />
              </View>
            </View>
            {rooms.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>暂无房间</Text>
                <Text style={styles.emptySubtext}>创建一个房间，把房间号分享给好友对战吧</Text>
              </View>
            ) : filteredRooms.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>未找到匹配的房间</Text>
                <Text style={styles.emptySubtext}>换个房间号、房间名或房主名试试</Text>
              </View>
            ) : (
              <FlatList
                data={filteredRooms}
                keyExtractor={(item) => item.id}
                scrollEnabled={false}
                renderItem={({ item }) => {
                  const joinable = item.phase === 'waiting' && item.playerCount < 2;
                  // 本人是该房间成员（断线重连场景）：提供回到对局入口，不再显示观战/加入
                  const isMyActiveRoom = activeRoom?.id === item.id;
                  const statusLabel = item.phase === 'playing' ? '对战中' : joinable ? '等待中' : '准备中';
                  const statusStyle = item.phase === 'playing'
                    ? styles.statusBadgePlaying
                    : joinable
                      ? styles.statusBadgeWaiting
                      : styles.statusBadgeBusy;
                  const statusTextStyle = item.phase === 'playing'
                    ? styles.statusBadgePlayingText
                    : joinable
                      ? styles.statusBadgeWaitingText
                      : styles.statusBadgeBusyText;
                  return (
                    <View style={styles.roomCard}>
                      {/* 第一行：房间名 + 状态徽标 + 房间号（卡片最右侧） */}
                      <View style={styles.roomNameRow}>
                        {item.hasPassword && (
                          <FontAwesome6 name="lock" size={11} color={COLORS.textLight} style={{ marginRight: 5 }} />
                        )}
                        <Text style={styles.roomHostName} numberOfLines={1}>{item.name}</Text>
                        {/* 房间状态徽标：紧邻房间名右侧 */}
                        <View style={[styles.statusBadge, statusStyle]}>
                          <Text style={[styles.statusBadgeText, statusTextStyle]}>{statusLabel}</Text>
                        </View>
                        {/* 房间号：卡片最右侧 */}
                        <Text style={styles.roomIdText} numberOfLines={1}>#{item.id}</Text>
                      </View>
                      {/* 第二行：设置小标签 + 操作按钮（与标签等高对齐） */}
                      <View style={styles.roomBottomRow}>
                        <View style={styles.roomTagsRow}>
                          <View style={styles.roomTag}>
                            <FontAwesome6 name="clock" size={10} color={COLORS.textLight} style={{ marginRight: 4 }} />
                            <Text style={styles.roomTagText}>
                              {item.baseTimeSeconds > 0
                                ? `${Math.floor(item.baseTimeSeconds / 60)}分钟${item.incrementSeconds > 0 ? `+${item.incrementSeconds}秒` : ''}${item.byoyomiSeconds > 0 ? `·读${item.byoyomiSeconds}s` : ''}${item.turnTimeLimit > 0 ? `·步${item.turnTimeLimit}s` : ''}`
                                : item.turnTimeLimit > 0 ? `限${item.turnTimeLimit}秒` : '不限时'}
                            </Text>
                          </View>
                          {item.handicapCount > 0 && (
                            <View style={[styles.roomTag, styles.roomTagHandicap]}>
                              {/* 与棋盘/小棋盘一致的红色「让」角标 */}
                              <View style={styles.roomTagHandicapBadge}>
                                <Text style={styles.roomTagHandicapBadgeText}>让</Text>
                              </View>
                              <Text style={[styles.roomTagText, styles.roomTagHandicapText]}>
                                {handicapSummary(item.handicap) || `${item.handicapCount}子`}
                              </Text>
                            </View>
                          )}
                        </View>
                        {isMyActiveRoom && (
                          <TouchableOpacity style={styles.rejoinBtn} onPress={() => handleBackToRoom()}>
                            <FontAwesome6 name="rotate-right" size={11} color="#FFFFFF" style={{ marginRight: 4 }} />
                            <Text style={styles.rejoinBtnText}>
                              {item.phase === 'playing' ? '回到对局' : '回到房间'}
                            </Text>
                          </TouchableOpacity>
                        )}
                        {!isMyActiveRoom && joinable && (
                          <TouchableOpacity
                            style={[styles.joinBtn, loading && styles.joinBtnDisabled]}
                            onPress={() => handleJoinRoom(item)}
                            disabled={loading}
                          >
                            <Text style={styles.joinBtnText}>加入</Text>
                          </TouchableOpacity>
                        )}
                        {/* 对战中的房间：旁观者观战入口（本人房间除外） */}
                        {!isMyActiveRoom && !joinable && item.spectatable && (
                          <TouchableOpacity style={styles.spectateBtn} onPress={() => handleSpectate(item)}>
                            <FontAwesome6 name="eye" size={11} color="#FFFFFF" style={{ marginRight: 4 }} />
                            <Text style={styles.spectateBtnText}>
                              观战{item.spectatorCount > 0 ? ` · ${item.spectatorCount}` : ''}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                }}
              />
            )}
          </View>
        </ScrollView>

        {/* 服务器设置弹窗 */}
        <AppModal
          visible={showServerModal}
          onClose={() => setShowServerModal(false)}
          titleNode={
            // 标题可连点：连续 CUSTOM_UNLOCK_TAP_COUNT 次才解锁下方「自定义地址」
            <Pressable
              onPress={handleServerTitleTap}
              hitSlop={8}
              accessibilityLabel="服务器设置"
            >
              <Text style={styles.serverModalTitle}>服务器设置</Text>
            </Pressable>
          }
          showCloseBtn
          closeBtnType="text"
        >
          {/* 线路选择：卡片式单选，点击即切换并立即生效。
              卡片只保留「单选圈 + 节点名 + 右侧延迟」三项，域名/说明文字一律不在此展示 ——
              普通用户只需要知道"选哪个"，具体地址属于高级信息，隐藏入口里自会回显。 */}
          {SERVER_PROFILES.map(profile => {
            const active = selectedProfileId === profile.id;
            const measured = profileLatency[profile.id];
            const shown = measured ?? profile.latencyMs;
            const tier = latencyTier(measured);
            return (
              <TouchableOpacity
                key={profile.id}
                style={[styles.profileCard, active && styles.profileCardActive]}
                onPress={() => handleSelectProfile(profile.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${profile.name}，延迟约 ${shown} 毫秒${
                  measured === null ? '（参考值）' : ''
                }`}
              >
                <View style={styles.profileRadio}>
                  {active && <View style={styles.profileRadioDot} />}
                </View>
                <View style={styles.profileBody}>
                  <View style={styles.profileTitleRow}>
                    <Text style={[styles.profileName, active && styles.profileNameActive]}>
                      {profile.name}
                    </Text>
                    {active && <Text style={styles.profileBadge}>当前</Text>}
                  </View>
                </View>
                {/* 延迟固定在卡片右侧：实测值优先，未探测成功则回落预置参考值 */}
                <View style={styles.profileLatencyCol}>
                  <Text style={[styles.profileLatency, latencyToneStyle(tier)]}>
                    {shown}
                    <Text style={styles.profileLatencyUnit}>ms</Text>
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}

          {/* 自定义地址：默认隐藏，连续点击标题 CUSTOM_UNLOCK_TAP_COUNT 次后才出现。
              自建服务端 / 内网地址等预置之外的场景仍要能配，所以保留而非删除。 */}
          {customUnlocked && (
            <>
              {selectedProfileId === null && serverUrl !== DEFAULT_SERVER_URL && (
                <Text style={styles.serverCustomHint}>
                  当前使用自定义地址，请在下方输入并保存。
                </Text>
              )}
              <Text style={[styles.serverSectionLabel, styles.serverSectionLabelSpaced]}>
                自定义地址
              </Text>
              <TextInput
                style={styles.serverInput}
                value={serverInput}
                onChangeText={(text) => {
                  setServerInput(text);
                  setTestResult(null);
                }}
                placeholder="https://服务器地址:端口"
                placeholderTextColor={COLORS.textLight}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <View style={styles.testRow}>
                <TouchableOpacity
                  style={styles.testBtn}
                  onPress={handleTestServer}
                  disabled={testing}
                >
                  {testing ? (
                    <ActivityIndicator size="small" color={COLORS.primary} />
                  ) : (
                    <Text style={styles.testBtnText}>测试连接</Text>
                  )}
                </TouchableOpacity>
                {testResult && (
                  <Text
                    style={[
                      styles.testResultText,
                      testResult.startsWith('连接成功') ? styles.testOk : styles.testFail,
                    ]}
                  >
                    {testResult}
                  </Text>
                )}
              </View>
              <View style={[modalButtonRowStyle, styles.serverFooter]}>
                <ModalButton label="恢复默认" variant="secondary" onPress={handleResetServer} />
                <ModalButton label="保存" onPress={handleSaveServer} />
              </View>
            </>
          )}
        </AppModal>

        {/* 房间设置弹窗 */}
        <AppModal
          visible={showSettings}
          onClose={() => setShowSettings(false)}
          title="创建房间"
          /* 【C-81】按钮行交给 AppModal 的 footer：卡片封顶时只让表单区收缩滚动，
             「取消/创建」恒在卡片下沿内侧（与房间内设置弹窗同一处修复）。 */
          footer={
            <View style={modalButtonRowStyle}>
              <ModalButton label="取消" variant="secondary" onPress={() => setShowSettings(false)} />
              <ModalButton label="创建" onPress={handleConfirmCreate} loading={loading} disabled={loading} />
            </View>
          }
        >
          {/* 由 AppModal 的 bodyContent 承载：高度富余时按内容高度展示，
              超出卡片上限时这一层先收缩、由 ScrollView 内部滚动。 */}
          <ScrollView
            style={styles.settingsScroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {openSelect && (
              <TouchableWithoutFeedback onPress={() => setOpenSelect(null)}>
                <View style={formStyles.selectBackdrop} />
              </TouchableWithoutFeedback>
            )}

            <View style={formStyles.fieldRowInline}>
                <View style={formStyles.fieldCol}>
                  <Text style={formStyles.fieldLabel}>房间名</Text>
                  <TextInput
                    style={formStyles.fieldInput}
                    value={roomName}
                    onChangeText={setRoomName}
                    placeholder="留空自动命名"
                    placeholderTextColor={COLORS.textLight}
                    maxLength={5}
                  />
                </View>
                <View style={formStyles.fieldCol}>
                  <Text style={formStyles.fieldLabel}>房间密码</Text>
                  <TextInput
                    style={formStyles.fieldInput}
                    value={roomPassword}
                    onChangeText={(t) => setRoomPassword(t.replace(/\D/g, ''))}
                    placeholder="6位数字可留空"
                    placeholderTextColor={COLORS.textLight}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                </View>
              </View>

              <Text style={formStyles.settingsSectionTitle}>对战设置</Text>
              <View style={[formStyles.selectGrid, (openSelect === 'base' || openSelect === 'turn') && formStyles.selectGridOpen]}>
                <SettingSelect
                  label="局时"
                  valueText={BASE_TIME_OPTIONS.find(o => o.value === baseTime)?.label ?? `${baseTime}秒`}
                  value={baseTime}
                  options={BASE_TIME_OPTIONS}
                  open={openSelect === 'base'}
                  onToggle={() => setOpenSelect(openSelect === 'base' ? null : 'base')}
                  onSelect={(v) => { setBaseTime(v); if (v === 0) { setIncrement(0); setByoyomi(0); } setOpenSelect(null); }}
                />
                <SettingSelect
                  label="步时"
                  valueText={TURN_TIME_OPTIONS.find(o => o.value === turnLimit)?.label ?? `${turnLimit}秒`}
                  value={turnLimit}
                  options={TURN_TIME_OPTIONS}
                  open={openSelect === 'turn'}
                  onToggle={() => setOpenSelect(openSelect === 'turn' ? null : 'turn')}
                  onSelect={(v) => { setTurnLimit(v); setOpenSelect(null); }}
                />
              </View>
              <View style={[formStyles.selectGrid, (openSelect === 'inc' || openSelect === 'byo') && formStyles.selectGridOpen]}>
                <SettingSelect
                  label="加秒"
                  valueText={baseTime === 0 ? '不限时' : (INCREMENT_OPTIONS.find(o => o.value === increment)?.label ?? `${increment}秒`)}
                  value={baseTime === 0 ? -1 : increment}
                  options={INCREMENT_OPTIONS}
                  disabled={baseTime === 0 || byoyomi > 0}
                  open={openSelect === 'inc'}
                  onToggle={() => setOpenSelect(openSelect === 'inc' ? null : 'inc')}
                  onSelect={(v) => { setIncrement(v); if (v > 0) setByoyomi(0); setOpenSelect(null); }}
                />
                <SettingSelect
                  label="读秒"
                  valueText={baseTime === 0 ? '不限时' : (BYOYOMI_OPTIONS.find(o => o.value === byoyomi)?.label ?? `${byoyomi}秒`)}
                  value={baseTime === 0 ? -1 : byoyomi}
                  options={BYOYOMI_OPTIONS}
                  disabled={baseTime === 0 || increment > 0}
                  open={openSelect === 'byo'}
                  onToggle={() => setOpenSelect(openSelect === 'byo' ? null : 'byo')}
                  onSelect={(v) => { setByoyomi(v); if (v > 0) setIncrement(0); setOpenSelect(null); }}
                />
              </View>
              {baseTime > 0 && (
                <Text style={formStyles.selectHint}>加秒：每走一步补回秒数 · 读秒：局时耗尽后每步固定时长（二选一）</Text>
              )}
              {turnLimit > 0 && (
                <Text style={formStyles.selectHint}>步时超时将由系统自动走一步棋</Text>
              )}

              <Text style={formStyles.settingsSectionTitle}>让子设置</Text>
              <HandicapBoard selected={handicap} onToggle={(id) => {
                setHandicap(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
              }} />
              <Text style={formStyles.hcSummary}>
                {handicap.length === 0 ? '不让子（标准开局）' : `已让 ${handicap.length} 枚棋子`}
              </Text>

              {createError ? <Text style={styles.modalErrorText}>{createError}</Text> : null}
          </ScrollView>
        </AppModal>

        {/* 密码房间加入弹窗 */}
        <AppModal
          visible={!!passwordRoom}
          onClose={() => setPasswordRoom(null)}
          title="加入房间"
          avoidKeyboard
        >
          <Text style={styles.passwordRoomName} numberOfLines={1}>
            {passwordRoom?.name ?? ''}
          </Text>
          <View style={styles.fieldRow}>
            <Text style={formStyles.fieldLabel}>房间密码</Text>
            <TextInput
              style={formStyles.fieldInput}
              value={joinPassword}
              onChangeText={(t) => {
                setJoinPassword(t.replace(/\D/g, ''));
                setJoinError('');
              }}
              placeholder="请输入房间密码"
              placeholderTextColor={COLORS.textLight}
              keyboardType="number-pad"
              autoFocus
              maxLength={6}
            />
          </View>
          {joinError ? <Text style={styles.modalErrorText}>{joinError}</Text> : null}
          <View style={[modalButtonRowStyle, styles.settingsFooter]}>
            <ModalButton label="取消" variant="secondary" onPress={() => setPasswordRoom(null)} />
            <ModalButton label="加入" onPress={handlePasswordJoin} loading={loading} disabled={loading} />
          </View>
        </AppModal>
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
   * 顶部标题栏：几何收敛到 `@/constants/chrome`，与其余各屏一致。
   *
   * 2026-10 改造前这里是 `padding: 16` + `paddingBottom: 8`（上下不对称，合计 24 ⇒ 栏高 64），
   * 比其余各屏（56 / 60）都高。现统一为 `paddingHorizontal 16 / paddingVertical 8`（栏高 56）。
   *
   * 注意本栏**故意没有** `borderBottom`（其余各屏有）：紧随其后的 `serverStatusBar`
   * 与本栏同底色、视觉上连为一体（见该样式注释），在本栏底部画一条分隔线会把这一整块
   * 从中间切断。该"头部区"真正的底边线由 `serverStatusBar` 的 `borderBottom` 承担，位置正确。
   */
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: TITLE_BAR_PADDING_HORIZONTAL,
    paddingVertical: TITLE_BAR_PADDING_VERTICAL,
    backgroundColor: COLORS.card,
  },
  /**
   * 服务器连接状态条：与上方 `topBar` 同底色、视觉上连为一体，因此 `topBar` 不画底边框
   * （见 `topBar` 注释）。整个"头部区"真正的底边线由本条的 `borderBottom` 承担。
   */
  serverStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  /** 返回按钮：与人机难度/残局闯关/复盘列表统一的 40×40 圆角卡片样式 */
  backBtn: {
    width: BACK_BUTTON_SIZE,
    height: BACK_BUTTON_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  topTitle: {
    fontSize: FONT.title,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusOk: {
    backgroundColor: COLORS.success,
  },
  statusFail: {
    backgroundColor: COLORS.danger,
  },
  statusUnknown: {
    backgroundColor: COLORS.textLight,
  },
  statusText: {
    fontSize: FONT.caption,
    fontWeight: '600',
    color: COLORS.textLight,
  },
  nameSection: {
    padding: 20,
    paddingBottom: 12,
  },
  nameLabel: {
    fontSize: FONT.body,
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  nameInput: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    fontSize: FONT.control,
    color: COLORS.textPrimary,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  createSection: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  createBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  createBtnDisabled: {
    opacity: 0.6,
  },
  createBtnText: {
    color: '#fff',
    fontSize: FONT.control,
    fontWeight: '600',
  },
  // 房间大厅标题行：标题居左、搜索框居右
  roomListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    height: 36,
    paddingLeft: 12,
    paddingRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: FONT.control,
    color: COLORS.textPrimary,
    paddingVertical: 0,
    height: '100%',
  },
  searchIcon: {
    marginLeft: 8,
  },
  roomListSection: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  sectionTitle: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 32,
  },
  emptyText: {
    fontSize: FONT.body,
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
  },
  roomCard: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  roomNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  roomHostName: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.textPrimary,
    flexShrink: 1,
  },
  // 房间号：卡片最右侧
  roomIdText: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    marginLeft: 'auto',
    flexShrink: 0,
  },
  // 第二行：标签 + 操作按钮（与标签等高对齐）
  roomBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  // 房间设置小标签（用时/让子）：行高与右侧操作按钮一致，视觉对齐
  roomTagsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
    marginRight: 10,
  },
  roomTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    height: 34,
    paddingHorizontal: 8,
  },
  roomTagText: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
  },
  roomTagHandicap: {
    backgroundColor: '#FDE8E8',
    borderColor: 'rgba(192, 57, 43, 0.35)',
  },
  roomTagHandicapBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#C0392B',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  roomTagHandicapBadgeText: {
    fontSize: FONT.micro,
    color: '#FFFFFF',
    fontWeight: '700',
  },
  roomTagHandicapText: {
    color: '#C0392B',
    fontWeight: '600',
  },
  // ===== 对战设置下拉/表单网格样式见共享组件 RoomSettingsControls（formStyles）=====
  // 房间对局状态徽标（紧邻房间名右侧）
  statusBadge: {
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginLeft: 8,
    flexShrink: 0,
  },
  statusBadgeWaiting: {
    backgroundColor: 'rgba(46, 125, 50, 0.12)',
  },
  statusBadgeWaitingText: {
    color: COLORS.success,
  },
  statusBadgeBusy: {
    backgroundColor: 'rgba(139, 105, 20, 0.12)',
  },
  statusBadgeBusyText: {
    color: COLORS.primary,
  },
  statusBadgePlaying: {
    backgroundColor: 'rgba(93, 64, 55, 0.12)',
  },
  statusBadgePlayingText: {
    color: COLORS.textSecondary,
  },
  statusBadgeText: {
    fontSize: FONT.micro,
    fontWeight: '600',
  },
  // 操作失败内联提示条
  actionErrorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(198, 40, 40, 0.08)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  actionErrorText: {
    fontSize: FONT.caption,
    color: COLORS.danger,
    flexShrink: 1,
  },
  // 弹窗表单字段（双列/标签/输入框样式见共享组件 RoomSettingsControls 的 formStyles）
  fieldRow: {
    marginBottom: 14,
  },
  modalErrorText: {
    fontSize: FONT.caption,
    color: COLORS.danger,
    marginBottom: 10,
    textAlign: 'center',
  },
  passwordRoomName: {
    fontSize: FONT.body,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginBottom: 14,
  },
  joinBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    height: 34,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  joinBtnDisabled: {
    opacity: 0.6,
  },
  joinBtnText: {
    color: '#fff',
    fontSize: FONT.body,
    fontWeight: '600',
  },
  // 观战按钮（对战中的房间，旁观者入口）
  spectateBtn: {
    backgroundColor: '#5D4037',
    borderRadius: 8,
    height: 34,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spectateBtnText: {
    color: '#fff',
    fontSize: FONT.body,
    fontWeight: '600',
  },
  // 回到对局按钮（本人所在的未结束房间）
  rejoinBtn: {
    backgroundColor: COLORS.success,
    borderRadius: 8,
    height: 34,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejoinBtnText: {
    color: '#fff',
    fontSize: FONT.body,
    fontWeight: '600',
  },
  // 断线重连提醒横幅（置顶于房间列表上方）
  reconnectBanner: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(46, 125, 50, 0.35)',
    padding: 14,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    shadowColor: COLORS.success,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 3,
  },
  reconnectInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 12,
  },
  reconnectIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  reconnectTexts: {
    flex: 1,
  },
  reconnectTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: 2,
  },
  reconnectSub: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
  },
  reconnectBtn: {
    backgroundColor: COLORS.success,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  reconnectBtnText: {
    color: '#fff',
    fontSize: FONT.control,
    fontWeight: '700',
  },
  // 弹窗遮罩/卡片/标题/按钮样式已收敛到 @/components/Modal（AppModal / ModalButton），
  // 尺寸与配色统一走 @/constants/modal 的 Design Tokens。
  // 内边距（左右 24 / 上 20 / 下 24）由 AppModal 的 body 统一提供，
  // 这里不再覆盖 paddingHorizontal —— 否则表单标签会贴到卡片边框上。
  // 【C-81】创建房间弹窗的按钮行已移交给 AppModal 的 footer（页脚区自带分隔线与间距），
  // 原来的 settingsFooter 随之移除；此处只保留表单滚动容器的收缩契约。
  // 「加入房间」弹窗的按钮行仍在 body 内（非滚动内容，页脚化无收益），继续用 settingsFooter。
  settingsScroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  settingsFooter: {
    marginTop: 20,
  },
  serverFooter: {
    marginTop: 20,
  },
  serverInput: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 12,
    fontSize: FONT.control,
    color: COLORS.textPrimary,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  serverSectionLabel: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  serverSectionLabelSpaced: {
    marginTop: 18,
  },
  serverCustomHint: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    marginTop: 8,
  },
  /** 线路卡片：单选态用主色描边 + 浅色底区分，未选中保持中性 */
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
  },
  profileCardActive: {
    borderColor: COLORS.primary,
    borderWidth: 2,
    backgroundColor: 'rgba(139, 105, 20, 0.08)',
  },
  /** 自绘单选圆圈（RN 无内置 radio，用双层 View 组合） */
  profileRadio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileRadioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.primary,
  },
  profileBody: {
    flex: 1,
  },
  profileTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  profileName: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  profileNameActive: {
    color: COLORS.primary,
  },
  profileBadge: {
    fontSize: FONT.micro,
    fontWeight: '700',
    color: '#FFFFFF',
    backgroundColor: COLORS.primary,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  /** 弹窗标题（titleNode 自定义渲染，行高/字重与 AppModal 默认标题一致） */
  serverModalTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.textPrimary,
    textAlign: 'center',
  },
  /** 延迟数值列：卡片右侧固定宽度，数值左对齐，两条线路的数字上下对齐 */
  profileLatencyCol: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 56,
  },
  profileLatency: {
    fontSize: FONT.control,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  profileLatencyUnit: {
    fontSize: FONT.micro,
    fontWeight: '600',
  },
  profileLatencyFast: {
    color: COLORS.success,
  },
  profileLatencyFair: {
    color: '#B26A00',
  },
  profileLatencySlow: {
    color: COLORS.danger,
  },
  testRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 10,
  },
  testBtn: {
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  testBtnText: {
    color: COLORS.primary,
    fontSize: FONT.body,
    fontWeight: '600',
  },
  testResultText: {
    fontSize: FONT.caption,
    flex: 1,
  },
  testOk: {
    color: COLORS.success,
  },
  testFail: {
    color: COLORS.danger,
  },
});
