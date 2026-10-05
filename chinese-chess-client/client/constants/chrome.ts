/**
 * 页面框架 Design Tokens（顶栏 / 返回按钮）
 *
 * 与 `constants/modal.ts`（浮层 token）同源同一套思路：**同样的东西只能有一处定义**。
 * 改造前项目里同时存在 3 档标题栏高度（64 / 60 / 56）、4 个各自命名的 40×40 返回按钮
 * 样式（`backBtn` / `backButton` / `backButtonInner` / `headerButton`），以及一张
 * 唯独漏掉 `borderBottom` 的标题栏——这类"散落的几何常量"正是视觉不一致的根源，
 * 也无法在改版时一次性同步。
 *
 * 注意：本文件只收敛「几何」——高度、内边距、返回按钮尺寸。配色仍归各屏自己的
 * `COLORS`（各屏色板命名不同：`card` / `bgCard`，值本身相同 `#FFF8F0`），
 * 字号字阶仍以 `@/utils/typography` 的 `FONT` 为唯一来源。
 */

/**
 * 标题栏垂直内边距（上下各留这么多），所有带标题栏的页面共用。
 *
 * 取 8 而非原先的 10 / 12：标题栏内容是固定 40px 的返回按钮，
 * 垂直内边距只决定标题栏"比按钮高多少"（40 + 8×2 = **56**）。
 * 复盘列表页原本就是 56，改成统一值后各屏零感知差异地对齐到它。
 */
export const TITLE_BAR_PADDING_VERTICAL = 8;

/** 标题栏水平内边距（左右各留这么多）。 */
export const TITLE_BAR_PADDING_HORIZONTAL = 16;

/**
 * 返回按钮尺寸（宽高同值），所有带标题栏的页面共用。
 *
 * 标题栏高度由它推出：`TITLE_BAR_PADDING_VERTICAL × 2 + 本值` = 56。
 * 若要整体调整标题栏高度，改 `TITLE_BAR_PADDING_VERTICAL` 即可，勿单独改按钮尺寸。
 */
export const BACK_BUTTON_SIZE = 40;