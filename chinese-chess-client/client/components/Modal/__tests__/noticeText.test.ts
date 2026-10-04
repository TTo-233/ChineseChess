/**
 * @/components/Modal/noticeText —— GameNotice 提示条的断行/收尾排版
 *
 * 这里是「窄屏不溢出」的全部逻辑，所以重点钉住三类会静默出错的输入：
 *   1. **不可断行的半角串**：走法 UCI（h2e2）、坐标 (4,5) —— RN 的 Text 只在字符间断行，
 *      整段顶出去就是溢出屏幕。必须允许它内部拆开（真实文案见 aiDispatcher 的 reason）。
 *   2. **行宽是估算值**：字位按全角 1 / 半角 0.5 累加，会出现 12.999999… 这种
 *      刚好比行宽多一丝的串。差一个 ulp 就多断一行，必须按容差判定。
 *   3. **收尾**：超出行数上限时末行要给「…」腾出一个字位，不能把省略号挤到下一行
 *      （那就等于没截断，还会多占一行）。
 */

import {
  buildNoticeDetail,
  condenseNoticeText,
  noticeUnitsPerLine,
  stripTrailingParenthetical,
  textUnits,
  wrapNoticeText,
} from '@/components/Modal/noticeText';

/** 每行的最长行宽（含全角/半角混合），用于断言「没有任何一行超宽」 */
function assertNoLineExceeds(text: string, maxUnits: number) {
  for (const line of text.split('\n')) {
    expect(textUnits(line)).toBeLessThanOrEqual(maxUnits + 1e-6);
  }
}

describe('noticeText · 字位折算', () => {
  test('全角 1、半角 0.5', () => {
    expect(textUnits('中文')).toBe(2);
    expect(textUnits('abcd')).toBe(2);
    expect(textUnits('走法 h2e2')).toBe(2 + 0.5 + 2); // '走法'2 + 空格0.5 + 'h2e2'2
    expect(textUnits('走法 b2e2 在当前局面不合法')).toBe(2 + 0.5 + 2 + 0.5 + 8);
  });

  test('代理对按一个码点算（不会把 BMP 外的汉字算成两个半角）', () => {
    // U+20000 CJK 扩展 B 的汉字：for...of 按码点迭代，只应记 1 个字位
    expect(textUnits('\u{20000}')).toBe(1);
  });

  test('宽度或字号非正数时退回单行下限，不返回 0/NaN', () => {
    expect(noticeUnitsPerLine(0, 16)).toBe(4);
    expect(noticeUnitsPerLine(300, 0)).toBe(4);
    expect(noticeUnitsPerLine(320, 16)).toBe(20); // floor(320/16)
  });
});

describe('noticeText · 断行', () => {
  test('中文逐字断行，任何一行都不超过行宽', () => {
    const out = wrapNoticeText('在线走法与本地局面不同步，已改用本地AI', 10);
    expect(out).toBe('在线走法与本地局面不\n同步，已改用本地AI');
    assertNoLineExceeds(out, 10);
  });

  test('短文本原样返回，不多余换行', () => {
    expect(wrapNoticeText('将军', 10)).toBe('将军');
    expect(wrapNoticeText('', 10)).toBe('');
  });

  test('硬换行保留', () => {
    expect(wrapNoticeText('甲\n乙', 10)).toBe('甲\n乙');
  });

  test('前后空行被丢掉，中间的空行保留', () => {
    expect(wrapNoticeText('\n\n\n甲\n\n乙\n\n', 10)).toBe('甲\n\n乙');
  });

  test('半角片段整体不拆（未超宽时）', () => {
    // 每行 20 字位：「(4,5)」只有 2.5 字位，必须留在同一行
    expect(wrapNoticeText('走法不合法 (4,5) 请变招', 20)).toBe('走法不合法 (4,5) 请变招');
  });

  test('半角片段超宽时允许内部拆开 —— 这是 UCI 溢出的修法', () => {
    // 真实文案：aiDispatcher 的 OnlineAiInvalidMoveError.reason
    const raw = '走法 b2e2 在当前局面不合法（源 25，落点 (4,5)）';
    const out = wrapNoticeText(raw, 12);
    assertNoLineExceeds(out, 12);
    // 拆行后去掉换行符，内容必须一字不差（不能吞字符）
    expect(out.replace(/\n/g, '')).toBe(raw);
  });

  test('浮点累加误差不会把 8 个半角字符判成超宽', () => {
    // 8 个半角 = 4.0 字位（0.5 累加），行宽 4 —— 若无容差会误断成两行
    const out = wrapNoticeText('12345678', 4);
    expect(out).toBe('12345678');
  });

  test('行宽过窄时不无限拆（退到下限 4 字位）', () => {
    const out = wrapNoticeText('abcdefghijklmnop', 1);
    assertNoLineExceeds(out, 4);
  });
});

