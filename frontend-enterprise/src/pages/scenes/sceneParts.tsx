import { type ReactNode } from 'react';

import type { SceneMatchAction, SceneRead, SceneSlot } from '@/api/scenes';
import { sceneTypeMeta } from '@/scenes/types';
import { SCENE_SECTION_LABEL } from './sceneUi';

/**
 * 场景管理页（`ScenesPage`）的展示片段 —— 逐条对应
 * `docs/scenes/scene-manager-demo.html`。
 *
 * 单独成文件而不是塞进 `ScenesPage`：这些片段的**判断**比样式更容易写错，
 * 而且都是「看起来对、实际会误导」的那一类（见每个函数上的注释）。
 * 纯展示、无状态，便于在页面之外单独验证。
 *
 * ## 样式不在这里定义
 *
 * 状态 pill / 分组标题这类**跨组件复用**的样式统一放在 `./sceneUi`。
 * 这个文件只负责「哪条数据该怎么解释」，不负责「长成什么样」——
 * 两件事混在一起，改样式时必然要读完 240 行判断逻辑才能找到 class。
 */


/**
 * 「待完善」的判定：**一条员工都没绑** = 用户在对话里根本触发不到这个场景。
 *
 * 为什么单独抽成函数：「配置不完整」有很多种（没配表、没配槽位、模板为空），
 * 但那些只在**创建者视角**是问题；而「没绑员工」是**产品直接失效**，
 * 必须单独突出显示。混在一起报会让管理员以为「有点黄就是得改」，
 * 结果去改了一堆本来就该留空的东西。
 *
 * 归档态不算：归档就是「我故意停用的」，提醒它待完善等于催人删掉。
 */
export function isSceneIncomplete(scene: Pick<SceneRead, 'agent_ids' | 'status'>): boolean {
  return (scene.agent_ids?.length ?? 0) === 0 && scene.status !== 'archived';
}

/** 场景类型标签（emoji + 中文名）。 */
export function sceneTypeLabel(sceneType: string): string {
  const meta = sceneTypeMeta(sceneType);
  return `${meta.icon} ${meta.label}`;
}

/**
 * 「会问的条件」流程条：`人数·人 → 天数·天 → 预算·元`。
 *
 * 顺序有意义（用户就是这么一个个被问的），所以用箭头而不是顿号分隔。
 */
export function SlotFlow({ slots }: { slots: SceneSlot[] }) {
  if (!slots.length) {
    return <span className="text-[12px] text-[#9a9b95]">不需要收条件</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-[5px]">
      {slots.map((slot, index) => (
        <span className="flex items-center gap-[5px]" key={slot.key}>
          <span className="inline-flex items-center gap-[3px] rounded-[6px] border border-[#e2dbd0] bg-[#fbfaf6] px-[7px] py-[2px] text-[11.5px] text-[#343633]">
            {slot.label || slot.key}
            {slot.unit && <i className="text-[10px] font-normal text-[#9a9b95] not-italic">· {slot.unit}</i>}
          </span>
          {index < slots.length - 1 && <span className="text-[10px] text-[#c3c4be]">→</span>}
        </span>
      ))}
    </span>
  );
}

/**
 * 查表 chip。
 *
 * **只对 `table_match` 渲染这一行**（由调用方判断），因为 SOP / handoff /
 * script 根本不查表 —— 对它们写「未配表」是把「用不上」说成「漏配了」，
 * 管理员会跑去接一张表，接完发现根本没生效，反而更困惑。
 */
