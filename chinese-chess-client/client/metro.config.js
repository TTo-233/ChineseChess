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
  // 本地引擎产物（assets/engines）：自包含的 classic Worker 与离线 HTML 页。
  // 各约 6MB（内联了 WASM + 4MB NNUE 的 base64），**不能**走源码转译，
  // 否则 base64 会被 Babel 逐字符处理，启动极慢且内存峰值高；必须原样透传。
  '.wasm': 'application/wasm',
  '.nnue': 'application/octet-stream',
  // 引擎离线页。⚠️ 扩展名是 .page 而不是 .html：这些产物会被 Metro 打进
  // Android 的 res/raw/，AAPT 以「去扩展名的路径」作资源名，
  // 同目录下 pikafish.html 与 pikafish.wasm 会撞名 → Duplicate resources，
  // 构建在 mergeReleaseResources 失败（实测过）。
  '.page': 'text/html; charset=utf-8',
  // .bin = 引擎 worker 脚本。经典 Worker 由浏览器按 URL 直接执行，不依赖 MIME，
  // 这里给一个明确类型避免部分服务器返回 text/plain 之外的怪值。
  '.bin': 'text/javascript',
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

  /**
   * 缓存策略：no-cache（= 每次带 ETag 重新校验，不是"不缓存"）。
   *
   * 这里原本是 `no-store`，而它会强制浏览器**每次都重新下载整个文件**。
   * 本地引擎产物有 4~6MB，于是每次刷新页面都要重传一遍——这也是"首次启动慢"
   * 的直接原因之一（实测 6.06MB 在本地 dev server 上要 ~3.6s）。
   *
   * 改成 no-cache + ETag 后：
   *   · 内容没变 → 304，只走几百字节的头部，重载几乎瞬时；
   *   · 重新生成了产物（mtime/size 变化）→ ETag 变化 → 自动取新版，开发时不失真。
   * 之所以不用 max-age 长缓存：这些产物在开发期会随 gen:pikafish-host 重新生成，
   * 强缓存会让开发者看到旧引擎且难以察觉。
   */
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(absPath).pipe(res);
}

// 安全地获取 Expo 的默认排除列表
const existingBlockList = [].concat(config.resolver.blockList || []);

/**
 * 【本地引擎产物：必须原样透传，绝不能进转译管线】
 *
 * assets/engines 下的文件（worker 脚本 + 离线页 + wasm + nnue）：
 *   · pikafish.worker.bin —— classic Worker 脚本
 *   · pikafish.page        —— 原生端离线引擎页
 *   · jieqi.worker.bin / jieqi.page / jieqi.wasm
 *   · pikafish.wasm / pikafish.nnue
 *
 * 做法是**用非源码扩展名**并把它们登记进 assetExts：
 *   Metro 只转译 sourceExts 里的扩展名，assetExts 里的文件按原字节作为静态资源提供。
 * 因此那些巨型 base64 不会被 Babel/JSX 管线逐字符处理——
 * 否则启动会慢到数十秒、内存峰值数百 MB，而且**没有任何报错**。
 *
 * ⚠️ 扩展名必须**各自唯一**（2026-10 Android 构建阻塞修复）：
 *   这些产物会被 Metro 打进 Android 的 `res/raw/`，而 AAPT 生成资源名的规则是
 *   「**去掉最后一个扩展名**的完整路径」。于是若两个产物只差扩展名
 *   （`pikafish.wasm` 与 `pikafish.html`），它们会压成同一个
 *   `raw/assets_engines_pikafish` → `Duplicate resources`，
 *   构建在 :app:mergeReleaseResources 失败（实测：Run gradlew 报错）。
 *   现用 .bin / .page / .wasm / .nnue 四种互不相同的扩展名规避。
 *
 * 注意：worker 脚本用 .bin 后缀不影响 `new Worker(url)`：它只当作 URL，
 * 浏览器不关心扩展名。⚠️ 切勿改用 blockList —— 那会让文件**无法被 require 解析**
 * （blockList 的语义是"从模块图里删掉"，不是"跳过转译"），导致 require 直接失败。
 */
config.resolver.assetExts = [].concat(config.resolver.assetExts || [], [
  'wasm',
  'nnue',
  'bin', // 引擎 worker 脚本（内容是 JS，但必须按资源原样透传）
  'page', // 引擎离线页（原生 WebView 承载；见上方 AAPT 资源名冲突说明）
]);


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
