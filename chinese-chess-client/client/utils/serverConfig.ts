/**
 * 互联网对战服务器配置
 *
 * 用户在自己的电脑上运行服务端（server 目录），再通过内网穿透把本地端口映射为公网 HTTPS
 * 地址，在大厅"服务器设置"里选择使用哪条线路。当前预置两条线路（见 SERVER_PROFILES）：
 *   - 樱花穿透节点：国内直连，实测往返约 100ms（默认）
 *   - Cloudflare 节点：公网可达性兜底，实测往返约 500ms
 * 两条线路都只提供 HTTPS（隧道侧仅放行 TLS），因此默认使用 https 协议。
 *
 * 地址持久化在 AsyncStorage，未设置时使用默认线路。设置入口见 @/screens/lanGame。
 *
 * Web 平台说明：开发时 Metro Bundler 配置了代理，会将 /api/v1/* 转发到后端。
 * 因此在 Web 端未设置时应使用相对路径（空字符串），让请求走 Metro 代理，
 * 避免浏览器 CORS 限制和 localhost 不可达问题。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const STORAGE_KEY = 'online_server_url';
/** 用户是否已明确选过线路。用于"旧版本自动迁移到新默认"只做一次。 */
const CHOICE_KEY = 'online_server_pick_v1';

export interface ServerProfile {
  /** 稳定标识，勿随意更改（会作为持久化选择值） */
  id: string;
  /** 界面显示的节点名 */
  name: string;
  /** 节点公网地址（含协议与端口） */
  url: string;
  /** 实测往返延迟参考值（毫秒），仅用于界面提示，不代表实时值 */
  latencyMs: number;
  /** 一句话说明 */
  desc: string;
}

/**
 * 预置对战线路（顺序即界面展示顺序，第一个为默认）
 *
 * 延迟数据来源：2026-10-05 于上海电信（ip=183.222.255.242）实测的
 * "对手落子 → 本端屏幕可见" p50，见仓库根目录 TUNNEL-EVALUATION.md。
 * 换网络环境后请重新实测并更新这两个数字。
 */
export const SERVER_PROFILES: readonly ServerProfile[] = [
  {
    id: 'sakura',
    name: '樱花穿透节点',
    url: 'https://www-preview-api.u1103143.nyat.app:16526',
    latencyMs: 100,
    desc: '国内线路，推荐',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare 节点',
    url: 'https://chess.ttocnserver.dpdns.org',
    latencyMs: 500,
    desc: '备用线路',
  },
] as const;

/** 默认线路 id（SERVER_PROFILES[0].id） */
export const DEFAULT_SERVER_PROFILE_ID = 'sakura';

/** 按 id 取预置线路 */
export function getServerProfile(id: string): ServerProfile | null {
  return SERVER_PROFILES.find((p) => p.id === id) ?? null;
}

/**
 * 反查某地址属于哪条预置线路；不是预置地址（含自定义地址）返回 null。
 * 仅做"去掉尾部斜杠 + 忽略大小写"的整串比较——地址在保存时已被 normalizeServerUrl
 * 规范化过，因此预置线路的 url 就是它的规范形态。
 */
export function matchServerProfile(url: string): ServerProfile | null {
  const target = (url ?? '').trim().replace(/\/+$/, '').toLowerCase();
  if (!target) return null;
  return SERVER_PROFILES.find((p) => p.url.toLowerCase() === target) ?? null;
}

/**
 * 默认服务器地址（未自定义时使用）。
 * 樱花穿透节点对公网仅提供 HTTPS，因此默认使用 https 协议。
 * Web 端开发时返回空字符串，使用相对路径走 Metro 代理。
 * 环境变量 EXPO_PUBLIC_BACKEND_BASE_URL 仍可覆盖（自建/联调时用），此时不属于任何预置线路。
 */
export const DEFAULT_SERVER_URL = (() => {
  if (Platform.OS === 'web') return '';
  return (
    process.env.EXPO_PUBLIC_BACKEND_BASE_URL ||
    getServerProfile(DEFAULT_SERVER_PROFILE_ID)?.url ||
    ''
  );
})();