describe('noticeText · 行数上限与省略号', () => {
  test('不超行数时原样返回断行结果', () => {
    expect(condenseNoticeText('中文中文', 4, 3)).toBe('中文中文');
  });

  test('超行数时截断并加省略号，且末行不超宽', () => {
    const raw = '在线走法与本地局面不同步，已改用本地AI走法异常，请尽快变招';
    const out = condenseNoticeText(raw, 8, 2);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(out.endsWith('…')).toBe(true);
    assertNoLineExceeds(out, 8);
    // 首行整行保留 8 字，末行给「…」腾 1 个字位 → 原文前 8+7 = 15 字原样保留
    expect(out.replace(/\n/g, '').replace('…', '')).toBe(raw.slice(0, 15));
  });

  test('末行放不下省略号时逐字退让，而不是撑破行宽', () => {
    // 「一二三四」正好占满 4 字位，加「…」会超宽 → 退到「一二三…」
    expect(condenseNoticeText('一二三四五', 4, 1)).toBe('一二三…');
    assertNoLineExceeds(condenseNoticeText('一二三四五', 4, 1), 4);
  });

  test('maxLines <= 0 时至少保留 1 行（不会返回空串或未截断的长行）', () => {
    // 行宽 4 会把 8 字排成 2 行；行数上限 0 若不夹到 1，就会拼出一条 8 字宽的单行——正是要消灭的溢出
    const out = condenseNoticeText('一二三四五六七八', 4, 0);
    expect(out).toBe('一二三…');
    assertNoLineExceeds(out, 4);
  });
});

describe('noticeText · detail 摘注解', () => {
  test('摘掉尾部成对括号里的坐标注解', () => {
    expect(stripTrailingParenthetical('走法 b2e2 在当前局面不合法（源 25，落点 (4,5)）')).toBe(
      '走法 b2e2 在当前局面不合法'
    );
  });

  test('摘完括号后清掉尾部的逗号', () => {
    expect(stripTrailingParenthetical('起点无活子，服务端返回别的着法（走法 h2e2）')).toBe(
      '起点无活子，服务端返回别的着法'
    );
  });

  test('多层括号从内向外逐层摘', () => {
    expect(stripTrailingParenthetical('甲（乙（丙））')).toBe('甲');
  });

  test('括号未闭合 / 无括号时原样返回', () => {
    expect(stripTrailingParenthetical('请检查网络后返回')).toBe('请检查网络后返回');
    expect(stripTrailingParenthetical('未闭合（漏了')).toBe('未闭合（漏了');
  });

  test('只有括号内容时退回原文（副标题不许凭空消失）', () => {
    expect(stripTrailingParenthetical('（只是一段注解）')).toBe('（只是一段注解）');
  });

  test('buildNoticeDetail = 摘注解 + 断行 + 限行数', () => {
    // 真实 detail：aiDispatcher 在线走法不合法
    const out = buildNoticeDetail(
      '走法 b2e2 在当前局面不合法（源 25，落点 (4,5)）',
      12,
      2
    );
    // 摘注解后 13 字位：首行「走法 b2e2 在当前局面不合」= 2+0.5+2+0.5+7 = 12，末行「法」
    expect(out).toBe('走法 b2e2 在当前局面不合\n法');
    assertNoLineExceeds(out, 12);
  });

  test('detail 截断时保留原文前缀（含半角片段），不丢字符', () => {
    // 真实场景：detail 超出行数上限，末行要给「…」腾位
    const raw = '走法 b2e2 不合法请改用本地AI';
    const out = buildNoticeDetail(raw, 12, 1);
    expect(out.endsWith('…')).toBe(true);
    assertNoLineExceeds(out, 12);
    // 截断只允许丢尾部，且丢掉的正是被省略号顶掉的部分
    const kept = out.replace('…', '').replace(/\n/g, '');
    expect(raw.startsWith(kept)).toBe(true);
    expect(kept.length).toBeLessThan(raw.length);
  });
});