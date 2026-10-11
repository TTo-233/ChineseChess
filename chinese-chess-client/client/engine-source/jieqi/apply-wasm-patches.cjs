#!/usr/bin/env node
/**
 * 为 jieqi_old 应用「WASM 单线程适配」补丁。
 *
 *   node apply-wasm-patches.cjs <源码目录>
 *
 * 为什么不直接用 .patch：
 *   上游源码是 CRLF，diff 对行尾极敏感（实测 git apply 全部 CHECK FAILED）。
 *   故本脚本用「锚点字符串 + 正则」做幂等替换，跨行尾稳定、可重复执行。
 *
 * 幂等：已打过补丁的文件再跑一次不会重复插入。
 */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '..', '..', '..', '..', '_tmp', 'pf', 'src');

function read(f) { return fs.readFileSync(path.join(SRC, f), 'utf8'); }
function write(f, s) { fs.writeFileSync(path.join(SRC, f), s, 'utf8'); }
function done(f, what) { console.log(`  [ok] ${f.padEnd(22)} ${what}`); }

// 统一的守卫宏：原生构建不受影响
const GUARD_OPEN = '#if defined(__EMSCRIPTEN__) && !defined(USE_PTHREADS)';
const GUARD_CLOSE = '#endif';

let changed = 0;

/* ------------------------------------------------------------------ *
 * 1. thread_win32_osx.h —— NativeThread 空实现
 *    原始：#else 分支里 typedef std::thread NativeThread;
 * ------------------------------------------------------------------ */
{
  const f = 'thread_win32_osx.h';
  let s = read(f);
  if (s.includes('WASM_SINGLE_THREAD')) { console.log(`  [skip] ${f} 已适配`); }
  else {
    const anchor = '#else // Default case: use STL classes';
    if (!s.includes(anchor)) throw new Error(`${f}: 找不到锚点`);
    const branch =
`${GUARD_OPEN}
// ---------------------------------------------------------------------------
// WASM 单线程适配（由 apply-wasm-patches.cjs 注入）
//
// Emscripten 单线程构建（无 -pthread）下 std::thread 构造会直接 abort()，
// 而 Thread::Thread() 在构造时即创建 NativeThread，导致 main() 早期崩溃。
// 这里提供**不创建真实线程**的空实现：搜索改由 start_searching() 同步执行。
// ---------------------------------------------------------------------------
namespace Stockfish {
class NativeThread {
public:
  template <class T, class F>
  explicit NativeThread(F fun, T* obj) { (void)fun; (void)obj; }
  void join() { }
};
} // namespace Stockfish

${GUARD_CLOSE}

`;
    // 注意：原文件是 #else 开头，我们要插在它**之前**，形成 #elif 分支
    s = s.replace('#else // Default case: use STL classes',
      branch + anchor.replace('#else', '#else // Default case: use STL classes'));
    write(f, s);
    changed++;
    done(f, 'NativeThread 空实现');
  }
}

/* ------------------------------------------------------------------ *
 * 2. thread.cpp
 *    a) wait_for_search_finished：单线程直接返回（否则死锁）
 *    b) start_searching：单线程**同步执行 search()**
 * ------------------------------------------------------------------ */
{
  const f = 'thread.cpp';
  let s = read(f);
  if (s.includes('WASM_SINGLE_THREAD')) { console.log(`  [skip] ${f} 已适配`); }
  else {
    // (a) wait_for_search_finished
    const waitRe = /(void Thread::wait_for_search_finished\(\)\s*\{)([\s\S]*?)(\r?\n\})/;
    if (!waitRe.test(s)) throw new Error(`${f}: 找不到 wait_for_search_finished`);
    s = s.replace(waitRe, (m, head, body, tail) =>
      head + `\r\n\r\n${GUARD_OPEN}\r\n  // WASM 单线程：无 idle_loop 线程会把 searching 置 false，等待会永久死锁。\r\n  return;\r\n${GUARD_CLOSE}` + body + tail
    );

    // (b) start_searching
    const startAnchor = 'void Thread::start_searching() {';
    if (!s.includes(startAnchor)) throw new Error(`${f}: 找不到 start_searching`);
    s = s.replace(startAnchor, startAnchor + `

${GUARD_OPEN}
  // WASM 单线程：没有 idle_loop 线程会执行 search()，故在此**同步**跑完。
  // 本引擎在 Worker 中运行，阻塞可接受（与象棋 WASM 的同步语义一致）。
  {
    std::lock_guard<std::mutex> lk(mutex);
    searching = true;
  }
  search();
  {
    std::lock_guard<std::mutex> lk(mutex);
    searching = false;
  }
  return;
${GUARD_CLOSE}`);

    write(f, s);
    changed++;
    done(f, 'wait/search 单线程短路');
  }
}

