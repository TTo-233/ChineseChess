import express from "express";
import cors from "cors";
import http from "http";
import lanGameRouter from './routes/lanGame';
import aiRouter from './routes/ai';
import { attachBattleWebSocket } from './routes/battleWs';
import { warmupPikafish } from './services/pikafish';
import { loadOpeningBook } from './services/openingBook';

const app = express();
const port = process.env.PORT || 9091;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/v1/health', (req, res) => {
  console.log('Health check success');
  res.status(200).json({ status: 'ok' });
});

// LAN Game routes
app.use('/api/v1/lan', lanGameRouter);

// AI routes（在线皮卡鱼）
app.use('/api/v1/ai', aiRouter);

// API 404 兜底：未知 /api 路径统一返回 JSON（避免落到 Express 默认 HTML 404）
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'not_found', message: `接口不存在: ${req.method} ${req.path}` });
});

// 全局错误兜底中间件：捕获任何路由抛出的同步/异步错误，统一返回 500 JSON，
// 防止单个请求异常导致进程崩溃、中断全部在线对局。
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Server] 未捕获路由错误:', req.method, req.path, err instanceof Error ? err.message : err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ success: false, error: 'internal_error', message: '服务器内部错误' });
});

// 使用 http.Server 承载 Express，便于在同一端口挂载 WebSocket（在线对局实时通道）
const server = http.createServer(app);
attachBattleWebSocket(server);

// 进程级异常守卫：未处理的 Promise 拒绝/未捕获异常仅记录，不让进程退出，
// 保障在线对局服务持续可用（避免因单点异常导致全服中断）。
process.on('unhandledRejection', (reason) => {
  console.error('[Server] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] uncaughtException:', err?.message || err);
});

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}/`);
  // 加载开局库（同步，失败不影响主流程）
  loadOpeningBook();
  // 预热皮卡鱼引擎（后台异步，不阻塞启动）
  warmupPikafish();
});
