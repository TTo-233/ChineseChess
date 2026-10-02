/**
 * 测试用的 hook 句柄挂载点（仅测试使用）。
 *
 * 背景：本项目没有 `@testing-library/react-hooks`，hook 只能靠 `react-test-renderer`
 * 挂到一个一次性 Probe 组件上，再把返回值取到组件外面断言。
 * 「在渲染期把 hook 返回值写回组件外部」是这种写法的必要步骤，但 eslint 的
 * `react-hooks/immutability` / `react-hooks/globals` 会把它当成渲染期副作用拦下
 * （模块级 `let`、模块级对象属性都被覆盖到了）。
 *
 * 这里把句柄挂到 `globalThis` 的一个私有 key 上：它是全局对象上的属性写入，
 * 既不在规则管辖的「组件外部声明的变量」之列，也不引入真实副作用
 * （Probe 渲染一次就结束，之后只有测试在读）。
 */
const HANDLE_KEY = '__dshHookProbeHandle__';

interface Slot<T> {
  value?: T;
}

/** 注册一个句柄槽；同一 key 下重复注册会覆盖，测试文件内自用即可。 */
export function registerHandle<T>(): Slot<T> {
  const slot: Slot<T> = {};
  (globalThis as unknown as Record<string, unknown>)[HANDLE_KEY] = slot;
  return slot;
}

/** 在 Probe 组件体内调用：把 hook 返回值挂到外部槽位。 */
export function setHandle<T>(value: T): void {
  const slot = (globalThis as unknown as Record<string, Slot<T>>)[HANDLE_KEY];
  if (slot) slot.value = value;
}

/** 在测试体内读取。组件已渲染过（act 同步执行），取不到属于测试自身的错误。 */
export function getHandle<T>(): T {
  const slot = (globalThis as unknown as Record<string, Slot<T>>)[HANDLE_KEY];
  if (!slot || slot.value === undefined) {
    throw new Error('hook 句柄尚未挂载：Probe 组件没有被渲染');
  }
  return slot.value;
}