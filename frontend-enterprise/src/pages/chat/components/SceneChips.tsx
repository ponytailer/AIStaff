import { useEffect, useMemo, useState } from 'react';

import { api, TENANT_ID } from '@/api/client';
import type { SceneChip } from '@/scenes/types';

/**
 * 对话端入口胶囊（`GET /api/chat/scenes?tenant_id=&agent_id=`）。
 *
 * ## 视觉契约
 *
 * 唯一来源：`docs/scenes/scene-v3-visual-contract.md` §6。逐值照抄：
 * - 胶囊 `rounded-full px-[11px] py-[5px] text-[11.5px]`
 * - 默认 `border border-[#ded7cc] bg-white text-[#343633]`
 * - hover `hover:border-[#0f766e] hover:bg-[#e1f1ed] hover:text-[#0f766e]`
 * - 行内 `flex gap-[7px] flex-wrap`（**由父级 `Composer` 提供**，见下）
 * - 「更多」`border-dashed text-[#9a9b95]`
 * - 行与输入框 `pb-[9px] border-b border-dashed border-[#e7dfd3] mb-[9px]`（同父级）
 *
 * ## 位置铁律：**本组件不渲染行容器**
 *
 * 契约 §6「位置铁律」+ arch §5.8：「胶囊行与 `ChatPromptSuggestions` **同栏渲染**，
 * 用虚线分隔成两个视觉分区。**不要另起一行** —— 另起一行会挤掉输入框上方的空间，
 * 在 1280×800 的笔记本上会顶到消息区。」
 *
 * 所以 flex 行、`gap`、`pl-[20px]`、虚线分隔都由父级提供，这里只输出若干
 * `<button>`。两边都「不自己起行」，才可能真正同栏 —— 各自带 `w-full` 的容器
 * 会各占一整行，那正是要避免的「另起一行」。
 *
 * ## 为什么不住在 `src/scenes/`
 *
 * 它依赖 `@/api/client`（要发请求取胶囊），而 `src/scenes/` 是框架无关层
 * （见 `SceneBlockList` 里关于 render prop 的说明）。`src/scenes/types.ts`
 * 只提供 `SceneChip` 类型。
 */

/** 最多直接显示几颗；超出进「更多」。arch §5.8 决策 4 的 6 个上限。 */
export const MAX_VISIBLE_SCENE_CHIPS = 6;

type SceneChipsProps = {
  /** 当前对话的员工 id。空则不发请求（草稿态还没选定员工）。 */
  agentId: string;
  /** 分享模式 / 正在跑一轮时置灰：此时点下去发不出去，可点样式就是骗人。 */
  disabled?: boolean;
  /** 点胶囊：由父级决定 `open_form` / `send_text`（需要异步查 module meta）。 */
  onSelect?: (chip: SceneChip) => void;
  /** 取数结果回调。父级据此决定要不要起「同栏」容器（0 个时不占高度）。 */
  onLoaded?: (chips: SceneChip[]) => void;
  /** 测试注入口：跳过网络直接给胶囊。生产路径不要传。 */
  chips?: SceneChip[];
};

const CHIP_CLASS =
  'inline-flex items-center gap-[5px] rounded-full border border-[#ded7cc] bg-white '
  + 'px-[11px] py-[5px] text-[11.5px] text-[#343633] transition-colors '
  + 'hover:border-[#0f766e] hover:bg-[#e1f1ed] hover:text-[#0f766e] '
  + 'focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-[#0f766e] '
  + 'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-[#ded7cc] '
  + 'disabled:hover:bg-white disabled:hover:text-[#343633]';

/**
 * 「更多」按钮：虚线边框 + `--muted-soft` 字色（契约 §6 最后一行）。
 *
 * 是 `border-dashed` 不是 `border-dotted`：虚线密度不同，2px 处看得很清楚。
 * 只换边框样式、不换底色 —— 它属于同一组胶囊，不是次要按钮。
 */
const MORE_CHIP_CLASS =
  'inline-flex items-center gap-[5px] rounded-full border border-dashed border-[#ded7cc] '
  + 'bg-white px-[11px] py-[5px] text-[11.5px] text-[#9a9b95] transition-colors '
  + 'hover:border-[#0f766e] hover:text-[#0f766e] '
  + 'focus-visible:outline-none focus-visible:ring-[1.5px] focus-visible:ring-[#0f766e] '
  + 'disabled:cursor-not-allowed disabled:opacity-60';

export default function SceneChips({
  agentId,
  disabled = false,
  onSelect,
  onLoaded,
  chips: injectedChips,
}: SceneChipsProps) {
  const [loadedChips, setLoadedChips] = useState<SceneChip[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // 测试注入口：给了就直接用，不发请求（也避免 jsdom 里 fetch 未 stub 的噪音）。
    if (injectedChips) {
      onLoaded?.(injectedChips);
      return;
    }
    const tenantId = TENANT_ID;
    if (!agentId || !tenantId) {
      setLoadedChips([]);
      onLoaded?.([]);
      return;
    }
    let cancelled = false;
    api
      .get<SceneChip[]>(
        `/api/chat/scenes?tenant_id=${encodeURIComponent(tenantId)}&agent_id=${encodeURIComponent(agentId)}`,
      )
      .then((rows) => {
        if (cancelled) return;
        const next = Array.isArray(rows) ? rows : [];
        setLoadedChips(next);
        onLoaded?.(next);
      })
      .catch(() => {
        // 胶囊是增强，不是主路径：接口挂了就当没配场景，**不要**弹 toast 打断对话
        // （arch §5.8「失败语义」）。安静退化成纯对话是正确降级。
        if (cancelled) return;
        setLoadedChips([]);
        onLoaded?.([]);
      });
    return () => {
      cancelled = true;
    };
    // `onLoaded` 故意不进依赖：父级常以箭头函数传入，进依赖会每次渲染重拉一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, injectedChips]);

  const chips = useMemo(() => injectedChips ?? loadedChips, [injectedChips, loadedChips]);

  // 加载中/空都不渲染（父级因此不留空白行，否则输入框上方会多一段空隙）。
  if (chips.length === 0) return null;

  const visible = expanded ? chips : chips.slice(0, MAX_VISIBLE_SCENE_CHIPS);
  const hiddenCount = chips.length - visible.length;

  return (
    <>
      {visible.map((chip) => (
        <button
          key={chip.scene_id}
          type="button"
          className={CHIP_CLASS}
          disabled={disabled}
          // tooltip 用场景名而不是 label：label 可能被实例改短，场景名才是全称。
          title={chip.scene_name || chip.label}
          onClick={() => onSelect?.(chip)}
        >
          {chip.icon && <span aria-hidden="true">{chip.icon}</span>}
          <span>{chip.label || chip.scene_name || '场景'}</span>
        </button>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          className={MORE_CHIP_CLASS}
          disabled={disabled}
          // arch §5.8 决策 4：本期点它不做任何事，但**必须渲染** ——
          // 它的存在本身在告诉管理员「你绑了 7 个，界面上只露出 6 个」；
          // 不显示的话管理员会以为绑定丢了。
          aria-label={`还有 ${hiddenCount} 个场景入口`}
          onClick={() => setExpanded(true)}
        >
          {`更多 ${hiddenCount}`}
        </button>
      )}
    </>
  );
}