import { lazy, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react';

import type {
  BlockKind,
  SceneBlockProps,
  SceneModule,
  SceneModuleMeta,
  SceneUiBlock,
} from './types';

/**
 * 场景 module 注册表：构建期自动发现 + 懒加载 + 降级。
 *
 * ## 为什么是 `import.meta.glob`
 *
 * `import.meta.glob` 在 **build 时**展开成静态 import 列表，Vite 为每个匹配文件单独切
 * chunk；主包只拿到几个 `() => import(...)` 箭头函数，不含任何模块代码。
 * 所以「新增一个场景 module = 新增一个 chunk，主 bundle 体积不增长」。
 *
 * ## 三条必须遵守的写法（违反任一条都会静默坏掉，且不报错）
 *
 * 1. **不加 `{ eager: true }`**。加了会把所有 module 静态打进主包，直接摧毁 code-split
 *    ——而这正是本次要顺带解决的问题。验收方式是看 build 产物里有没有独立 chunk。
 * 2. **模式只匹配「modules 下一层目录里的 index.tsx」**（点号目录名可匹配）。
 *    不能写成「scenes 下任意一层 + 斜杠 + 星 + index.tsx」——那会把 `scenes/` 下任何
 *    恰好有 `index.tsx` 的框架子目录误认为 module；也不能写成递归通配，那会连
 *    `modules/a/b/index.tsx` 这种嵌套一起匹配，而 `keyOf()` 只取第一段，
 *    两个不同 module 会互相覆盖。
 *    （此段刻意不写出通配符字面量：`*` 紧跟 `/` 会提前终止块注释。）
 * 3. **目录名 === `meta.module_key`**（点号命名，`travel.itinerary`）。`*` 能匹配带点的
 *    目录名，所以不需要任何映射/小驼峰/连字符转换。写错时的症状：后端能存、
 *    `/api/chat/scenes` 能返回胶囊、点击也能触发一轮，但消息里那块 UI **永久降级成
 *    `fallback_text`，不报错、不打日志**。`registry.test.ts` 有一条测试专门兜这个。
 *
 * 注册表**只做「module_key → 组件」的映射，不做「kind → 组件」**：`kind` 是语义标签，
 * 渲染成什么样由 module 的代码决定（arch §3.2）。一个 module 内部按 kind 选自己的组件，
 * 这样它能共用一份局部状态（比如比较模式下的选中项）。
 */
const loaders = import.meta.glob<{ default: SceneModule }>('./modules/*/index.tsx');

/** `'./modules/travel.itinerary/index.tsx'` → `'travel.itinerary'` */
function keyOf(path: string): string {
  return path.replace(/^\.\/modules\//, '').split('/')[0];
}

/** module_key → glob 路径。目录名即 module_key。 */
const pathByKey: Record<string, string> = {};
for (const path of Object.keys(loaders).sort()) {
  pathByKey[keyOf(path)] = path;
}

/**
 * glob 返回的每个值都是 `() => Promise<{ default: SceneModule }>` ——
 * 动态 import 的模块命名空间对象，module 本身在 `default` 上（`defineSceneModule()`
 * 的返回值被 `export default`）。
 */
export type SceneModuleLoader = () => Promise<{ default: SceneModule }>;

/**
 * 取某 module 的加载器。返回 `null` = **未知 module_key**。
 *
 * 这是注册表唯一的「不认识」出口，调用方必须降级成 `fallback_text`（arch §3.3）。
 */
export function getSceneModule(key: string): SceneModuleLoader | null {
  if (!key) return null;
  const path = pathByKey[key];
  if (!path) return null;
  return loaders[path] ?? null;
}

export function hasSceneModule(key: string): boolean {
  return Boolean(key) && Boolean(pathByKey[key]);
}

/** 全部已注册 module_key（用于单测对账、开发期的未知 key 诊断）。 */
export function knownSceneModuleKeys(): string[] {
  return Object.keys(pathByKey).sort();
}

const moduleCache = new Map<string, Promise<SceneModule | null>>();

/**
 * 加载并缓存一个 module。
 *
 * 失败（chunk 404 / 模块抛错）时返回 `null` 而**不抛出**：一块 UI 加载失败不该把整条
 * 消息带走，调用方拿到 null 就渲染 fallback_text。缓存的是 Promise，所以同一 module
 * 并发加载只会打一次网络请求。
 */
export function loadSceneModule(key: string): Promise<SceneModule | null> {
  const cached = moduleCache.get(key);
  if (cached) return cached;
  const loader = getSceneModule(key);
  if (!loader) return Promise.resolve(null);
  const task = loader()
    .then((mod) => (mod?.default ? mod.default : null))
    .catch((error: unknown) => {
      console.warn(`[scene] module "${key}" 加载失败，已降级为文本`, error);
      return null;
    });
  moduleCache.set(key, task);
  return task;
}

/**
 * 只取某个 module 的 `meta`（不拿组件）。
 *
 * ## 为什么入口胶囊要它，而不是渲染时直接读 `meta`
 *
 * `import.meta.glob` **不带 `eager`**（§上面第 1 条），所以构建产物里主包只有
 * `() => import(...)` 箭头函数 —— 渲染期读不到 `meta`。而 `entry_behavior`
 * 只存在于 `meta` 里（后端**刻意不持有**它，见 `SceneChip` 类型注释）。
 *
 * 所以口径是：**点击时才解析，而不是渲染时**（arch §5.8）。点击那一刻：
 * - `send_text` 分支只是多发一句话，chunk 加载与网络请求并行，用户感知不到；
 * - `open_form` 分支紧接着就要用同一个 chunk 里的 `SlotForm` 去画表单。
 *
 * **两次加载不是两次开销**：这里走 `loadSceneModule()`，它的 `moduleCache` 缓存的
 * 是 Promise，`sceneModuleView()` 之后拿的是同一份已 resolve 的模块对象。
 * 因此**不要**在这里直接调 `loaders[path]()` —— 那会绕过缓存，是个真的第二次加载。
 *
 * 返回 `null` 的两种情形都是「按 `open_form` 降级」的正常输入，不抛错：
 * 未知 `module_key`（老场景 / 前端灰度落后）、chunk 加载失败。
 */
export async function loadSceneModuleMeta(moduleKey: string): Promise<SceneModuleMeta | null> {
  if (!moduleKey) return null;
  const mod = await loadSceneModule(moduleKey);
  const meta = mod?.meta;
  return meta && typeof meta.module_key === 'string' ? meta : null;
}

// ---------------------------------------------------------------------------
// kind → module 组件
// ---------------------------------------------------------------------------

/**
 * 按 `kind` 取 module 里的组件（arch §3.1 的固定映射）。
 *
 * - `form`   → `SlotForm`
 * - `result` → `ResultCard`
 * - `empty`  → `EmptyState`
 * - `step`   → `StepView`
 * - `text` / `handoff` → `undefined`（无组件，框架渲染 `data.content` / `fallback_text`）
 *
 * 「可少实现、不可多造 kind」：没实现 `EmptyState` 时返回 undefined，调用方降级成文本，
 * **不要**为了空态好看去造一个新 kind —— 那会让后端枚举与前端漂移。
 */
export function componentForKind(
  module: SceneModule,
  kind: BlockKind,
): ComponentType<SceneBlockProps> | undefined {
  switch (kind) {
    case 'form':
      return module.SlotForm;
    case 'result':
      return module.ResultCard;
    case 'empty':
      return module.EmptyState;
    case 'step':
      return module.StepView;
    case 'text':
    case 'handoff':
    default:
      return undefined;
  }
}

/**
 * 每个 `module_key` 只创建一个 lazy 组件并缓存。
 *
 * 不缓存会让每次 render 生成新的 lazy 类型，React 会当成不同组件 → 卸载重挂
 * （表现：卡片里的输入框每次输入都丢焦点 —— 自定义 module 若有表单立刻会踩到）。
 */
const viewCache = new Map<string, LazyExoticComponent<ComponentType<SceneBlockProps>>>();

export function sceneModuleView(
  moduleKey: string,
): LazyExoticComponent<ComponentType<SceneBlockProps>> | null {
  if (!hasSceneModule(moduleKey)) return null;
  const hit = viewCache.get(moduleKey);
  if (hit) return hit;
  const created = lazy(async () => {
    const mod = await import('./SceneModuleSurface');
    return { default: mod.default as unknown as ComponentType<SceneBlockProps> };
  });
  viewCache.set(moduleKey, created);
  return created;
}

// ---------------------------------------------------------------------------
// 目录（meta 清单）—— 员工档案下拉 / 定义器 module 下拉的数据源
// ---------------------------------------------------------------------------

/**
 * 加载全部 module 的 `meta`。
 *
 * 管理台（定义器 / 员工档案）需要看到所有 module 的能力摘要，这里会**把每个 module
 * chunk 都拉下来一次**。这是可接受的：它只发生在管理页面，而且 meta 是「真读」的 ——
 * `summary` 与 `required_slots` 是本期两个界面真实消费的字段（PRD §15.4 第 6 条）。
 * 聊天端**不走这条路径**，它只按需加载命中的那一个 module。
 */
let catalogTask: Promise<SceneModuleMeta[]> | null = null;

export function loadSceneModuleCatalog(): Promise<SceneModuleMeta[]> {
  if (catalogTask) return catalogTask;
  catalogTask = Promise.all(knownSceneModuleKeys().map((key) => loadSceneModule(key)))
    .then((modules) => modules
      .filter((mod): mod is SceneModule => Boolean(mod?.meta?.module_key))
      .map((mod) => mod.meta)
      .sort((a, b) => a.module_key.localeCompare(b.module_key)))
    .catch(() => []);
  return catalogTask;
}

/** 组件里读目录的 hook。首帧返回空数组 + loading，加载完再刷新。 */
export function useSceneModuleCatalog(): { metas: SceneModuleMeta[]; loading: boolean } {
  const [metas, setMetas] = useState<SceneModuleMeta[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void loadSceneModuleCatalog().then((rows) => {
      if (!alive) return;
      setMetas(rows);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { metas, loading };
}

/** 某类型可用的 module（定义器下拉的唯一过滤条件，PRD §6.1）。 */
export function modulesForSceneType(
  metas: SceneModuleMeta[],
  sceneType: string | undefined,
): SceneModuleMeta[] {
  if (!sceneType) return metas;
  return metas.filter((meta) => meta.supported_scene_types.includes(sceneType as never));
}

/** 按 module_key 找 meta（找不到返回 null）。 */
export function metaForModule(
  metas: SceneModuleMeta[],
  moduleKey: string | undefined,
): SceneModuleMeta | null {
  if (!moduleKey) return null;
  return metas.find((meta) => meta.module_key === moduleKey) ?? null;
}

// ---------------------------------------------------------------------------
// 测试与诊断用
// ---------------------------------------------------------------------------

/** 仅供单测：把已知路径列出来对账（不改缓存、不触发加载）。 */
export function sceneModulePaths(): Record<string, string> {
  return { ...pathByKey };
}

/** 仅供单测 / 热更新：清空缓存（生产代码不要调用）。 */
export function resetSceneModuleCache(): void {
  moduleCache.clear();
  viewCache.clear();
  catalogTask = null;
}

/** block 上是否带了可路由的 module（`hasModule` 读它，避免到处 `Boolean(block.module_key)`）。 */
export function blockModuleKey(block: SceneUiBlock): string {
  return typeof block.module_key === 'string' ? block.module_key : '';
}