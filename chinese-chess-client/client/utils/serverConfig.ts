/**
 * 互联网对战服务器配置
 *
 * 用户在自己的电脑上运行服务端（server 目录），并通过 Cloudflare Tunnel（命名隧道）
 * 将本地端口映射为绑定域名的公网 HTTPS 地址（证书由 Cloudflare 签发、受系统信任），
 * 在大厅"服务器设置"中填入该地址。地址持久化在 AsyncStorage，未设置时使用默认后端地址。
 *
 * Web 平台说明：开发时 Metro Bundler 配置了代理，会将 /api/v1/* 转发到后端。
 * 因此在 Web 端应使用相对路径（空字符串），让请求走 Metro 代理，
 * 避免浏览器 CORS 限制和 localhost 不可达问题。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const STORAGE_KEY = 'online_server_url';

/**
 * 默认服务器地址（未自定义时使用）。
 * Cloudflare Tunnel 对外仅提供 HTTPS（80/443 之外 HTTP 会被重定向），因此默认使用 https 协议。
 * Web 端开发时返回空字符串，使用相对路径走 Metro 代理。
 */
export const DEFAULT_SERVER_URL = (() => {
  if (Platform.OS === 'web') return '';
  return process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'https://chess.ttocnserver.dpdns.org';
})();

// 内存缓存，避免每次请求都读 AsyncStorage
let cachedUrl: string | null = null;

/** 提取主机名（去除协议、端口、路径），用于判断地址类型 */
function extractHost(url: string): string {
  let host = url.replace(/^https?:\/\//i, '');
  host = host.split('/')[0];
  host = host.split(':')[0];
  return host.toLowerCase();
}

/**
 * 判断是否为公网域名（非 IP、非 localhost）。
 * Cloudflare Tunnel 等公网隧道仅提供 HTTPS，因此公网域名需用 https；
 * 内网 IP / localhost 仍可用 http。
 */
function isPublicHost(url: string): boolean {
  const host = extractHost(url);
  if (!host || host === 'localhost') return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false; // IPv4
  if (host.includes(':')) return false; // IPv6
  return host.includes('.'); // 含点号视为公网域名
}

/** 规范化服务器地址：补全协议、去除尾部斜杠；公网域名强制 https（Cloudflare 等隧道仅支持 HTTPS） */
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  // Web 端允许空字符串（走 Metro 代理的相对路径）
  if (!url) return Platform.OS === 'web' ? '' : DEFAULT_SERVER_URL;
  if (!/^https?:\/\//i.test(url)) {
    // 未指定协议：公网域名默认 https，内网 IP / localhost 默认 http
    url = `${isPublicHost(url) ? 'https' : 'http'}://${url}`;
  } else if (/^http:\/\//i.test(url) && isPublicHost(url)) {
    // 已显式使用 http:// 但目标是公网域名：Cloudflare 等隧道仅支持 HTTPS，自动升级为 https
    url = url.replace(/^http:\/\//i, 'https://');
  }
  return url.replace(/\/+$/, '');
}

/** 获取当前对战服务器地址（优先用户自定义，其次默认地址） */
export async function getOnlineServerUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;
  let resolved = DEFAULT_SERVER_URL;
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved) resolved = normalizeServerUrl(saved);
  } catch {
    // 读取失败时使用默认地址
  }
  cachedUrl = resolved;
  return resolved;
}

/**
 * 获取在线对局 WebSocket 地址（与 HTTP 地址同源）。
 * https → wss，http → ws；Cloudflare Tunnel 支持 WebSocket 透传。
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

/** 保存自定义服务器地址 */
export async function setOnlineServerUrl(url: string): Promise<void> {
  const normalized = normalizeServerUrl(url);
  cachedUrl = normalized;
  await AsyncStorage.setItem(STORAGE_KEY, normalized);
}

/** 恢复默认服务器地址 */
export async function resetOnlineServerUrl(): Promise<void> {
  cachedUrl = DEFAULT_SERVER_URL;
  await AsyncStorage.removeItem(STORAGE_KEY);
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
