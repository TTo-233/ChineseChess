/**
 * GameNotice 提示条的文字排版工具（纯函数，无 React / RN 依赖，便于单测）
 *
 * 为什么需要它：提示条是「覆盖在棋盘中央、绝对定位、不阻塞落子」的窄条，可用宽度
 * 完全由屏宽决定。而对局内的提示文案里混着两类难排版的内容：
 *   1. 长中文句子：在线 AI 降级原因、规则引擎的长将长捉提示、服务端拒绝原因；
 *   2. **不可断行的 ASCII 片段**：走法 UCI（h2e2）、棋子 id、坐标 (4,5) —— RN 的
 *      Text 只在字符间断行，遇到这类片段会把它整体顶出去，窄屏下直接溢出屏幕。
 * 因此排版规则统一收在这里：中文随处断行、ASCII 片段内部也可断、超出行数用「…」收尾。
 *
 * 长度单位「字位」：全角字符（含中文、全角标点）记 1，半角字符记 0.5，
 * 近似于等宽西文的实际占宽，避免按字符个数估算导致西文行明显偏短。
 * 按码点（`for...of`）而非 `length` 遍历，否则 BMP 外的生僻汉字会被算成两个半角。
 */

/** 半角字符折算的字位（等宽西文约为全角的 1/2）。 */
const HALF_UNITS = 0.5;
/** 浮点比较容差：字位是 0.5 步长的累加，直接比大小会因误差误判换行。 */
const EPS = 1e-6;
/** 单行字位下限：窗口窄到算不出 2 个字时不再继续断行，交给 numberOfLines 兜底裁剪。 */
const MIN_UNITS_PER_LINE = 4;
/** 省略号占 1 个字位（全角）。 */
const ELLIPSIS = '…';

/** 是否按全角计 1 个字位：CJK 汉字、中日韩标点、全角符号。 */
function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首 + 汉字
    (code >= 0xac00 && code <= 0xd7af) || // 谚文
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
    (code >= 0xfe30 && code <= 0xfe4f) || // 中日韩兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII
    (code >= 0xffe0 && code <= 0xffe6) || // 全角符号
    (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B–G（含兼容补充）：都在 BMP 之外，
    // 漏掉会把生僻汉字算成半角，行宽被低估后又顶出屏幕
  );
}

/** 字符串占多少字位（按码点计，避免代理对被算成两个半角）。 */
export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += isWideChar(ch) ? 1 : HALF_UNITS;
  return units;
}

/**
 * 断行：按每行 `maxUnits` 个字位把 text 切成多行，返回值以 `\n` 连接。
 *
 * 规则：
 *   - 原文本里的 `\n` 是硬换行，保留；
 *   - 中文/全角字符随处可断；连续半角片段整体优先不拆，超过一行宽度才在内部拆开
 *     （这正是走法 UCI、坐标溢出屏幕的修法）；
 *   - 行尾空格丢弃（硬换行前若有空格也一并去掉）。
 */