/* ------------------------------------------------------------------ *
 * 3. thread.h —— searching 初值
 * ------------------------------------------------------------------ */
{
  const f = 'thread.h';
  let s = read(f);
  if (s.includes('WASM_SINGLE_THREAD')) { console.log(`  [skip] ${f} 已适配`); }
  else {
    const re = /bool exit = false,\s*searching = true;\s*\/\/ Set before starting std::thread/;
    if (!re.test(s)) throw new Error(`${f}: 找不到 searching 声明`);
    // ⚠️ 必须用 #if/#else 让**整条声明**二选一 ——
    //    在成员声明列表中间插赋值语句是非法 C++（实测 "duplicate member 'searching'"）。
    s = s.replace(re,
      `  ${GUARD_OPEN}\r\n` +
      '  bool exit = false, searching = false; // 单线程：无 idle_loop，析构 assert(!searching) 才成立\r\n' +
      '  #else\r\n' +
      '  bool exit = false, searching = true; // Set before starting std::thread\r\n' +
      `  ${GUARD_CLOSE}`
    );
    write(f, s);
    changed++;
    done(f, 'searching 初值');
  }
}

/* ------------------------------------------------------------------ *
 * 4. tt.cpp —— TT::clear() 不用 std::thread
 * ------------------------------------------------------------------ */
{
  const f = 'tt.cpp';
  let s = read(f);
  if (s.includes('WASM_SINGLE_THREAD')) { console.log(`  [skip] ${f} 已适配`); }
  else {
    const anchor = /void TranspositionTable::clear\(\)\s*\{/;
    if (!anchor.test(s)) throw new Error(`${f}: 找不到 TT::clear`);
    const startIdx = s.search(anchor);
    const bodyStart = s.indexOf('{', startIdx) + 1;
    let depth = 1, i = bodyStart;
    while (i < s.length && depth > 0) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      i++;
    }
    const endIdx = i - 1;
    s = s.slice(0, bodyStart) + `\r\n\r\n${GUARD_OPEN}\r\n` +
         '  // WASM 单线程：不能创建 std::thread（会 abort）。直接同步清零整表。\r\n' +
         '  if (table && clusterCount)\r\n' +
         '      std::memset(table, 0, clusterCount * sizeof(Cluster));\r\n' +
         `  return;\r\n${GUARD_CLOSE}\r\n` +
         s.slice(bodyStart + 1, endIdx) + '\r\n' + s.slice(endIdx);
    write(f, s);
    changed++;
    done(f, 'TT::clear 同步 memset');
  }
}

// 打标记，便于幂等判断。
// ⚠️ 标记必须放在**独立的一行注释**里 —— 若与 `#if` 同行，预处理指令不在行首，
//    会被当作普通文本忽略，导致 "#endif without #if"（实测踩过）。
for (const f of ['thread_win32_osx.h', 'thread.cpp', 'thread.h', 'tt.cpp']) {
  const p = path.join(SRC, f);
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes('WASM_SINGLE_THREAD')) {
    s = s.replace(GUARD_OPEN, `/* WASM_SINGLE_THREAD */\r\n${GUARD_OPEN}`);
    fs.writeFileSync(p, s, 'utf8');
  }
}

console.log(`\n完成：${changed} 个文件已适配（幂等标记 WASM_SINGLE_THREAD 已写入）`);
