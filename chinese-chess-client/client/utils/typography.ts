/**
 * 全局字号字阶（Type Scale）
 *
 * 全应用所有界面文字必须取自本字阶，避免同一角色出现多种字号：
 *   micro    10  角标 / 徽标 / 极小标签（数字角标、状态小标签、棋盘比例角标）
 *   caption  12  说明文字 / 副标题 / 状态芯片 / 表单提示与错误提示
 *   body     14  正文 / 列表主文本 / 按钮文字 / 表单标签 / 卡片标题
 *   control  16  输入框文字与只读值 / 分区标题 / 主按钮 / 大号内容
 *   title    18  页面主标题 / 弹窗标题
 *   display  20  结果标题 / 强调数字
 *   displayLg 24 结算主结果
 *   hero     36  首页品牌标题
 *
 * 另有少量按棋盘尺寸等比缩放的动态字号（棋子/让子/被吃数量角标），
 * 由 ChessBoard、HandicapBoard、endgameEdit 自行按尺寸计算，不纳入本字阶。
 *
 * 倒计时大字属于「数字展示」特例，不参与正文字阶，仅区分全屏揭示与卡片内两种场景。
 */
export const FONT = {
  micro: 10,
  caption: 12,
  body: 14,
  control: 16,
  title: 18,
  display: 20,
  displayLg: 24,
  hero: 36,
  countdown: 80,
  countdownCard: 48,
} as const;

export type FontSize = (typeof FONT)[keyof typeof FONT];
