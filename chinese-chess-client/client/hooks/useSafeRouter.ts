/**
 * 安全路由 Hook - 完全代替原生的 useRouter 和 useLocalSearchParams
 *
 * 提供的 Hook：
 * - useSafeRouter: 代替 useRouter，包含所有路由方法，并对 push/replace/navigate/setParams 进行安全编码
 * - useSafeSearchParams: 代替 useLocalSearchParams，获取路由参数
 *
 * 解决的问题：
 * 1. URI 编解码不对称 - useLocalSearchParams 会自动解码，但 router.push 不会自动编码，
 *    当参数包含 % 等特殊字符时会拿到错误的值
 * 2. 类型丢失 - URL 参数全是 string，Number/Boolean 类型会丢失
 * 3. 嵌套对象无法传递 - URL search params 不支持嵌套结构
 *
 * 解决方案：
 * 采用 Payload 模式，将所有参数打包成 JSON 并 Base64 编码后传递，
 * 接收时再解码还原，确保数据完整性和类型安全。
 *
 * 优点：
 * 1. 自动处理所有特殊字符（如 %、&、=、中文、Emoji 等）
 * 2. 保留数据类型（Number、Boolean 不会变成 String）
 * 3. 支持嵌套对象和数组传递
 * 4. 三端兼容（iOS、Android、Web）
 *
 * 使用方式：
 * ```tsx
 * // 发送端 - 使用 useSafeRouter 代替 useRouter
 * const router = useSafeRouter();
 * router.push('/detail', { id: 123, uri: 'file:///path/%40test.mp3' });
 * router.replace('/home', { tab: 'settings' });
 * router.navigate('/profile', { userId: 456 });
 * router.back();
 * if (router.canGoBack()) { ... }
 * router.setParams({ updated: true });
 *
 * // 接收端 - 使用 useSafeSearchParams 代替 useLocalSearchParams
 * const { id, uri } = useSafeSearchParams<{ id: number; uri: string }>();
 * ```
 */
import { useMemo } from 'react';
import { useRouter as useExpoRouter, useLocalSearchParams as useExpoParams } from 'expo-router';
import { Base64 } from 'js-base64';

const PAYLOAD_KEY = '__safeRouterPayload__';
const LOG_PREFIX = '[SafeRouter]';


const getCurrentParams = (rawParams: Record<string, string | string[]>): Record<string, unknown> => {
  const payload = rawParams[PAYLOAD_KEY];
  if (payload && typeof payload === 'string') {
    const decoded = deserializeParams<Record<string, unknown>>(payload);
    if (decoded && Object.keys(decoded).length > 0) {
      return decoded;
    }
  }
  const { [PAYLOAD_KEY]: _, ...rest } = rawParams;
  return rest as Record<string, unknown>;
};

const serializeParams = (params: Record<string, unknown>): string => {
  try {
    const jsonStr = JSON.stringify(params);
    // 【C-24 / §6.1】Base64.encode 产出的是标准字母表，会把 JSON 里的 '/' 转成 '/'、
    // '+' 转成 '+'、结尾还会补 '='。这些字符没有做 URL 安全处理：'/' 会把一个参数值
    // 切成两段路径，'+' 在部分反序列化器里被当空格解码，'=' 会截断 query。
    // 结果是「进对局页参数全丢」（读不到 payload 就退化成空参）。
    // encodeURI 是 js-base64 自带的 URL 安全变体：把 '+'→'-'、'/'→'_'，并去掉 '=' 填充。
    // 解码侧用 Base64.decode 即可 —— 它的实现先尝试 URL 安全字母表再回退标准字母表，
    // 因此对历史已生成的标准 base64 链接仍然兼容。
    return Base64.encodeURI(jsonStr);
  } catch (error) {
    console.error(LOG_PREFIX, 'serialize failed:', error instanceof Error ? error.message : 'Unknown error');
    return '';
  }
};

const deserializeParams = <T = Record<string, unknown>>(
  payload: string | string[] | undefined
): T | null => {
  if (!payload || typeof payload !== 'string') {
    return null;
  }
  try {
    const jsonStr = Base64.decode(payload);
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    console.error(LOG_PREFIX, 'deserialize failed:', error instanceof Error ? error.message : 'Unknown error');
    return null;
  }
};


/**
 * 安全路由 Hook，用于页面跳转，代替 useRouter
 * @returns 路由方法（继承 useRouter 所有方法，并对以下方法进行安全编码）
 * - push(pathname, params) - 入栈新页面
 * - replace(pathname, params) - 替换当前页面
 * - navigate(pathname, params) - 智能跳转（已存在则返回，否则 push）
 * - setParams(params) - 更新当前页面参数（合并现有参数）
 */
export function useSafeRouter() {
  const router = useExpoRouter();
  const rawParams = useExpoParams<Record<string, string | string[]>>();

  const push = (pathname: string, params: Record<string, unknown> = {}) => {
    const encodedPayload = serializeParams(params);
    router.push({
      pathname: pathname as `/${string}`,
      params: { [PAYLOAD_KEY]: encodedPayload },
    });
  };

  const replace = (pathname: string, params: Record<string, unknown> = {}) => {
    const encodedPayload = serializeParams(params);
    router.replace({
      pathname: pathname as `/${string}`,
      params: { [PAYLOAD_KEY]: encodedPayload },
    });
  };

  const navigate = (pathname: string, params: Record<string, unknown> = {}) => {
    const encodedPayload = serializeParams(params);
    router.navigate({
      pathname: pathname as `/${string}`,
      params: { [PAYLOAD_KEY]: encodedPayload },
    });
  };

  const setParams = (params: Record<string, unknown>) => {
    const currentParams = getCurrentParams(rawParams);
    const mergedParams = { ...currentParams, ...params };
    const encodedPayload = serializeParams(mergedParams);
    router.setParams({ [PAYLOAD_KEY]: encodedPayload });
  };

  return {
    ...router,
    push,
    replace,
    navigate,
    setParams,
  };
}

/**
 * 安全获取路由参数 Hook，用于接收方，代替 useLocalSearchParams
 * 兼容两种跳转方式：
 * 1. useSafeRouter 跳转 - 自动解码 Payload
 * 2. 外部跳转（深链接、浏览器直接访问等）- 回退到原始参数
 * @returns 解码后的参数对象，类型安全
 */
export function useSafeSearchParams<T = Record<string, unknown>>(): T {
  const rawParams = useExpoParams<Record<string, string | string[]>>();

  const decodedParams = useMemo(() => {
    return getCurrentParams(rawParams) as T;
  }, [rawParams]);

  return decodedParams;
}
