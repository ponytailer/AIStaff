import { useEffect, useState } from 'react';

import { SceneFallbackText, blockFallbackText } from './fallback';
import { componentForKind, loadSceneModule } from './registry';
import { SceneTextBlock } from './shared/SceneTextBlock';
import type { SceneBlockProps, SceneModule } from './types';

/**
 * 「一个 module 渲染一块 block」的最小外壳（注册表 `lazy()` 指向它）。
 *
 * 为什么不让注册表直接 `lazy(() => import(...).then(m => ({ default: m.ResultCard })))`：
 * 组件选择依赖 `block.kind`，而 kind 只有运行时才知道（同一个 module 既可能拿到
 * `result` 也可能拿到 `empty`）。所以 lazy 的粒度是 **module**，不是 component ——
 * 这也正好符合「一个 module 一份代码、一个 chunk」。
 *
 * 渲染优先级（arch §3.3，**顺序不能反**）：
 * 1. module 加载成功 + 有对应 kind 的组件 → 用它；
 * 2. module 加载成功但没实现这个 kind：
 *    - `text` / `handoff` → **平台默认渲染器**（这两类 kind 本来就没有组件位，
 *      见 `types.ts` 的「kind → 组件」映射；`generic.script` 的追问 chips 与
 *      `generic.handoff` 的摘要都要靠它）；
 *    - 其它 kind → `fallback_text` 裸文本（这不是故障，是 module 的选择）；
 * 3. module 加载失败 / chunk 404 → 也走 `fallback_text`（外层 boundary 会兜住抛错）。
 *
 * 加载期间渲染 `null` 而不是骨架屏：这块内容的高度不稳定，闪一下骨架反而更像「坏了」，
 * 而 chunk 通常几十毫秒就到（同一 CDN 域）。
 */
export default function SceneModuleSurface(props: SceneBlockProps) {
  const moduleKey = typeof props.block.module_key === 'string' ? props.block.module_key : '';
  const [module, setModule] = useState<SceneModule | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    setSettled(false);
    void loadSceneModule(moduleKey).then((loaded) => {
      if (!alive) return;
      setModule(loaded);
      setSettled(true);
    });
    return () => {
      alive = false;
    };
  }, [moduleKey]);

  if (!settled) return null;

  if (!module) {
    // 走到这里说明注册表认识这个 key 但 chunk 挂了（网络 / 版本错配）。
    // 外层 `SceneBlockBoundary` 已经能兜渲染异常，这里是「加载异常」的兜底。
    return <SceneFallbackText text={blockFallbackText(props.block)} />;
  }

  const Renderer = componentForKind(module, props.block.kind);
  if (!Renderer) {
    // `text` / `handoff`：平台负责画（正文 + chips + 转人工摘要）。
    // 这不是「降级」，是这两类 kind 的正常渲染路径。
    if (props.block.kind === 'text' || props.block.kind === 'handoff') {
      return (
        <SceneTextBlock block={props.block} sendText={props.sendText} disabled={props.disabled} />
      );
    }
    return <SceneFallbackText text={blockFallbackText(props.block)} />;
  }
  return <Renderer {...props} />;
}