export function TableChip({ names }: { names: string[] }) {
  if (!names.length) return <span className="text-[12px] text-[#9a9b95]">未配表</span>;
  return (
    <span
      className="inline-flex max-w-full items-center gap-[5px] text-[12px] text-[#343633]"
      title={names.join('、')}
    >
      <span className="inline-flex min-w-0 items-center gap-[4px] rounded-[6px] border border-[#e2dbd0] bg-[#fbfaf6] px-[7px] py-[2px]">
        <span className="truncate">{names[0]}</span>
        {names.length > 1 && (
          <span className="shrink-0 rounded-full bg-[#eeece4] px-[5px] text-[10px] text-[#6d6d72]">
            +{names.length - 1}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * 绑定员工：头像栈 + 名字。
 *
 * 未绑员工时说的是「还没绑员工，用户看不到」而不是「未绑定」—— 后半句解释了
 * **后果**。只说「未绑定」的话，管理员会以为这只是一个资料字段没填满。
 */
export function AgentStack({ names }: { names: string[] }) {
  if (!names.length) {
    return <span className="text-[12px] text-[#b45309]">还没绑员工，用户看不到</span>;
  }
  const shown = names.slice(0, 3);
  const tones = ['bg-[#e1f1ed] text-[#0f766e]', 'bg-[#eeece4] text-[#6d6d72]', 'bg-[#eafaf3] text-[#0f8a5f]'];
  return (
    <span className="flex min-w-0 items-center gap-[7px]">
      <span className="flex shrink-0 -space-x-[6px]">
        {shown.map((name, index) => (
          <span
            key={`${name}:${index}`}
            title={name}
            className={`grid size-[20px] place-items-center rounded-full border border-white text-[10px] font-semibold ${tones[index % 3]}`}
          >
            {name.slice(0, 1)}
          </span>
        ))}
        {names.length > 3 && (
          <span
            title={names.join('、')}
            className="grid size-[20px] place-items-center rounded-full border border-white bg-[#eeece4] text-[9.5px] text-[#6d6d72]"
          >
            +{names.length - 3}
          </span>
        )}
      </span>
      <span className="truncate text-[12px] text-[#6d6d72]">
        {shown.join('、')}
        {names.length > 3 ? ' 等' : ''}
      </span>
    </span>
  );
}

/**
 * 槽位明细表。
 *
 * 「映射列」这一列**只对 `table_match` 渲染**。SOP / handoff / script 不查表，
 * 对它们画一列「未映射」等于把「这个列对你不适用」说成「你配错了」——
 * 用户会去追一个不存在的问题。这是最容易做错的展示层判断。
 */
export function SlotDetailTable({ slots, sceneType }: { slots: SceneSlot[]; sceneType: string }) {
  if (!slots.length) {
    return (
      <div className="rounded-[9px] border border-[#e7dfd3] bg-[#fbfaf6] px-[11px] py-[9px] text-[12px] text-[#9a9b95]">
        这个场景不需要收条件，用户一问就直接处理。
      </div>
    );
  }
  const useTable = sceneType === 'table_match';
  // 用 CSS grid 而不是 table：三列宽度需要在窄屏下弹性收缩，table 会把
  // 「会怎么问」这列撑爆（那句问法动辄十几字）。
  const gridCols = useTable
    ? 'grid-cols-[88px_minmax(0,1fr)_76px]'
    : 'grid-cols-[88px_minmax(0,1fr)]';

  return (
    <div className="overflow-hidden rounded-[9px] border border-[#e7dfd3]">
      <div className={`grid ${gridCols} gap-[8px] border-b border-[#e7dfd3] bg-[#fbfaf6] px-[10px] py-[5px] text-[10.5px] text-[#9a9b95]`}>
        <span>条件</span>
        <span>会怎么问</span>
        {useTable && <span>映射列</span>}
      </div>
      {slots.map((slot, index) => (
        <div
          key={slot.key}
          className={`grid ${gridCols} items-center gap-[8px] px-[10px] py-[7px] text-[12px] ${
            index > 0 ? 'border-t border-[#f0ece4]' : ''
          }`}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-[4px] text-[#343633]">
            <span className="truncate">{slot.label || slot.key}</span>
            {slot.unit && <span className="text-[10px] text-[#9a9b95]">·{slot.unit}</span>}
            {slot.required && (
              <span className="rounded-[4px] bg-[#fdf0ee] px-[4px] text-[9.5px] text-[#c0392b]">必填</span>
            )}
          </span>
          <span className="line-clamp-1 text-[#6d6d72]" title={slot.prompt || ''}>
            {slot.prompt || <span className="text-[#b3b4ae]">默认问法</span>}
          </span>
          {useTable && (
            <span
              className={`line-clamp-1 text-[11px] ${slot.target ? 'text-[#0f766e]' : 'text-[#b45309]'}`}
              title={slot.target ? '映射到表里的这一列' : '没映射到任何列，查表时用不上'}
            >
              {slot.target ? `→ ${slot.target}` : '未映射'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** 匹配策略网格。只在 table_match 且确实配过时显示细节。 */
export function MatchGrid({ action }: { action: Partial<SceneMatchAction> }) {
  const items: Array<{ k: string; v: string }> = [];
  if (typeof action.days_tolerance === 'number') {
    items.push({ k: '天数容差', v: `±${action.days_tolerance} 天` });
  }
  // 人数容差只在**放宽**时显示。0（严格）是业务默认预期，摆出来会让
  // 「人数一致」显得像一个可以商量的参数；但它确实是可配的，配了就
  // 必须让用户在下拉/卡片上看得见，否则又变成「改了没生效」。
  if (typeof action.people_tolerance === 'number' && action.people_tolerance > 0) {
    items.push({ k: '人数容差', v: `±${action.people_tolerance} 人` });
  }
  if (typeof action.days_weight === 'number' && action.days_weight > 0) {
    items.push({ k: '天数权重', v: String(action.days_weight) });
  }
  if (typeof action.budget_weight === 'number' && action.budget_weight > 0) {
    items.push({ k: '预算权重', v: String(action.budget_weight) });
  }
  if (typeof action.top_k === 'number' && action.top_k > 0) {
    items.push({ k: '最多给', v: `${action.top_k} 条` });
  }
  if (action.on_empty) {
    const map: Record<string, string> = {
      nearest: '给最接近的',
      clarify: '反问一次',
      none: '只说明结果',
      // 旧值别名：后端把 `nothing` 当 `none` 处理（见 matcher 的
      // `_ON_EMPTY_ALIASES`）。历史场景里可能还存着它，显示要能对上，
      // 不能露出原始英文。
      nothing: '只说明结果',
    };
    items.push({ k: '没命中时', v: map[action.on_empty] ?? action.on_empty });
  }
  if (!items.length) return <span className="text-[12px] text-[#9a9b95]">默认策略</span>;
  return (
    <div className="grid grid-cols-2 gap-[6px]">
      {items.map((item) => (
        <div
          key={item.k}
          className="flex items-center justify-between gap-[8px] rounded-[7px] border border-[#e7dfd3] bg-[#fbfaf6] px-[9px] py-[5px]"
        >
          <span className="text-[11px] text-[#9a9b95]">{item.k}</span>
          <span className="font-mono text-[11.5px] text-[#343633]">{item.v}</span>
        </div>
      ))}
    </div>
  );
}

/** 区块小标题（demo `.sec-label`，大写字距）。样式来自 `sceneUi`，此处只管语义。 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className={SCENE_SECTION_LABEL}>{children}</div>;
}