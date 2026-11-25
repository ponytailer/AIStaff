import { Component, type ReactNode } from 'react';

import type { SceneBlockProps, SceneUiBlock } from './types';

/**
 * 未知 module / 渲染异常时的降级组件（`scene-v3-visual-contract.md` §3）。
 *
 * **这不是兜底装饰，而是开发期自检工具**：目录名写错时，如果你看到的是白屏而不是
 * 这张卡，说明降级路径本身也坏了。
 *
 * 视觉逐值照抄 contract §3：
 * - 边框 1.5px 虚线 `--border-strong`（`#cfc5b7`），圆角 12px
 * - padding 11px 13px，底 `--surface-subtle`（`#fbfaf6`）
 * - 正文 12px `--ink-soft`（`#343633`），line-height 1.6
 * - 顶部提示 10px `--muted-soft`（`#9a9b95`），mb 6px
 */
export function SceneFallbackCard({
  moduleKey,
  moduleVersion,
  text,
  className = '',
}: {
  moduleKey: string;
  moduleVersion?: number;
  text: string;
  className?: string;
}) {
  // 提示文案固定（contract §3）：module_key 与 module_version 都必须显示出来，
  // 否则排查「为什么这块是文本」时没有线索。
  const version = typeof moduleVersion === 'number' && moduleVersion > 0 ? ` v${moduleVersion}` : '';
  return (
    <div
      className={`rounded-[12px] border-[1.5px] border-dashed border-[#cfc5b7] bg-[#fbfaf6] px-[13px] py-[11px] ${className}`}
      data-scene-fallback={moduleKey || 'unknown'}
    >
      <div className="mb-[6px] text-[10px] text-[#9a9b95]">
        {`⚠ 该消息使用的界面组件（${moduleKey || '未知'}${version}）未安装，已降级为文本`}
      </div>
      <div className="text-[12px] leading-[1.6] whitespace-pre-wrap text-[#343633]">{text}</div>
    </div>
  );
}

/**
 * 纯文本降级：`fallback_text` 裸渲染（不带虚框）。
 *
 * 与 `SceneFallbackCard` 的分工：**module 缺失**用虚框卡（用户该知道界面降级了）；
 * **block 的 kind 没有对应组件**（如 module 只实现了 ResultCard，这块是 `empty`）
 * 用裸文本 —— 那不是故障，是 module 的选择。
 */
export function SceneFallbackText({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={`text-[12.5px] leading-[1.6] whitespace-pre-wrap text-[#343633] ${className}`}>
      {text}
    </div>
  );
}

/** 从 block 里取兜底文本：block 级优先，其次 data.content / data.reason，最后空串。 */
export function blockFallbackText(block: SceneUiBlock): string {
  const own = typeof block.fallback_text === 'string' ? block.fallback_text.trim() : '';
  if (own) return own;
  const data = block.data ?? {};
  const content = typeof data.content === 'string' ? data.content.trim() : '';
  if (content) return content;
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  return reason;
}

/**
 * `SceneMessageView` 形状的降级组件（arch §3.3）。
 *
 * 注册表在「module 存在但没导出组件」时用它顶上，保证渲染链不断。
 */
export function SceneBlockFallback({ block }: SceneBlockProps) {
  const text = blockFallbackText(block);
  if (!text) return null;
  return <SceneFallbackText text={text} className="mt-[6px]" />;
}

type BoundaryState = { failed: boolean };

/**
 * block 粒度的 error boundary。
 *
 * **必须挂在每个 block 外层，不能挂在消息外层**（arch §3.3）：一条消息可能有 3 个
 * block，一个 module 崩了不该把另外两个也带走。挂在消息外层 = 一个模块的 bug 让整条
 * 回复变成一句 fallback，用户会觉得「AI 坏了」。
 *
 * 用 class 是因为 React 的错误边界只能由 class 提供（函数组件没有等价能力）。
 */
export class SceneBlockBoundary extends Component<
  { fallbackText: string; moduleKey?: string; moduleVersion?: number; children: ReactNode },
  BoundaryState
> {
  constructor(props: {
    fallbackText: string;
    moduleKey?: string;
    moduleVersion?: number;
    children: ReactNode;
  }) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // 不吞掉堆栈：module 是第三方可插拔代码，崩了要能在控制台定位到是哪个 key。
    console.warn(`[scene] module "${this.props.moduleKey || 'unknown'}" 渲染失败，已降级为文本`, error);
  }

  componentDidUpdate(previous: { moduleKey?: string; fallbackText: string }): void {
    // 换了一条消息（module_key 或兜底文本变了）要重置失败态，否则一条坏消息会让
    // 后续所有消息都渲染成 fallback。
    if (this.state.failed
      && (previous.moduleKey !== this.props.moduleKey
        || previous.fallbackText !== this.props.fallbackText)) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <SceneFallbackCard
          moduleKey={this.props.moduleKey || '未知'}
          moduleVersion={this.props.moduleVersion}
          text={this.props.fallbackText}
        />
      );
    }
    return this.props.children;
  }
}