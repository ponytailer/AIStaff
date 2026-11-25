import type { SceneModule } from './types';

/**
 * 唯一的类型保障点。
 *
 * TS 无法静态推导 `import.meta.glob` 的动态导出类型 —— glob 的返回是
 * `Record<string, () => Promise<unknown>>`，每个模块导出的东西在类型系统里完全不可见。
 * 所以强制每个模块用本函数包一层：写错字段名 / 忘了 meta，在这个调用点就报错，
 * 而不是等到运行期白屏。
 *
 * 为什么 `meta` 七项都要在运行期再查一遍（类型已经保证了）：module 是**动态 import**
 * 进来的，灰度期间可能出现「新 module 用旧 TS 编译产物」的组合（CI 缓存、子包复用），
 * 那时类型检查已经跑完了。DEV 期抛错，生产期只 warn —— 生产期抛错会让整个 chunk
 * 加载失败，一块 UI 崩掉不能顺带把整条消息带走。
 */
export function defineSceneModule(module: SceneModule): SceneModule {
  const { meta } = module;
  const missing: string[] = [];
  if (!meta?.module_key) missing.push('module_key');
  if (!meta?.module_version) missing.push('module_version');
  if (!meta?.supported_scene_types?.length) missing.push('supported_scene_types');
  if (!meta?.summary) missing.push('summary');
  if (!meta?.required_slots) missing.push('required_slots');
  if (!meta?.params_schema) missing.push('params_schema');
  if (!meta?.entry_behavior) missing.push('entry_behavior');
  if (missing.length > 0) {
    const message = `[scene] module meta 缺字段: ${missing.join(', ')}`;
    if (import.meta.env.DEV) throw new Error(message);
    console.warn(message);
  }

  if (import.meta.env.DEV && meta?.module_key) {
    checkDirectoryName(meta.module_key);
  }
  return module;
}

/**
 * 目录名必须 === module_key，否则注册表查不到（glob 用目录名建映射）。
 *
 * 症状：后端能存、`/api/chat/scenes` 能返回胶囊、点击也能触发一轮，但消息里那块
 * UI **永久降级成 `fallback_text`，不报错、不打日志**。这是本期最难自查的失败，
 * 所以在 DEV 期喊出来（`registry.test.ts` 有对应断言兜住）。
 *
 * ## 为什么不能用 `import.meta.url`
 *
 * `import.meta.url` 在**本文件**里永远指向 `define.tsx` 自己，不是调用方 module 的
 * 路径。第一版就是这么写的，结果对每个 module 都误报「目录名不一致」——一条永远
 * 为真的告警等于没有告警，还会训练人忽略它。所以改为从调用栈里取调用方文件路径。
 *
 * ## 为什么找不到 `/modules/` 就静默跳过
 *
 * 单测（vitest 转译）、打包产物（路径已哈希）里栈帧不一定含源码路径。此时**宁可
 * 不检查，也不要误报**。真正的一致性由 `__tests__/constants.test.ts` 里的
 * 「每个场景目录名 === meta.module_key」断言保证 —— 那是硬兜底，不依赖运行时栈。
 */
function checkDirectoryName(moduleKey: string): void {
  const stack = new Error().stack || '';
  const frame = stack
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes('/modules/') && line.includes('/index.'));
  if (!frame) return;
  const at = frame.indexOf('/modules/');
  const rest = frame.slice(at + '/modules/'.length);
  const dir = rest.split('/')[0];
  if (!dir || dir === moduleKey) return;
  console.warn(
    `[scene] module_key "${moduleKey}" 与目录名 "${dir}" 不一致，`
    + '注册表按目录名登记，该 module 永远不会被匹配到（消息里会静默降级成纯文本）。',
  );
}