const { getDefaultConfig } = require('expo/metro-config');
const { createProxyMiddleware } = require('http-proxy-middleware');
const connect = require('connect');
const { withUniwindConfig } = require('uniwind/metro');
const fs = require('fs');
const path = require('path');

const config = getDefaultConfig(__dirname);

/**
 * 开发服务器静态资源修复中间件。
 *
 * 背景：pnpm monorepo 中依赖安装在上层目录，@expo/vector-icons 的字体位于
 * node_modules/.pnpm/@expo+vector-icons@.../ 路径下。该路径里的 "+" 在
 * Metro /assets/ 路由（或经 HTTP 代理转发）按 form-urlencoded 语义二次解码后
 * 会变成空格，导致字体 404、FontAwesome 图标显示为方框。
 *
 * 方案：在请求进入 Metro 资源处理器之前，自行解析 unstable_path 并直接从
 * 磁盘返回文件（decodeURIComponent 不会把 "+" 当空格），绕过该解码问题。
 */
const ASSET_MIME_TYPES = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const MONOREPO_ROOT = path.resolve(__dirname, '..');

function devAssetMiddleware(req, res, next) {
  const rawUrl = req.url || '';
  if (!rawUrl.startsWith('/assets')) return next();

  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return next();
  const match = rawUrl
    .slice(qIndex + 1)
    .match(/(?:^|&)unstable_path=([^&]*)/);
  if (!match) return next();

  let relPath;
  try {
    relPath = decodeURIComponent(match[1]);
  } catch {
    return next();
  }
  if (!relPath) return next();

  const absPath = path.resolve(__dirname, relPath);
  // 仅允许访问 monorepo 内的文件，防止路径穿越
  if (!absPath.startsWith(MONOREPO_ROOT + path.sep)) return next();

  const mime = ASSET_MIME_TYPES[path.extname(absPath).toLowerCase()];
  if (!mime) return next();

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return next();
  }
  if (!stat.isFile()) return next();

  console.log(`[Asset Fix] Serving ${relPath}`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(absPath).pipe(res);
}

// 安全地获取 Expo 的默认排除列表
const existingBlockList = [].concat(config.resolver.blockList || []);

config.resolver.blockList = [
  ...existingBlockList,
  /.*\/\.expo\/.*/, // Expo 的缓存和构建产物目录

  // 1. 原生代码 (Java/C++/Objective-C)
  /.*\/react-native\/ReactAndroid\/.*/,
  /.*\/react-native\/ReactCommon\/.*/,

  // 2. 纯开发和调试工具
  // 这些工具只在开发电脑上运行，不会被打包到应用中
  /.*\/@typescript-eslint\/eslint-plugin\/.*/,

  // 3. 构建时数据
  // 这个数据库只在打包过程中使用，应用运行时不需要
  /.*\/caniuse-lite\/data\/.*/,

  // 4. 通用规则
  /.*\/__tests__\/.*/, // 排除所有测试目录
  /.*\.git\/.*/, // 排除 Git 目录

  // 5. pnpm 临时目录（避免 ENOENT 错误）
  /.*node_modules\/\.pnpm\/.*_tmp_\d+.*/,
];

const DEFAULT_BACKEND_PORT = '9091';
const BACKEND_PORT = process.env.SERVER_PORT || DEFAULT_BACKEND_PORT;
const BACKEND_TARGET = `http://localhost:${BACKEND_PORT}`;

const apiProxy = createProxyMiddleware({
  target: BACKEND_TARGET,
  changeOrigin: true,
  logLevel: 'debug',
  proxyTimeout: 86400000,
  onProxyReq: (proxyReq, req) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/event-stream')) {
      proxyReq.setHeader('accept-encoding', 'identity');
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    const contentType = proxyRes.headers['content-type'] || '';
    if (contentType.includes('text/event-stream') || contentType.includes('application/stream')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders(); } catch {}
      }
    }
  },
});

const streamProxy = createProxyMiddleware({
  target: BACKEND_TARGET,
  changeOrigin: true,
  logLevel: 'debug',
  ws: true,
  proxyTimeout: 86400000,
  onProxyReq: (proxyReq, req) => {
    const upgrade = req.headers.upgrade;
    const accept = req.headers.accept || '';
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      proxyReq.setHeader('Connection', 'upgrade');
      proxyReq.setHeader('Upgrade', req.headers.upgrade);
    } else if (accept.includes('text/event-stream')) {
      proxyReq.setHeader('accept-encoding', 'identity');
      proxyReq.setHeader('Connection', 'keep-alive');
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    const contentType = proxyRes.headers['content-type'] || '';
    if (contentType.includes('text/event-stream') || contentType.includes('application/stream')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders(); } catch {}
      }
    }
  },
});

const shouldProxyToBackend = (url) => {
  if (!url) return false;
  if (/^\/api\/v\d+\//.test(url)) {
    return true;
  }
  return false;
};

const isWebSocketRequest = (req) =>
  !!(req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket');
const isSSERequest = (req) => {
  const accept = req.headers.accept || '';
  return accept.includes('text/event-stream');
};

config.server = {
  ...config.server,
  enhanceMiddleware: (metroMiddleware, metroServer) => {
    return connect()
      .use((req, res, next) => {
        if (shouldProxyToBackend(req.url)) {
          console.log(`[Metro Proxy] Forwarding ${req.method} ${req.url}`);

          if (isWebSocketRequest(req) || isSSERequest(req)) {
            return streamProxy(req, res, next);
          }
          return apiProxy(req, res, next);
        }
        next();
      })
      .use(devAssetMiddleware)
      .use(metroMiddleware);
  },
};

module.exports = withUniwindConfig(config, {
  // relative path to your global.css file
  cssEntryFile: './global.css',
  // (optional) path where we gonna auto-generate typings
  // defaults to project's root
  dtsFile: './uniwind-types.d.ts'
});