// 内存缓存，避免每次请求都读 AsyncStorage；带 TTL 定期回源，
// 避免"进程启动时读一次、此后永久定格"——改了服务器地址或环境变量不生效。
const CACHE_TTL_MS = 30000;
let cachedUrl: string | null = null;
let cachedAt = 0;
let inflight: Promise<string> | null = null;

// —— 持久化写入队列 ——
// AsyncStorage.setItem 与 removeItem 都可能抛错（配额满/存储层异常）。若让多个调用
// 同时发起写入，失败会静默丢数据。更重要的是：写入是异步的，而 getOnlineServerUrl
// 可能在写入完成前就读到旧值——表现为"用户刚点了换节点，界面仍显示旧节点"。
// 用一个串行队列保证"写入完成后再有下一笔写入"，调用方 await 即代表已落盘。
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite(task: () => Promise<unknown>): Promise<unknown> {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

/** 提取主机名（去除协议、端口、路径），用于判断地址类型 */
function extractHost(url: string): string {
  let host = url.replace(/^https?:\/\//i, '');
  host = host.split('/')[0];
  host = host.split(':')[0];
  return host.toLowerCase();
}

/**
 * 判断是否为公网域名（非 IP、非 localhost）。
 * 公网隧道（SakuraFrp / Cloudflare 等）仅提供 HTTPS，因此公网域名需用 https；
 * 内网 IP / localhost 仍可用 http。
 */
function isPublicHost(url: string): boolean {
  const host = extractHost(url);
  if (!host || host === 'localhost') return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false; // IPv4
  if (host.includes(':')) return false; // IPv6
  return host.includes('.'); // 含点号视为公网域名
}

/** 规范化服务器地址：补全协议、去除尾部斜杠；公网域名强制 https（公网隧道仅支持 HTTPS） */
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  // Web 端允许空字符串（走 Metro 代理的相对路径）
  if (!url) return Platform.OS === 'web' ? '' : DEFAULT_SERVER_URL;
  if (!/^https?:\/\//i.test(url)) {
    // 未指定协议：公网域名默认 https，内网 IP / localhost 默认 http
    url = `${isPublicHost(url) ? 'https' : 'http'}://${url}`;
  } else if (/^http:\/\//i.test(url) && isPublicHost(url)) {
    // 已显式使用 http:// 但目标是公网域名：公网隧道仅支持 HTTPS，自动升级为 https
    url = url.replace(/^http:\/\//i, 'https://');
  }
  return url.replace(/\/+$/, '');
}

/**
 * 获取当前对战服务器地址（优先用户自定义，其次默认地址）
 *
 * 缓存有 30s TTL：命中则直接返回；过期后重新读 AsyncStorage，并把并发请求
 * 合并成一次实际读取（inflight），既避免每步走子都读一次磁盘，也不至于
 * "一次读取后永远定格"导致换地址/改环境变量后仍连旧服务器。
 */
export async function getOnlineServerUrl(): Promise<string> {
  if (cachedUrl !== null && Date.now() - cachedAt < CACHE_TTL_MS) return cachedUrl;
  if (inflight) return inflight;
  inflight = (async () => {
    let resolved = DEFAULT_SERVER_URL;
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) resolved = normalizeServerUrl(saved);
    } catch {
      // 读取失败时使用默认地址
    }
    cachedUrl = resolved;
    cachedAt = Date.now();
    return resolved;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * 获取当前使用的预置线路；当前是自定义地址或环境变量地址时返回 null。
 */
export async function getOnlineServerProfile(): Promise<ServerProfile | null> {
  return matchServerProfile(await getOnlineServerUrl());
}

/**
 * 获取在线对局 WebSocket 地址（与 HTTP 地址同源）。
 * https → wss，http → ws；公网隧道均支持 WebSocket 透传。
 * Web 端空字符串时基于当前页面 host 构建相对 WebSocket 地址（走 Metro 代理）。
 */
export async function getOnlineWsUrl(): Promise<string> {
  const httpUrl = await getOnlineServerUrl();
  if (!httpUrl && Platform.OS === 'web') {
    // Web 端空 base URL，基于当前页面构建 WebSocket 地址
    const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${typeof window !== 'undefined' ? window.location.host : 'localhost'}/api/v1/lan/ws`;
  }
  const wsBase = httpUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  return `${wsBase}/api/v1/lan/ws`;
}

/**
 * 保存自定义服务器地址，并清除"用户已明确选过线路"的标记
 * （改成了预置表以外的地址，线路选择不再适用）。
 */
export async function setOnlineServerUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  cachedUrl = normalized;
  cachedAt = Date.now();
  await enqueueWrite(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, normalized);
    await AsyncStorage.removeItem(CHOICE_KEY);
  });
}

/** 切换到某条预置线路。id 不存在时回退为默认线路（不抛错，避免 UI 因脏数据卡住）。 */
export async function setOnlineServerProfile(id: string): Promise<ServerProfile> {
  const profile = getServerProfile(id) ?? getServerProfile(DEFAULT_SERVER_PROFILE_ID);
  if (!profile) throw new Error('没有可用的服务器线路');
  cachedUrl = profile.url;
  cachedAt = Date.now();
  await enqueueWrite(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, profile.url);
    await AsyncStorage.setItem(CHOICE_KEY, profile.id);
  });
  return profile;
}

/** 恢复默认线路（樱花穿透节点），并清除自定义地址与线路标记 */
export async function resetOnlineServerUrl(): Promise<void> {
  cachedUrl = DEFAULT_SERVER_URL;
  cachedAt = Date.now();
  await enqueueWrite(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    await AsyncStorage.removeItem(CHOICE_KEY);
  });
}

/**
 * 旧版本迁移：仅当用户从未明确选过线路、且落盘地址不是自己填的时候，
 * 把旧版本自动写下的默认地址（Cloudflare）改写为新默认线路（樱花穿透）。
 *
 * 为什么要这一步：旧版本把默认地址硬编码为 Cloudflare，且首次启动就会写盘，
 * 因此所有老用户 AsyncStorage 里都躺着一个"从未主动选择"的 Cloudflare 地址。
 * 不迁移的话，他们升级后仍停在 500ms 的线路上，"默认樱花穿透"对存量用户形同虚设。
 *
 * 三个不覆盖的保护：
 *   - 环境变量指定后端时整体跳过（开发者显式指定，不该被"默认值"覆盖）；
 *   - CHOICE_KEY 存在 = 用户在新版本里明确选过线路，尊重其选择；
 *   - 落盘地址不在预置表内 = 用户自己填的，尊重。
 * 注意不能用"落盘地址是否属于预置表"来判断是否迁移——Cloudflare 同时是旧默认
 * 和新预置线路，必须靠 CHOICE_KEY 才能区分"自动写下的"与"主动选的"。
 *
 * 写入失败也不阻塞：最坏情况是维持旧行为。
 */
export async function migrateLegacyServerUrl(): Promise<void> {
  const fallback = getServerProfile(DEFAULT_SERVER_PROFILE_ID);
  // Web 端默认走 Metro 代理（DEFAULT_SERVER_URL 为 ''），或被环境变量覆盖 —— 都不迁移
  if (!fallback || DEFAULT_SERVER_URL !== fallback.url) return;
  try {
    const [saved, choice] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(CHOICE_KEY),
    ]);
    if (choice) return;                    // 用户已明确选过线路，尊重其选择
    if (!saved) return;                    // 从未设置过，直接用新的内存默认值即可
    if (saved === fallback.url) return;    // 已是新默认，无需改写
    if (!matchServerProfile(saved)) return; // 自定义地址（不在预置表内），不动
    // 到这里：落盘的是另一条预置线路，且用户从未显式选择过
    // —— 只可能是旧版本把当时的默认地址自动写下的，迁移到新的默认线路。
    cachedUrl = fallback.url;
    cachedAt = Date.now();
    await enqueueWrite(() => AsyncStorage.setItem(STORAGE_KEY, fallback.url));
  } catch {
    // 迁移失败不影响启动，静默保持旧地址
  }
}

/**
 * 测试服务器连通性（调用健康检查接口）
 * 返回延迟毫秒数；连接失败或响应异常返回 null
 */
export async function testServerConnection(
  url: string,
  timeoutMs = 5000
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await fetch(`${normalizeServerUrl(url)}/api/v1/health`, {
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.status === 'ok' ? Date.now() - start : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
