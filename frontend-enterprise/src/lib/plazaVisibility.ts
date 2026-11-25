import type { PlatformDetailKind } from '@/components/openPlatform/PlatformKindDetailView';

/** 广场模块标识（与 PlatformDetailKind 同源，不另立字面量联合类型）。 */
export type PlazaKind = PlatformDetailKind;

/**
 * 暂时下架的广场模块（2026-11-25）。
 *
 * SOP 广场的业务流程还在收敛，先不对外露出，避免用户复制到半成品 SOP。
 *
 * 只在这里加一个 kind 即可整体隐藏：tab 栏、「全部」热门榜、深链与旧地址回落
 * 全都跟着走。数据接口、类型、后端热度计算一律保留 —— 将来把这行删掉就完整
 * 恢复，不需要补任何代码。
 *
 * 为什么单独一个模块而不是写在 OpenPlatformPage 里：PlazaAllTab（热门榜）也要
 * 消费同一份清单，从页面模块反向 import 组件会形成循环依赖。
 */
export const PLAZA_HIDDEN_KINDS: ReadonlySet<PlazaKind> = new Set<PlazaKind>([
  'skills',
]);

/** 该广场模块当前是否下架（入参放松成 string：热门榜的 kind 是后端下发的字符串）。 */
export function isPlazaKindHidden(kind: string): boolean {
  return PLAZA_HIDDEN_KINDS.has(kind as PlazaKind);
}