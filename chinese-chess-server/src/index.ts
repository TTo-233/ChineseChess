import express from "express";
import cors from "cors";
import http from "http";
import lanGameRouter from './routes/lanGame';
import aiRouter from './routes/ai';
import { attachBattleWebSocket } from './routes/battleWs';
import { failBody } from './routes/actionOutcome';
import { warmupPikafish } from './services/pikafish';
import { loadOpeningBook } from './services/openingBook';

const app = express();
const port = process.env.PORT || 9091;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/v1/health', (_req, res) => {
  // 【S-? / §3.12】健康检查此前每次请求都 console.log 一行。健康检查由外部探针
  // 高频调用（负载均衡、容器编排、监控），实测会把日志刷满、真正的错误行被淹没。
  // 静默处理：活着就是 200。
  res.status(200).json({ status: 'ok' });
});

// LAN Game routes
app.use('/api/v1/lan', lanGameRouter);

// AI routes（在线皮卡鱼）
app.use('/api/v1/ai', aiRouter);

// API 404 兜底：未知 /api 路径统一返回 JSON（避免落到 Express 默认 HTML 404）
app.use('/api', (req, res) => {
  res.status(404).json(failBody(404, `接口不存在: ${req.method} ${req.path}`));
});

// 全局错误兜底中间件：捕获任何路由抛出的同步/异步错误，统一返回 500 JSON，
// 防止单个请求异常导致进程崩溃、中断全部在线对局。
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // 【第 3 批 / §8 #1】请求体解析失败是**客户端**的错误，不是服务端故障。
  // 此前它落到下面的 500 分支，body 变成 internal_error / 「服务器内部错误」，
  // 而客户端把 status>=500 视为「服务端故障，请重试」——于是一次畸形请求会被
  // 当成服务端问题提示用户重试，监控也会把客户端 bug 记成服务端错误率。
  // 这里只按 body-parser 的错误类型精确降级到 400，其余异常仍走 500。
  const parseFailed = (err as { type?: string } | null)?.type === 'entity.parse.failed';
  if (!res.headersSent) {
    if (parseFailed) {
      res.status(400).json(failBody(400, '请求体不是合法 JSON'));
      return;
    }
    console.error('[Server] 未捕获路由错误:', req.method, req.path, err instanceof Error ? err.message : err);
    res.status(500).json(failBody(500, '服务器内部错误', {}, 'internal_error'));
    return;
  }
  console.error('[Server] 响应已发出后仍抛出错误:', req.method, req.path, err instanceof Error ? err.message : err);
  next(err);
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