export function wrapNoticeText(text: string, maxUnits: number): string {
  const limit = Math.max(MIN_UNITS_PER_LINE, maxUnits);
  const tokens = tokenize(text, limit);
  const lines: string[] = [];
  let line = '';
  let lineUnits = 0;

  const flush = () => {
    lines.push(line.replace(/\s+$/, ''));
    line = '';
    lineUnits = 0;
  };

  for (const token of tokens) {
    if (token === '\n') {
      flush();
      continue;
    }
    if (token === ' ') {
      // 行首空格直接丢，行尾空格留到 flush 时统一裁掉
      if (lineUnits > 0) {
        line += ' ';
        lineUnits += HALF_UNITS;
      }
      continue;
    }
    const units = textUnits(token);
    if (lineUnits > 0 && lineUnits + units > limit + EPS) flush();
    line += token;
    lineUnits += units;
  }
  flush();

  // 去掉首尾空行（文本本身以 \n 开头/结尾时没有必要占一行），中间的空行保留
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * 断行 + 行数上限：超出 `maxLines` 的部分用「…」收尾（末行按字位回退，不会撑破行宽）。
 * 行数没超时原样返回断行结果。
 *
 * ⚠️ maxLines 必须先夹到 ≥1：调用方给的行宽本身有 MIN_UNITS_PER_LINE 下限，
 *   0 行上限会走 `lines.length <= 0` 分支之外、拼出一条**比行宽还长**的单行
 *   （末行没被拆过，直接加省略号）——正是这里要消灭的溢出。
 */
export function condenseNoticeText(text: string, maxUnits: number, maxLines: number): string {
  const limit = Math.max(MIN_UNITS_PER_LINE, maxUnits);
  const lineBudget = Math.max(1, maxLines);
  const wrapped = wrapNoticeText(text, limit);
  const lines = wrapped.split('\n');
  if (lines.length <= lineBudget) return wrapped;

  const kept = lines.slice(0, lineBudget);
  let last = kept[kept.length - 1].replace(/\s+$/, '');
  // 末行要给省略号腾出 1 个字位，放不下就按码点从尾部退
  while (last.length > 0 && textUnits(last + ELLIPSIS) > limit + EPS) {
    last = Array.from(last).slice(0, -1).join('').replace(/\s+$/, '');
  }
  kept[kept.length - 1] = last + ELLIPSIS;
  return kept.join('\n');
}

/**
 * 丢掉尾部成对的「（…）」技术注解，只保留主句。
 *
 * 提示条的 detail 里常见「走法 h2e2 在当前局面不合法（源 25，落点 (4,5)）」这种
 * 诊断串：括号里的坐标/id 是给 console 看的（aiDispatcher 的 console.warn 仍拿原串），
 * 挤在窄条上既占行又读不出意思，所以展示层先摘掉注解。
 *
 * 必须成对匹配：裸 `lastIndexOf('（')` 会把「未闭合（漏了」这类本身就以「（」结尾的
 * 正常文案截成一截；只认「（」也拦不住 `甲（乙（丙））` 这类嵌套（外层括号里本来
 * 还有内容）。所以先扫出配对的「）」且必须正好落在串尾，否则原样返回。
 * 没有尾部成对括号、或摘完会掏空整句时也原样返回。
 */
export function stripTrailingParenthetical(text: string): string {
  let out = text.trim();
  for (;;) {
    if (out.endsWith('）')) {
      const open = findParentheticalOpen(out, out.length - 1);
      if (open <= 0) break;
      const head = out.slice(0, open).trim().replace(/[，,、：:；;]$/, '');
      if (!head) break;
      out = head;
      continue;
    }
    break;
  }
  return out;
}

/**
 * 找到包住 close（串尾「）」）的那个「（」下标，要求它包住的内容内部括号自洽。
 * 没有自洽配对返回 -1。
 */
function findParentheticalOpen(text: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === '）') depth += 1;
    else if (ch === '（') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * detail 专用：先摘掉尾部技术注解，再断行 + 限行数。
 * 注解摘空时退回原文（宁可多占一行，也不让副标题消失）。
 */
export function buildNoticeDetail(detail: string, maxUnits: number, maxLines: number): string {
  const condensed = stripTrailingParenthetical(detail);
  const source = condensed || detail.trim();
  return condenseNoticeText(source, maxUnits, maxLines);
}

/**
 * 由「内容区宽度 + 字号」算出每行可排多少字位。
 * 向下取整留一点余量：字位是估算值，宁可少排一个字也不要顶出屏幕。
 */
export function noticeUnitsPerLine(contentWidth: number, fontSize: number): number {
  if (!(contentWidth > 0) || !(fontSize > 0)) return MIN_UNITS_PER_LINE;
  return Math.max(MIN_UNITS_PER_LINE, Math.floor(contentWidth / fontSize));
}

/**
 * 切词：把字符串拆成断行单元。
 * - `\n` 与空格单独成 token（交给 wrapNoticeText 处理行内空白）；
 * - 连续半角片段（走法 UCI、坐标、数字）合成一个 token，超宽时按字位切成多块，
 *   保证单个 token 也不会超过一行宽度。
 */
function tokenize(text: string, limit: number): string[] {
  const tokens: string[] = [];
  let asciiRun = '';

  const flushAsciiRun = () => {
    if (!asciiRun) return;
    let chunkUnits = 0;
    let chunk = '';
    for (const ch of asciiRun) {
      const units = isWideChar(ch) ? 1 : HALF_UNITS;
      if (chunk && chunkUnits + units > limit + EPS) {
        tokens.push(chunk);
        chunk = ch;
        chunkUnits = units;
        continue;
      }
      chunk += ch;
      chunkUnits += units;
    }
    if (chunk) tokens.push(chunk);
    asciiRun = '';
  };

  for (const ch of text) {
    if (ch === '\n' || ch === ' ' || ch === '\t') {
      flushAsciiRun();
      tokens.push(ch === '\t' ? ' ' : ch);
      continue;
    }
    if (isWideChar(ch)) {
      flushAsciiRun();
      tokens.push(ch);
      continue;
    }
    asciiRun += ch;
  }
  flushAsciiRun();
  return tokens;
}