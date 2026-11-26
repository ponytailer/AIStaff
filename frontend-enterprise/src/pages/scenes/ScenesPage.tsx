import { useCallback, useEffect, useMemo, useState } from 'react';
import IconRefresh from '../../assets/icons/refresh.svg?react';
import IconEdit from '../../assets/icons/edit.svg?react';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../../auth';
import { api, TENANT_ID } from '@/api/client';
import { formatDate } from '@/lib/enterprise-ui';
import type { AgentProfileRead } from '@/types';
import { notify } from '@/components/ui/app-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import SceneEditor from './SceneEditor';
import ScenePreviewCard from './ScenePreviewCard';
import {
  deleteScene,
  listScenes,
  listSceneTables,
  type SceneRead,
  type SceneTableRead,
} from '../../api/scenes';
import { statusMeta } from './sceneUtils';
import {
  SCENE_BTN_LINK_DANGER,
  SCENE_BTN_PRIMARY,
  SCENE_BTN_SECONDARY,
  SCENE_PILL,
  SCENE_PILL_TONE,
  SCENE_SECTION_LABEL,
} from './sceneUi';
import {
  AgentStack,
  MatchGrid,
  SectionLabel,
  SlotDetailTable,
  SlotFlow,
  TableChip,
  isSceneIncomplete,
  sceneTypeLabel,
} from './sceneParts';

/**
 * 场景管理页 —— 按 `docs/scenes/scene-manager-demo.html` 重做。
 *
 * ## 为什么从「一张表」改成「左列表 + 右检查器」
 *
 * 原来的 DataTable 把 7 个字段平铺成列，结果是**每一列都看不全**：
 * 槽位列被截成「人数 / 天数 / 预算」，绑员工列被截成一串 agent 名，
 * 而「这个场景到底会不会用起来」这个真正要判断的问题，没有任何一列回答。
 *
 * 双栏把「挑一个」和「看清它」分开：左边只留决策用的三个指标
 * （类型 / 条件数 / 员工数），右边给完整的配置摘要 + 回答效果预览。
 *
 * ## 两种用法共用一个组件
 *
 * - 独立页 `/enterprise/scenes`：看全部场景，带头部与统计；
 * - 员工档案页的「场景」tab（`embedded` + `agentId`）：只看这个员工的，
 *   不渲染头部（外面已经有页头了）。
 *
 * 刻意不拆成两个组件 —— 只是查询条件与外壳不同，拆开写必然漂
 * （一个页面加了新操作，另一个还停在旧样子）。
 */
