import { isBlockKind, type SceneUiBlock } from '@/scenes/types';

import type { A2UIBlock } from './chatTypes';

/**
 * 「一条消息 → 有序块数组」之后的第二步：**决定每块挂在哪个位置**。
 *
 * ## 为什么位置要单独成一层
 *
 * `uiBlocksForMessage()` 统一的是「解析 + 分发 + 降级」，它刻意不管位置
 * （见该函数注释里的挂载位表）。位置是**视觉契约**，而视觉契约的唯一来源是
 * 现有的 `MessageBubble` 版面 —— 所以位置判断集中放在这里，一格一个函数，
 * 谁都能一眼看出「这块为什么在这」。
 *
 * 七个散落的 if（`dispatch` / `team_progress` / `harness_artifacts` /
 * `knowledge_citations` / `slotForm` / `scheduledDraft` / `suggested_actions`）
 * 收敛成四个挂载位之后，**加一种新块只需要在这里加一行**，而不是在气泡里
 * 找第七个 if 该插在哪儿。
 *
 * ## 四个挂载位（顺序即垂直顺序）
 *
 * | 挂载位 | 位置 | 块 |
 * |---|---|---|
 * | `head`  | 气泡头部（正文上方） | `dispatch`（由 X 回答） |
 * | `body`  | 正文内状态行 | `team_progress` |
 * | `below` | 正文下方 | `harness_artifacts` / `knowledge_citations` |
 * | `tail`  | 尾部 | 场景块 / `slot_form` / `scheduled_task_draft` / `suggested_actions` |
 *
 * **`knowledge_citations` 留在 `below` 而不是挪进尾列**：挪过去看起来更整齐，
 * 但会改掉现有视觉 —— 这不是重构的目标（用户原话：不要 demo 一个样、实际另一个样）。
 */
export type MountSlot = 'head' | 'body' | 'below' | 'tail';

/**
 * 框架内置 kind 的挂载位。**表里没有的 kind 一律进 `tail`**：
 * 语义块（`text` / `result` / `empty` / `step` / `handoff` / `form`）与
 * 未知 kind 都由 `SceneBlockList` 在尾部按「有 module_key 查注册表，否则内置
 * 渲染器，再否则兜底文本」处理 —— 未知 kind 落到这里会渲染成兜底文本，
 * 而不是消失（降级优先）。
 */
const MOUNT_SLOT_BY_KIND: Record<string, MountSlot> = {
  dispatch: 'head',
  team_progress: 'body',
  harness_artifacts: 'below',
  knowledge_citations: 'below',
  slot_form: 'tail',
  scheduled_task_draft: 'tail',
  suggested_actions: 'tail',
};

export function mountSlotOf(kind: string): MountSlot {
  return MOUNT_SLOT_BY_KIND[kind] ?? 'tail';
}

/** 是否是框架内置 kind（由前端从既有 metadata 合成，后端永不产出）。 */
export function isFrameworkBlock(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(MOUNT_SLOT_BY_KIND, kind);
}

export type BlockSlots = {
  head: A2UIBlock[];
  body: A2UIBlock[];
  below: A2UIBlock[];
  tail: A2UIBlock[];
};

/** 按挂载位切分。**保持原顺序**（后端逐帧累加的顺序就是渲染顺序）。 */
export function splitBlocksByMountSlot(blocks: A2UIBlock[]): BlockSlots {
  const slots: BlockSlots = { head: [], body: [], below: [], tail: [] };
  for (const block of blocks) {
    const kind = typeof block.kind === 'string' ? block.kind : '';
    slots[mountSlotOf(kind)].push(block);
  }
  return slots;
}

/**
 * 一块是不是「场景块」（要交给 `SceneBlockList` 渲染）。
 *
 * 判据两条取并集：
 * - **有 `module_key`** —— 明确声明了由哪个 module 画（哪怕这个 module 还没装）；
 * - **kind 在 `BlockKind` 里** —— 后端语义块，即使没带 module_key 也要按
 *   「有内置实现走内置，没有走兜底」处理。
 *
 * 框架内置 kind 永远不是场景块：它的渲染器就在聊天页里。
 */
export function isSceneBlock(block: A2UIBlock): boolean {
  if (isFrameworkBlock(block.kind)) return false;
  if (typeof block.module_key === 'string' && block.module_key) return true;
  return isBlockKind(block.kind);
}

