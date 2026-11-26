import { Suspense, type ReactNode } from 'react';

import { SceneBlockBoundary, SceneFallbackCard, SceneFallbackText, blockFallbackText } from './fallback';
import { hasSceneModule, sceneModuleView } from './registry';
import { SceneTextBlock } from './shared/SceneTextBlock';
import type { SceneUiBlock } from './types';

/**
 * 统一渲染器：遍历 blocks → 查注册表 → 挂载。
 *
 * ## 分发规则只有一条
 *
 * **`block.module_key` 存在 → 查注册表交给场景 module 渲染；否则按 `kind` 走框架内置渲染器。**
 * 这就是「渲染器由 module_key 决定」的落地（PRD §2.1 第 4 条）。
 *
 * 一个例外必须写清（arch §3.4）：后端产出 `kind="form"` 的块时，如果这个场景还没配
 * `module_key`（旧数据 / 灰度期），要**按 kind 落回 `SlotFormCard`** —— 否则表单会消失。
 * 所以判断顺序是：
 *
 * ```
 * module_key 存在 → 注册表
 * 否则 kind 是框架内置 / BlockKind 里且有内置实现 → 框架内置
 * 否则 → fallback_text
 * ```
 *
 * **顺序不能反过来**：反过来会让「新 module 已上线、前端还是旧构建」时表单不显示。
 *
 * ## 为什么 builtin 渲染用 render prop 而不是直接 import 组件
 *
 * `SceneBlockList` 住在 `src/scenes/`，是**框架无关层**；而 `ScheduledDraftCard` /
 * `SlotFormCard` 住在 `src/pages/chat/components/`。直接 import 会让 scenes 反向依赖
 * chat（以后在别的容器里复用它就炸了），也会让 `registry.test.ts` 连带把整个聊天页
 * 拉进测试图。render prop 保持 scenes 层零 chat 依赖。
 */
export default function SceneBlockList({
  blocks,
  params = {},
  onSendText,
  onSubmitSlots,
  onOpenExternal,
  disabled = false,
  renderBuiltin,
  renderForm,
  className = '',
}: {
  blocks: SceneUiBlock[];
  /** module 参数（`scene.ui_config_json.params`）。一条消息的块通常同属一个场景。 */
  params?: Record<string, unknown>;
  onSendText?: (text: string) => void;
  onSubmitSlots?: (values: Record<string, unknown>) => void;
  onOpenExternal?: (url: string) => void;
  disabled?: boolean;
  /** 框架内置 kind 的渲染器（`scheduled_task_draft` / `suggested_actions` / `form` …）。 */
  renderBuiltin?: (block: SceneUiBlock) => ReactNode;
  /** 场景表单渲染器（`build_slot_form()` 的输出 → 组件）。module 通过 props 取用。 */
  renderForm?: (data: Record<string, unknown>) => ReactNode;
  className?: string;
}) {
  if (blocks.length === 0) return null;

  // 平台回调兜底成 no-op：module 里永远不该出现 `sendText is not a function`，
  // 那会让一个「按钮点不动」变成一块「整卡崩掉」。
  const sendText = onSendText ?? (() => {});
  const submitSlots = onSubmitSlots ?? (() => {});
  const openExternal = onOpenExternal ?? (() => {});
  // 「提交能力是否真的可用」必须**单独**带下去。
  //
  // 为什么不能靠 module 里判 `if (submitSlots)`：上面那句已经把它兜底成
  // 非空函数了，判不出来。于是「空结果卡在分享页点建议按钮」会走进
  // `submitSlots(...)` 分支、调到一个 no-op —— 界面上的表现是**点了没反应**，
  // 而不是退回 `sendText`。这是个真发生过的问题，所以这里把能力显式表达。
  const canSubmitSlots = Boolean(onSubmitSlots);

  return (
    <div className={`flex flex-col gap-[9px] ${className}`} data-scene-blocks={blocks.length}>
      {blocks.map((block, index) => {
        const moduleKey = typeof block.module_key === 'string' ? block.module_key : '';

        // ① module 存在 → 走注册表（Suspense 因为 module 是 lazy 的）。
        if (moduleKey && hasSceneModule(moduleKey)) {
          const View = sceneModuleView(moduleKey);
          if (View) {
            const fallbackText = blockFallbackText(block);
            return (
              <SceneBlockBoundary
                key={`${moduleKey}:${block.kind}:${index}`}
                moduleKey={moduleKey}
                moduleVersion={block.module_version}
                fallbackText={fallbackText}
              >
                {/*
                 * `fallback={null}` 而不是「兜底文本先占位」：
                 * 这里的 Suspense 只等 `SceneModuleSurface` 这个**外壳**的 chunk
                 * （几 KB），module 自己的 chunk 由外壳内部再 await。外壳 chunk
                 * 通常一个微任务就到，此时闪一下兜底文本再换成卡片，比空一下更难看，
                 * 而且会让读屏软件把同一句话读两遍。
                 *
                 * 「兜底优先」体现在别处：module 加载失败 / 渲染抛错 / 没实现该 kind
                 * 这三个真实路径上都会渲染兜底文本（见 registry / fallback）。
                 */}
                <Suspense fallback={null}>
                  <View
                    block={block}
                    siblings={blocks}
                    params={params}
                    sendText={sendText}
                    submitSlots={submitSlots}
                    canSubmitSlots={canSubmitSlots}
                    openExternal={openExternal}
                    disabled={disabled}
                    renderBuiltin={renderBuiltin}
                    renderForm={renderForm}
                  />
                </Suspense>
              </SceneBlockBoundary>
            );
          }
        }

        // ② module_key 有值但注册表不认识 → 明确的降级卡（不是白屏）。
        //    这是「后端先发、前端灰度落后」的必然态，必须让用户看到文本而不是空白。
        if (moduleKey) {
          return (
            <SceneFallbackCard
              key={`fallback:${moduleKey}:${index}`}
              moduleKey={moduleKey}
              moduleVersion={block.module_version}
              text={blockFallbackText(block)}
            />
          );
        }

        // ③ 没有 module_key → 框架内置渲染器（定时任务草案 / 可点动作 / 旧表单）
        if (renderBuiltin) {
          const rendered = renderBuiltin(block);
          if (rendered !== null && rendered !== undefined) {
            return <div key={`builtin:${block.kind}:${index}`}>{rendered}</div>;
          }
        }

        // ④ 最后兜底：`text` / `handoff` 用平台默认渲染器（正文 + chips + 摘要），
        //    其余 kind 用纯文本。这里**不是**「降级」——这两类 kind 本来就没有
        //    组件位（types.ts 的「kind → 组件」映射只给了四格）。
        if (block.kind === 'text' || block.kind === 'handoff') {
          return (
            <SceneTextBlock
              key={`text:${block.kind}:${index}`}
              block={block}
              sendText={sendText}
              disabled={disabled}
            />
          );
        }
        return (
          <SceneFallbackText
            key={`text:${block.kind}:${index}`}
            text={blockFallbackText(block)}
          />
        );
      })}
    </div>
  );
}