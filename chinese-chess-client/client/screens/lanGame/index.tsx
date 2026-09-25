import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Modal,
  ScrollView,
  TouchableWithoutFeedback,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  getOnlineServerUrl,
  setOnlineServerUrl,
  resetOnlineServerUrl,
  testServerConnection,
  DEFAULT_SERVER_URL,
} from '@/utils/serverConfig';
import { getPlayerId, getPlayerName, savePlayerName } from '@/utils/playerIdentity';
import { HandicapBoard } from '@/components/HandicapBoard';
import {
  SettingSelect,
  formStyles,
  BASE_TIME_OPTIONS,
  TURN_TIME_OPTIONS,
  INCREMENT_OPTIONS,
  BYOYOMI_OPTIONS,
} from '@/components/RoomSettingsControls';

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

/** 让子 id → 棋子字（红方：21/22 马，23/24 车，25/26 炮，27~31 兵） */
function handicapPieceChar(id: number): string | null {
  if (id === 23 || id === 24) return '车';
  if (id === 21 || id === 22) return '马';
  if (id === 25 || id === 26) return '炮';
  if (id >= 27 && id <= 31) return '兵';
  return null;
}

/** 让子明细摘要：按车/马/炮/兵顺序去重拼接（大厅房间标签用，最长 4 字） */
function handicapSummary(ids: number[]): string {
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

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
    setServerStatus('unknown');
    const latency = await testServerConnection(url, 4000);
    setServerStatus(latency !== null ? 'ok' : 'fail');
  }, []);

  // 获取房间列表
  const fetchRooms = useCallback(async () => {
    try {
      const base = await getOnlineServerUrl();
      const response = await fetch(`${base}/api/v1/lan/rooms`);
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
       * 服务端文件：server/src/routes/lanGame.ts
       * 接口：GET /api/v1/lan/rooms/active
       * Query 参数：playerId: string
       */
      const response = await fetch(`${base}/api/v1/lan/rooms/active?playerId=${encodeURIComponent(id)}`);
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

  // 打开服务器设置弹窗
  const handleOpenServerModal = () => {
    setServerInput(serverUrl);
    setTestResult(null);
    setShowServerModal(true);
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
      side: room.mySide ?? 'red',
      isHost: false,
    });
  };

  // 进入观战：对战中的房间可以旁观者身份观看，不参与对局
  const handleSpectate = (room: Room) => {
    // 本人是该房间成员时不应进入观战（否则会看到自己和「红方/黑方」占位席），引导回到对局
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
       * 服务端文件：server/src/routes/lanGame.ts
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
      const data = await response.json();

      if (data.roomId) {
        setShowSettings(false);
        router.push('/lanBattle', {
          roomId: data.roomId,
          playerId,
          playerName: name,
          side: 'red',
          isHost: true,
        });
      } else {
        setCreateError(data.error || '创建房间失败');
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
    doJoinRoom(room.id, '');
  };

  // 执行加入请求
  const doJoinRoom = async (roomId: string, password: string) => {
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
      const data = await response.json();

      if (data.success) {
        setPasswordRoom(null);
        router.push('/lanBattle', {
          roomId,
          playerId,
          playerName: name,
          side: 'black',
          isHost: false,
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
    doJoinRoom(passwordRoom.id, joinPassword.trim());
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
        <Modal visible={showServerModal} transparent animationType="fade"
        statusBarTranslucent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>服务器设置</Text>
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
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalButtonCancel}
                  onPress={handleResetServer}
                >
                  <Text style={styles.modalButtonTextCancel}>恢复默认</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalButtonConfirm}
                  onPress={handleSaveServer}
                >
                  <Text style={styles.modalButtonTextConfirm}>保存</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={styles.modalCloseBtn}
                onPress={() => setShowServerModal(false)}
              >
                <Text style={styles.modalButtonTextCancel}>取消</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* 房间设置弹窗 */}
        <Modal visible={showSettings} transparent animationType="fade"
        statusBarTranslucent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <ScrollView style={{ flexGrow: 0 }} showsVerticalScrollIndicator={false}>
              {openSelect && (
                <TouchableWithoutFeedback onPress={() => setOpenSelect(null)}>
                  <View style={formStyles.selectBackdrop} />
                </TouchableWithoutFeedback>
              )}
              <Text style={styles.modalTitle}>创建房间</Text>

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
                  options={BASE_TIME_OPTIONS}
                  open={openSelect === 'base'}
                  onToggle={() => setOpenSelect(openSelect === 'base' ? null : 'base')}
                  onSelect={(v) => { setBaseTime(v); if (v === 0) { setIncrement(0); setByoyomi(0); } setOpenSelect(null); }}
                />
                <SettingSelect
                  label="步时"
                  valueText={TURN_TIME_OPTIONS.find(o => o.value === turnLimit)?.label ?? `${turnLimit}秒`}
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
                  options={INCREMENT_OPTIONS}
                  disabled={baseTime === 0 || byoyomi > 0}
                  open={openSelect === 'inc'}
                  onToggle={() => setOpenSelect(openSelect === 'inc' ? null : 'inc')}
                  onSelect={(v) => { setIncrement(v); if (v > 0) setByoyomi(0); setOpenSelect(null); }}
                />
                <SettingSelect
                  label="读秒"
                  valueText={baseTime === 0 ? '不限时' : (BYOYOMI_OPTIONS.find(o => o.value === byoyomi)?.label ?? `${byoyomi}秒`)}
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

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalButtonCancel}
                  onPress={() => setShowSettings(false)}
                >
                  <Text style={styles.modalButtonTextCancel}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalButtonConfirm}
                  onPress={handleConfirmCreate}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.modalButtonTextConfirm}>创建</Text>
                  )}
                </TouchableOpacity>
              </View>
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* 密码房间加入弹窗 */}
        <Modal visible={!!passwordRoom} transparent animationType="fade"
        statusBarTranslucent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>加入房间</Text>
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
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalButtonCancel}
                  onPress={() => setPasswordRoom(null)}
                >
                  <Text style={styles.modalButtonTextCancel}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.modalButtonConfirm}
                  onPress={handlePasswordJoin}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.modalButtonTextConfirm}>加入</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    paddingBottom: 8,
    backgroundColor: COLORS.card,
  },
  // 服务器连接状态条（顶部标题下方，与顶栏视觉连为一体）
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
  /** 返回按钮：与人机对战/残局闯关/对局页统一的 40×40 圆角卡片样式 */
  backBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  topTitle: {
    fontSize: 18,
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
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textLight,
  },
  nameSection: {
    padding: 20,
    paddingBottom: 12,
  },
  nameLabel: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  nameInput: {
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
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
    fontSize: 16,
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
    fontSize: 13,
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
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 32,
  },
  emptyText: {
    fontSize: 16,
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 13,
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
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.textPrimary,
    flexShrink: 1,
  },
  // 房间号：卡片最右侧
  roomIdText: {
    fontSize: 12,
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
    fontSize: 12,
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
    fontSize: 10,
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
    fontSize: 11,
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
    fontSize: 13,
    color: COLORS.danger,
    flexShrink: 1,
  },
  // 弹窗表单字段（双列/标签/输入框样式见共享组件 RoomSettingsControls 的 formStyles）
  fieldRow: {
    marginBottom: 14,
  },
  modalErrorText: {
    fontSize: 13,
    color: COLORS.danger,
    marginBottom: 10,
    textAlign: 'center',
  },
  passwordRoomName: {
    fontSize: 14,
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
    fontSize: 14,
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
    fontSize: 13,
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
    fontSize: 13,
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
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: 2,
  },
  reconnectSub: {
    fontSize: 12,
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
    fontSize: 14,
    fontWeight: '700',
  },
  // 弹窗样式
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalContent: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 24,
    width: '85%',
    maxWidth: 360,
    maxHeight: '88%',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: 16,
    textAlign: 'center',
  },
  serverInput: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: COLORS.textPrimary,
    borderWidth: 1,
    borderColor: COLORS.border,
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
    fontSize: 13,
    fontWeight: '600',
  },
  testResultText: {
    fontSize: 12,
    flex: 1,
  },
  testOk: {
    color: COLORS.success,
  },
  testFail: {
    color: COLORS.danger,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  modalButtonCancel: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  modalButtonTextCancel: {
    color: COLORS.textSecondary,
    fontSize: 15,
  },
  modalButtonConfirm: {
    flex: 1,
    backgroundColor: COLORS.primary,
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  modalButtonTextConfirm: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  modalCloseBtn: {
    marginTop: 10,
    padding: 10,
    alignItems: 'center',
  },
});