export default function ScenesPage({
  currentUser,
  agentId,
  embedded = false,
}: {
  currentUser?: EnterpriseAuthUser;
  /** 给定时只看这个员工的场景；不给则看租户全部 */
  agentId?: string;
  embedded?: boolean;
  /** 兼容旧调用点（员工档案页会传，本页不再使用） */
  onLogout?: () => void;
} = {}) {
  const [scenes, setScenes] = useState<SceneRead[]>([]);
  const [tables, setTables] = useState<SceneTableRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorScene, setEditorScene] = useState<SceneRead | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SceneRead | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = Boolean(currentUser && isEnterpriseAdmin(currentUser));
  /**
   * 写入口的显隐。绑定到自己的员工的场景，创建人也能改；管理员全放行。
   *
   * 这里**只做入口显隐**，真正的判权在后端 —— 前端藏起来是为了不让用户
   * 点了才看到 403。丢掉这个判断的后果不是安全问题，而是「成员看到一个
   * 建了必然失败的按钮”。
   */
  const canManage = isAdmin || Boolean(agentId);

  /** 搜索与选中态。选中项跟着搜索走，否则右侧会停在「看不见的那条」上。 */
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');

  // 员工 id → 名字。列表与检查器都要显示人名，只给 id 的话用户认不出是谁。
  // 拉失败就退化成空映射（显示 id），不能因此让整页报错。
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    api
      .get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`)
      .then((rows) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        (Array.isArray(rows) ? rows : []).forEach((agent) => {
          if (agent?.id) map[agent.id] = agent.name || agent.id;
        });
        setAgentNames(map);
      })
      .catch(() => {
        if (alive) setAgentNames({});
      });
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sceneRows, tableRows] = await Promise.all([
        listScenes(agentId ? { agent_id: agentId } : {}),
        listSceneTables(),
      ]);
      setScenes(sceneRows);
      setTables(tableRows);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载场景失败');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tableNames = useMemo(
    () => Object.fromEntries(tables.map((table) => [table.id, table.name])),
    [tables],
  );

  /** 每个场景实际绑定的人名（用于头像栈）。 */
  const agentNamesOf = useCallback(
    (scene: SceneRead): string[] => (scene.agent_ids ?? []).map((id) => agentNames[id] ?? id),
    [agentNames],
  );

  const tableNamesOf = useCallback(
    (scene: SceneRead): string[] => (scene.table_ids ?? []).map((id) => tableNames[id] ?? '表已删除'),
    [tableNames],
  );

  const stats = useMemo(
    () => ({
      total: scenes.length,
      bound: scenes.filter((scene) => (scene.agent_ids?.length ?? 0) > 0).length,
      incomplete: scenes.filter(isSceneIncomplete).length,
      tables: new Set(scenes.flatMap((scene) => scene.table_ids ?? [])).size,
    }),
    [scenes],
  );

  const visibleScenes = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return scenes.filter((scene) => {
      if (!keyword) return true;
      return `${scene.name} ${scene.description ?? ''}`.toLowerCase().includes(keyword);
    });
  }, [scenes, query]);

  // 选中项被筛掉 → 落到第一条。不这么做的话右侧停在一条「列表里看不见」的场景上，
  // 用户会以为自己点错了。
  useEffect(() => {
    if (visibleScenes.length === 0) {
      if (selectedId) setSelectedId('');
      return;
    }
    if (!visibleScenes.some((scene) => scene.id === selectedId)) {
      setSelectedId(visibleScenes[0].id);
    }
  }, [visibleScenes, selectedId]);

  const selected = visibleScenes.find((scene) => scene.id === selectedId) ?? null;

  /**
   * 槽位 key → 中文名，喂给预览卡片当 `data.labels`。
   *
   * 后端渲染时会从 `slots_json` 取中文名下发（那是唯一事实来源）；预览走的是
   * 前端样板数据，没有后端参与，所以这里自己从场景的槽位上取一遍。
   * 少了它，预览里显示的是 `room_no`、`item`，跟检查器上半部分写着的中文
   * 「房间号」「送什么」对不上，用户会以为预览不是他这个场景的。
   */
  const labelsOf = useCallback(
    (scene: SceneRead): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const slot of scene.slots ?? []) {
        const label = (slot.label ?? '').trim();
        if (slot.key && label) out[slot.key] = label;
      }
      return out;
    },
    [],
  );
  const isSearching = query.trim() !== '';

  const openCreate = () => {
    // 不强制「先有表再建场景」：`table_match` 是 optional 档，其余三类是 none 档，
    // 全都不需要预置表。原来的拦截会让「先建场景、绑员工、后补表」这条最自然的
    // 路径走不通，而且对 script / handoff 是纯粹的错误拦截。
    setCreating(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteScene(deleteTarget.id);
      notify.success('场景已删除');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  /* ---------------- 单条场景（左列表项） ---------------- */
  const renderListItem = (scene: SceneRead) => {
    const st = statusMeta(scene.status);
    const todo = isSceneIncomplete(scene);
    const isSelected = scene.id === selectedId;
    return (
      <button
        key={scene.id}
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        data-scene-id={scene.id}
        onClick={() => setSelectedId(scene.id)}
        className={`flex w-full items-start gap-[9px] rounded-[11px] border px-[11px] py-[9px] text-left transition-colors ${
          isSelected
            ? 'border-[#0f766e] bg-[#f4fbf9]'
            : 'border-transparent bg-transparent hover:border-[#e7dfd3] hover:bg-[#fbfaf6]'
        } ${scene.status === 'archived' ? 'opacity-60' : ''}`}
      >
        <span className="grid size-[26px] shrink-0 place-items-center rounded-[8px] bg-[#eeece4] text-[13px]">
          {scene.icon || '·'}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-center gap-[6px]">
            <span className="truncate text-[13px] font-medium text-[#18181a]" title={scene.name}>
              {scene.name}
            </span>
            <span className={`${SCENE_PILL} ${SCENE_PILL_TONE[st.tone]}`}>
              <span className="size-[4px] rounded-full bg-current" />
              {st.label}
            </span>
            {todo && (
              <span
                title="还没绑员工，用户在对话里看不到它"
                className="size-[5px] shrink-0 rounded-full bg-[#b45309]"
              />
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-[5px] text-[11.5px] text-[#6d6d72]">
            <span>{sceneTypeLabel(scene.scene_type)}</span>
            <span className="text-[#c3c4be]">·</span>
            <span>{scene.slots.length > 0 ? `${scene.slots.length} 个条件` : '无条件'}</span>
            <span className="text-[#c3c4be]">·</span>
            <span className={(scene.agent_ids?.length ?? 0) > 0 ? '' : 'text-[#b45309]'}>
              {(scene.agent_ids?.length ?? 0) > 0 ? `${scene.agent_ids.length} 员工` : '未绑定'}
            </span>
          </span>
        </span>
      </button>
    );
  };

  /* ---------------- 右侧检查器 ---------------- */
  const renderInspector = (scene: SceneRead) => {
    const st = statusMeta(scene.status);
    const todo = isSceneIncomplete(scene);
    const isTableMatch = scene.scene_type === 'table_match';
    return (
      <div className="flex min-h-0 flex-col overflow-hidden rounded-[13px] border border-[#e7dfd3] bg-white">
        <div className="border-b border-[#f0ece4] px-[14px] py-[12px]">
          <div className="flex items-start gap-[10px]">
            <span className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-[#eeece4] text-[15px]">
              {scene.icon || '·'}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
                <h2 className="m-0 truncate text-[14px] font-semibold text-[#18181a]" title={scene.name}>
                  {scene.name}
                </h2>
                <span className={`${SCENE_PILL} ${SCENE_PILL_TONE[st.tone]}`}>
                  <span className="size-[4px] rounded-full bg-current" />
                  {st.label}
                </span>
                {todo && (
                  <span className={`${SCENE_PILL} ${SCENE_PILL_TONE.warn}`}>待绑员工</span>
                )}
              </div>
              <p className="m-0 line-clamp-2 text-[12px] leading-[18px] text-[#6d6d72]">
                {scene.description || '未填写场景描述'}
              </p>
            </div>
            {canManage && (
              <div className="flex shrink-0 items-center gap-[6px]">
                <button type="button" className={SCENE_BTN_PRIMARY} onClick={() => setEditorScene(scene)}>
                  <IconEdit className="size-3" />
                  编辑
                </button>
              </div>
            )}
          </div>
        </div>

        {/*
          配置在左、回答效果在右。分栏用**容器查询**而不是视口断点：
          这个面板住在双栏工作区的右格里，宽度由左列表的 340px 决定，
          与窗口宽度只有间接关系 —— 用 `lg:` 之类的视口断点会在
          「窗口很宽但左列表占掉 340px」时错误地判定为「够宽」。
          demo 的临界值是面板 ~980px（配置列 minmax(0,1fr) + 预览列 448px）。
        */}
        <div className="@container min-h-0 flex-1 overflow-y-auto px-[14px] py-[12px]">
          <div className="grid grid-cols-1 items-start gap-[16px] @[980px]:grid-cols-[minmax(0,1fr)_430px]">
            <div className="flex min-w-0 flex-col gap-[14px]">
              <div>
                <SectionLabel>配置</SectionLabel>
                {/* 限宽：三行「标签—值」拉满整个面板的话，46px 的标签和值之间
                    会空出好几厘米，眼睛要横跳才能对上。 */}
                <div className="flex max-w-[520px] flex-col gap-[7px]">
                  <div className="flex items-start gap-[9px]">
                    <span className="w-[46px] shrink-0 text-[11.5px] text-[#9a9b95]">会问</span>
                    <span className="min-w-0 flex-1">
                      <SlotFlow slots={scene.slots} />
                    </span>
                  </div>
                  {/*
                    查表这一行**只对 table_match 渲染**。SOP / handoff / script 不查表，
                    对它们写「未配表」是把「用不上」说成「漏配了」。
                  */}
                  {isTableMatch && (
                    <div className="flex items-start gap-[9px]">
                      <span className="w-[46px] shrink-0 text-[11.5px] text-[#9a9b95]">查表</span>
                      <span className="min-w-0 flex-1">
                        <TableChip names={tableNamesOf(scene)} />
                      </span>
                    </div>
                  )}
                  <div className="flex items-start gap-[9px]">
                    <span className="w-[46px] shrink-0 text-[11.5px] text-[#9a9b95]">绑给</span>
                    <span className="min-w-0 flex-1">
                      <AgentStack names={agentNamesOf(scene)} />
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <SectionLabel>会问哪些条件</SectionLabel>
                <SlotDetailTable slots={scene.slots} sceneType={scene.scene_type} />
              </div>

              {isTableMatch && (
                <div>
                  <SectionLabel>匹配策略</SectionLabel>
                  <MatchGrid action={scene.match_action} />
                </div>
              )}

              <details className="group">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-[4px] text-[10.5px] text-[#9a9b95] transition-colors hover:text-[#6d6d72]">
                  <span className="inline-block transition-transform group-open:rotate-90">›</span>
                  技术信息
                </summary>
                <div className="mt-[8px] flex flex-col gap-[5px] rounded-[9px] border border-[#e7dfd3] bg-[#fbfaf6] px-[11px] py-[9px]">
                  {[
                    { k: '类型标识', v: scene.scene_type },
                    {
                      k: '界面组件',
                      v: scene.module_key ? `${scene.module_key} · v${scene.module_version}` : '未指定（纯文本）',
                    },
                    { k: '场景 ID', v: scene.id },
                  ].map((row) => (
                    <div key={row.k} className="flex items-baseline gap-[8px]">
                      <span className="w-[66px] shrink-0 text-[10.5px] text-[#9a9b95]">{row.k}</span>
                      <span className="min-w-0 flex-1 font-mono text-[10.5px] break-all text-[#343633]" title={row.v}>
                        {row.v}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </div>

            {/*
              预览列。**限宽 430px**，按真实聊天气泡的宽度画。
              拉满面板看的话按钮离价格很远、文字一行很长，管理员会按错的观感
              去调文案（「这里明明很空」），发出去才发现挤成两行。
            */}
            <div className="flex min-w-0 flex-col gap-[14px]">
              <div>
                <SectionLabel>回答效果</SectionLabel>
                <div className="rounded-[12px] border border-dashed border-[#cfc5b7] bg-[#fbfaf6] p-[11px]">
                  <div className="mb-[8px] flex items-center gap-[4px] text-[10.5px] text-[#9a9b95]">
                    <span>用户在聊天里看到的</span>
                    <span className="ml-auto text-[#b3b4ae]">实际宽度 ≈ 400px</span>
                  </div>
                  {scene.module_key ? (
                    <ScenePreviewCard
                      moduleKey={scene.module_key}
                      params={scene.ui_config?.params}
                      slotLabels={labelsOf(scene)}
                      showCaption={false}
                    />
                  ) : (
                    <p className="m-0 text-[12.5px] leading-[19px] text-[#6d6d72]">
                      这个场景没有卡片界面，回答以纯文本呈现。
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-[8px] border-t border-[#e7dfd3] bg-[#fbfaf6] px-[14px] py-[9px]">
          <span className="flex min-w-0 items-center gap-[4px] truncate text-[10.5px] text-[#9a9b95]">
            {formatDate(scene.updated_at)} 更新
          </span>
          {/* 状态说明放这里而不是 head：head 里已经有状态 pill，
              再写一句「已发布 · 绑了员工即可触发」是同一件事说两遍。 */}
          <span className="shrink-0 text-[10.5px] text-[#b3b4ae]">
            · {scene.status === 'published' ? '绑了员工即可触发' : '草稿，员工看不到'}
          </span>
          {canManage && (
            <div className="ml-auto flex shrink-0 items-center gap-[7px]" role="group" aria-label="场景操作">
              <button
                type="button"
                className="rounded-[7px] px-[8px] py-[3px] text-[11.5px] text-[#6d6d72] transition-colors hover:bg-[#fdf0f0] hover:text-[#c0392b]"
                onClick={() => setDeleteTarget(scene)}
              >
                删除
              </button>
              {/*
                试跑入口指向**定义器**（它内部右侧就有试跑面板），而不是这里
                弹一个只剩输入框的空面板 —— 试跑的意义是「调完策略马上验」，
                脱离定义的试跑跑的是上一版存下的策略，看到的对不对都不可信。
              */}
              <button
                type="button"
                className={SCENE_BTN_SECONDARY}
                onClick={() => setEditorScene(scene)}
              >
                试跑
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  /* ---------------- 空态：从没建过 vs 筛不到 ---------------- */
  const renderBody = () => {
    if (loading && scenes.length === 0) {
      return (
        <div className="grid place-items-center py-[80px] text-[12.5px] text-[#9a9b95]">加载中…</div>
      );
    }

    if (scenes.length === 0) {
      /*
         「一个都没有」和「筛不到」是两种空态，文案不能共用（demo 的注释同样强调）：
         前者要教怎么开始，后者要教怎么找回。混用的后果是用户在筛选里徒劳地找新功能。
      */
      return (
        <div className="flex flex-col items-center gap-[14px] rounded-[13px] border border-[#e7dfd3] bg-white px-[24px] py-[48px] text-center">
          <span className="grid size-[44px] place-items-center rounded-[13px] bg-[#eeece4] text-[20px]">📋</span>
          <div>
            <h2 className="m-0 text-[15px] font-semibold text-[#18181a]">还没有场景</h2>
            <p className="mx-auto mt-[7px] mb-0 max-w-[440px] text-[12.5px] leading-[19px] text-[#6d6d72]">
              场景告诉员工「遇到哪类问题该怎么做」。建一个之后，员工在对话里就能按条件查表推荐，
              而不只是闲聊。
            </p>
          </div>
          <div className="grid w-full max-w-[620px] grid-cols-1 gap-[9px] sm:grid-cols-3">
            {[
              { n: 1, t: '选一个类型', d: '查表推荐最常用：上传一张价目表，用户说需求就推合适的。' },
              { n: 2, t: '配「问什么」', d: '人数、天数、预算——员工会先问齐再查，问不到不乱猜。' },
              { n: 3, t: '绑到员工', d: '绑谁谁就能用。也可以先建好，之后在员工档案里挂上。' },
            ].map((step) => (
              <div
                key={step.n}
                className="flex flex-col items-start gap-[5px] rounded-[10px] border border-[#e7dfd3] bg-[#fbfaf6] px-[11px] py-[10px] text-left"
              >
                <span className="grid size-[18px] place-items-center rounded-full bg-[#e1f1ed] text-[10px] font-semibold text-[#0f766e]">
                  {step.n}
                </span>
                <span className="text-[12px] font-medium text-[#343633]">{step.t}</span>
                <span className="text-[11.5px] leading-[17px] text-[#6d6d72]">{step.d}</span>
              </div>
            ))}
          </div>
          {canManage ? (
            <button type="button" className={SCENE_BTN_PRIMARY} onClick={openCreate}>
              ＋ 新建第一个场景
            </button>
          ) : (
            <p className="m-0 text-[12px] text-[#9a9b95]">场景由管理员配置，需要调整请联系管理员。</p>
          )}
        </div>
      );
    }

    if (visibleScenes.length === 0) {
      /*
         原本文案分三支：搜索、类型筛选、两者都没有。类型 tab 删掉之后
         只剩两支 —— 留着一句提到「点「全部」」的文案会把用户指向一颗
         已经不存在的按钮。
      */
      const hint = isSearching
        ? `没有匹配「${query.trim()}」的场景。换个关键词，或清空搜索框。`
        : '没有可显示的场景。';
      return (
        <div className="rounded-[13px] border border-[#e7dfd3] bg-white px-[20px] py-[40px] text-center text-[12.5px] text-[#6d6d72]">
          {hint}
        </div>
      );
    }

    return (
      <div className="@container min-h-0">
        <div className="grid grid-cols-1 gap-[12px] @[1120px]:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          {/*
            列表固定最大高度 + 独立滚动：不这么做的话 20 个场景会把整页撑高，
            右侧检查器跟着一起滚，用户读配置时列表已经滚没了。
            demo 在 <1120px 时切成上下堆叠（列表在上）—— 这里同样用容器查询，
            因为「embed 到员工档案页」时可用宽度与窗口宽度无关。
          */}
          <div className="flex max-h-[280px] min-h-[200px] flex-col gap-[3px] overflow-y-auto rounded-[13px] border border-[#e7dfd3] bg-white p-[6px] @[1120px]:max-h-[calc(100vh-320px)]">
            {visibleScenes.map(renderListItem)}
            <div className="px-[11px] py-[7px] text-[11px] text-[#b3b4ae]">
              共 {visibleScenes.length} 个 · 点任一项看配置
            </div>
          </div>
          <div className="min-h-[200px] @[1120px]:max-h-[calc(100vh-320px)]">
            {selected && renderInspector(selected)}
          </div>
        </div>
      </div>
    );
  };

  const body = (
    <>
      {scenes.length > 0 && (
        <>
          {/* ---- 统计条：反映全量，不随筛选变 ---- */}
          <div className="mb-[14px] grid grid-cols-2 gap-[9px] sm:grid-cols-4">
            {[
              { label: '场景总数', value: stats.total, unit: '个', tone: '' },
              { label: '已绑定员工', value: stats.bound, unit: '个正在用', tone: 'text-[#138a55]' },
              { label: '待完善', value: stats.incomplete, unit: '还没绑员工', tone: 'text-[#b45309]' },
              { label: '数据表', value: stats.tables, unit: '张已接入', tone: '' },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-[11px] border border-[#e7dfd3] bg-white px-[12px] py-[9px]"
              >
                <div className="text-[10.5px] text-[#9a9b95]">{item.label}</div>
                <div className={`mt-[2px] flex items-baseline gap-[4px] ${item.tone || 'text-[#18181a]'}`}>
                  <span className="font-mono text-[17px] leading-none font-semibold">{item.value}</span>
                  <span className="text-[10.5px] text-[#9a9b95]">{item.unit}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ---- 工具栏：只剩搜索 ---- */}
          {/*
            这里原先有一排类型 tab（全部 / 查表推荐 / 流程办理 / 转人工 /
            固定话术 / 表单提交），每个后面跟一个计数。

            删掉的理由：五个类型里通常有三四个是 0，那几颗永远点不出东西的
            按钮只能制造「我是不是漏配了什么」的焦虑；而真正常用的「找某个
            场景」靠的是搜索框。计数也没有信息量 —— 「表单提交 1」不如列表里
            直接看到那一个场景本身。

            搜索框保留，`ml-auto` 去掉（左侧没有 tab 了，靠右没有意义）。
          */}
          <div className="mb-[12px] flex flex-wrap items-center gap-[10px]">
            <div className="relative flex min-w-[180px] max-w-[420px] flex-1 items-center">
              <span className="pointer-events-none absolute left-[9px] text-[#b3b4ae]">⌕</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜场景名称或描述…"
                className="h-[30px] w-full rounded-[9px] border border-[#ded7cc] bg-white pl-[24px] pr-[9px] text-[12px] text-[#18181a] outline-none placeholder:text-[#b3b4ae] focus:border-[#0f766e]"
              />
            </div>
          </div>
        </>
      )}

      {renderBody()}

      {(creating || editorScene) && (
        <SceneEditor
          sceneId={editorScene?.id ?? null}
          defaultAgentId={agentId}
          tables={tables}
          onClose={() => {
            setCreating(false);
            setEditorScene(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditorScene(null);
            await load();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={<>删除场景「{deleteTarget?.name}」？</>}
        description="场景删除后会同时从所有员工身上解绑，历史对话日志保留。此操作不可撤销。"
        confirmText="删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );

  if (embedded) {
    /*
      embed 到员工档案页时外面已经有页头（员工名 / 状态 / 其他 tab），
      所以这里不再画大标题。但**新建入口必须留着** —— 这里是「给这个员工
      挂场景」的唯一入口，去掉之后成员只能去全局场景页建，而他没有权限。
    */
    return (
      <div className="min-h-0" aria-busy={loading}>
        {canManage && (
          <div className="mb-[12px] flex items-center justify-end gap-[8px]">
            <button type="button" className={SCENE_BTN_SECONDARY} onClick={() => void load()} disabled={loading}>
              <IconRefresh className="size-3.5" />
              刷新
            </button>
            <button type="button" className={SCENE_BTN_PRIMARY} onClick={openCreate}>
              ＋ 新建场景
            </button>
          </div>
        )}
        {body}
      </div>
    );
  }

  return (
    <div
      className="min-h-full box-border px-[32px] pt-[26px] pb-[44px] max-[900px]:px-[16px]"
      aria-busy={loading}
    >
      <header className="mb-[20px] flex items-start justify-between gap-[20px]">
        <div className="min-w-0">
          <h1 className="m-0 text-[21px] leading-none font-semibold tracking-[-0.022em] text-[#18181a]">
            场景
          </h1>
          <p className="mt-[7px] mb-0 max-w-[600px] text-[12.5px] leading-[19px] text-[#6d6d72]">
            让员工在对话里按条件查表推荐、走完一段流程、或把客户转给人。配好一次，全员可用。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-[8px] pt-[2px]">
          <button type="button" className={SCENE_BTN_SECONDARY} onClick={() => void load()} disabled={loading}>
            <IconRefresh className="size-3.5" />
            刷新
          </button>
          {canManage && (
            <button type="button" className={SCENE_BTN_PRIMARY} onClick={openCreate}>
              ＋ 新建场景
            </button>
          )}
        </div>
      </header>
      {body}
    </div>
  );
}

export { ScenesPage };