/**
 * `A2UIBlock` → `SceneUiBlock`（`SceneBlockList` 的入参）。
 *
 * 为什么要转换而不是直接传：`A2UIBlock.kind` 是 `string`（消息 metadata 来自
 * 后端，必须容忍未知值），而 `SceneUiBlock.kind` 是 `BlockKind` 联合类型 ——
 * 类型层不允许把一个未知 kind 直接塞给 module。
 *
 * 处理方式：**能识别的 kind 原样保留；识别不了的降级成 `text`**，把
 * `fallback_text` 当正文渲染。这样「后端上线了一个新 kind、前端还是旧构建」
 * 时用户看到的是一句人话，而不是空白，也不是一个报错。
 */
export function toSceneBlock(block: A2UIBlock): SceneUiBlock {
  const kind = isBlockKind(block.kind) ? block.kind : 'text';
  return {
    ...block,
    kind,
    data: typeof block.data === 'object' && block.data ? block.data : {},
    module_key: typeof block.module_key === 'string' ? block.module_key : '',
    module_version: typeof block.module_version === 'number' ? block.module_version : undefined,
    fallback_text: typeof block.fallback_text === 'string' ? block.fallback_text : '',
  };
}

export type TailSegment =
  | { type: 'scene'; blocks: SceneUiBlock[] }
  | { type: 'builtin'; block: A2UIBlock };

/**
 * 尾部分组：**连续的场景块合成一段**，框架内置块各自一段。
 *
 * 为什么要分组而不是逐块渲染：`SceneBlockList` 自己是一个
 * `flex flex-col gap-[9px]` 的容器，负责「结果卡 + 后续追问」之间的 9px 间距。
 * 若把每块单独包一个容器，块与块之间的间距会变成 0（相邻的两个 flex 容器
 * 之间没有 gap），而现有内置块（`SlotFormCard` 的 `mt-[12px]`、
 * `CHAT_SUGGESTED_ACTIONS_CLASS` 的 `pt-[2px]`）自带外边距 —— 混进同一个
 * 带 gap 的容器里会把它们的视觉间距改掉。分组是唯一能同时满足两者的做法。
 */
export function tailSegments(blocks: A2UIBlock[]): TailSegment[] {
  const segments: TailSegment[] = [];
  let run: SceneUiBlock[] = [];
  const flush = () => {
    if (run.length > 0) {
      segments.push({ type: 'scene', blocks: run });
      run = [];
    }
  };
  for (const block of blocks) {
    if (isSceneBlock(block)) {
      run.push(toSceneBlock(block));
      continue;
    }
    flush();
    segments.push({ type: 'builtin', block });
  }
  flush();
  return segments;
}

/**
 * 从块里取「表单描述」。`form` 块的 `data` 就是 `build_slot_form()` 的输出，
 * 与 legacy `metadata.a2ui` 同形，所以复用同一份解析（`parseA2UIForm`）。
 */
export function formPayloadOf(block: A2UIBlock): Record<string, unknown> | null {
  const data = block.data;
  if (!data || typeof data !== 'object') return null;
  const nested = (data as Record<string, unknown>).form;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return data as Record<string, unknown>;
}

/**
 * module 参数（`scene.ui_config_json.params`）。
 *
 * **P0 拿不到**：`SceneUiBlock.to_dict()` 只透 `kind` / `data` / `module_key` /
 * `module_version` / `fallback_text`，刻意不带场景配置（那是管理侧的东西，
 * 而消息 metadata 会被分享页读到）。所以这里返回空对象，让每个 module 走
 * 自己 `params_schema` 的默认值 —— 那正是「不传参也能画出合理卡片」的意思。
 *
 * 若后端将来把参数并进 metadata（比如 `metadata.scene_params`），只需在这里
 * 多认一个键，所有 module 自动生效（它们收到的就是 `params`）。
 */
export function sceneParamsOf(item: { metadata?: Record<string, unknown> }): Record<string, unknown> {
  const raw = item.metadata?.scene_params;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * 这条消息属于哪个场景实例（`metadata.scene_id`）。
 *
 * 为什么表单提交非要它不可：场景表单提交的文本是「人数：4；天数：5；预算：3000」，
 * 一个触发关键词都没有。后端 `resolve_scene_hit()` 靠关键词匹配，必然命中不到；
 * 只有前端把它作为 `forced_scene_id` 带回去，这一轮才会进入 `scene_module`
 * 而不是落回普通对话。不带的表现是「填完表 → 去查了一遍知识库」，
 * 而且**不报错**——用户只会觉得这张表白填了。
 *
 * 信息源是消息 metadata 的顶层键（后端 `turn_run` 写），不是 block 上的
 * `scene_id` 字段：`SceneUiBlock.to_dict()` 只透 5 个字段，没有这个键。
 */
export function sceneIdOf(item: { metadata?: Record<string, unknown> }): string {
  const raw = item.metadata?.scene_id;
  return typeof raw === 'string' ? raw.trim() : '';
}