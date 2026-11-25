import { useCallback, useEffect, useMemo, useState } from 'react';
import { notify } from '@/components/ui/app-toast';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';
import IconTrash from '../../assets/icons/trash.svg?react';
import IconRefresh from '../../assets/icons/refresh.svg?react';
import {
  DEFAULT_MATCH_ACTION,
  DEFAULT_TRIGGER,
  SEMANTIC_SLOTS,
  createScene,
  getScene,
  getSceneTable,
  importSceneTable,
  listScenesForAgent,
  runScene,
  setSceneAgents,
  updateScene,
  type SceneMatchAction,
  type SceneRead,
  type SceneRunResult,
  type SceneSlot,
  type SceneStatus,
  type SceneTablePreview,
  type SceneTableRead,
  type SceneTrigger,
} from '../../api/scenes';
import { api, TENANT_ID } from '../../api/client';
import type { AgentProfileRead } from '../../types';
import {
  checkSlotMappings,
  explainRunResult,
  hitRatioText,
  parseSlotInput,
  publishBlockers,
  qualityLevelText,
  renderTemplate,
  splitQuality,
  statusMeta,
  unknownTemplateKeys,
  visibleSteps,
} from './sceneUtils';

/**
 * 场景定义器。
 *
 * 六个区块按「配一个场景时人类真实的思考顺序」排：
 * 1. 基础信息（叫什么、干什么）
 * 2. 数据表（查哪张表）
 * 3. 触发条件（什么时候轮到它）
 * 4. 槽位（问用户什么）
 * 5. 匹配策略（怎么算命中、空结果怎么办）
 * 6. 命中后回答（怎么组织语言）
 *
 * 顺序不能按后端字段顺序排（trigger 在 slots 前、match_action 在 respond 前），
 * 那样管理员要来回跳：「想改回答方式」得先滑过三个不相干的区块。
 *
 * 试跑面板固定在右侧，改任何一项都能立刻验证 —— 没有试跑，调策略就是盲调。
 */
export default function SceneEditor({
  sceneId,
  defaultAgentId,
  tables,
  onClose,
  onSaved,
}: {
  /** null = 新建 */
  sceneId: string | null;
  defaultAgentId?: string;
  tables: SceneTableRead[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const isNew = !sceneId;
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState(1);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [status, setStatus] = useState<SceneStatus>('draft');
  const [tableId, setTableId] = useState(tables[0]?.id ?? '');
  const [trigger, setTrigger] = useState<SceneTrigger>({ ...DEFAULT_TRIGGER });
  const [slots, setSlots] = useState<SceneSlot[]>([]);
  const [matchAction, setMatchAction] = useState<SceneMatchAction>({ ...DEFAULT_MATCH_ACTION });
  const [respondMode, setRespondMode] = useState<'template' | 'llm'>('template');
  const [respondTemplate, setRespondTemplate] = useState('');
  const [shortcutAction, setShortcutAction] = useState<'form' | 'message' | 'url'>('form');
  const [shortcutUrl, setShortcutUrl] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>(defaultAgentId ? [defaultAgentId] : []);

  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [tablePreview, setTablePreview] = useState<SceneTablePreview | null>(null);
  const [uploading, setUploading] = useState(false);
  const [localTables, setLocalTables] = useState<SceneTableRead[]>(tables);

  const [runSlots, setRunSlots] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<SceneRunResult | null>(null);
  const [running, setRunning] = useState(false);

  const currentTable = useMemo(
    () => localTables.find((table) => table.id === tableId) ?? null,
    [localTables, tableId],
  );
  const columnKeys = useMemo(
    () => (currentTable?.columns ?? []).map((column) => column.key),
    [currentTable],
  );

  // 载入已有的场景
  useEffect(() => {
    if (!sceneId) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const row = await getScene(sceneId);
        if (!alive) return;
        // 形状校验：拿到的必须是一个对象且带 id。少了这一步，一个异常响应
        // （代理返回错误体、老接口、被截断的 JSON）会让每个字段都 set 成
        // undefined → 界面显示成一张**空白的已填充表单**，用户以为场景配置丢了。
        if (!row || typeof row !== 'object' || !row.id) {
          throw new Error('场景数据格式异常，请刷新后重试');
        }
        setName(row.name ?? '');
        setDescription(row.description);
        setIcon(row.icon);
        setStatus(row.status);
        setTableId(row.table_id);
        setTrigger({ ...DEFAULT_TRIGGER, ...row.trigger });
        setSlots(row.slots ?? []);
        setMatchAction({ ...DEFAULT_MATCH_ACTION, ...row.match_action });
        setRespondMode(row.respond_action?.mode === 'llm' ? 'llm' : 'template');
        setRespondTemplate(row.respond_action?.template ?? '');
        setShortcutAction(row.shortcut?.action ?? 'form');
        setShortcutUrl(row.shortcut?.url ?? '');
        setAgentIds(row.agent_ids ?? []);
      } catch (error) {
        notify.error(error instanceof Error ? error.message : '加载场景失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sceneId]);

  // 员工列表（用于绑定）。overall 是广场宿主行、dispatcher 不能挂私有场景，两者都排除。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await api.get<AgentProfileRead[]>(
          `/api/enterprise/agents?tenant_id=${encodeURIComponent(TENANT_ID)}`,
        );
        if (!alive) return;
        setAgents(rows.filter((row) => !row.is_overall && row.kind !== 'dispatcher'));
      } catch {
        // 拉不到员工列表不阻塞定义器：绑定是可选项，之后在档案页也能挂
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 表变了就拉预览（需要列定义来配槽位）
  useEffect(() => {
    if (!tableId) {
      setTablePreview(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const preview = await getSceneTable(tableId, 20);
        if (!alive) return;
        // 结构校验：拿到的必须是 {table, rows}。直接透传会让下游 ?.table.quality
        // 在异常响应上炸掉整个定义器，而这类响应在代理/老接口下是会发生的事。
        setTablePreview(preview && preview.table ? preview : null);
      } catch {
        if (alive) setTablePreview(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tableId]);

  /**
   * 切表时把槽位重置成新表的三个语义槽位。
   *
   * 不重置的后果：场景原本挂在「人数/天数/预算」上，换了张列名叫「成团人数」的表，
   * 旧槽位全部指向不存在的列 —— 保存能成功，试跑永远空。
   */
  const adoptSemanticSlots = useCallback((keys: string[]) => {
    setSlots(
      SEMANTIC_SLOTS.map((item) => {
        const matched =
          keys.find((key) => key === item.key) ??
          keys.find((key) => key.includes(item.label)) ??
          '';
        return {
          key: item.key,
          label: item.label,
          target: matched,
          type: 'number' as const,
          unit: item.unit,
          required: true,
        };
      }),
    );
  }, []);

  // 新建场景第一次拿到列定义时，自动铺好三个语义槽位 —— 手点三遍太蠢
  useEffect(() => {
    if (isNew && slots.length === 0 && columnKeys.length > 0) {
      adoptSemanticSlots(columnKeys);
    }
  }, [adoptSemanticSlots, columnKeys, isNew, slots.length]);

  const slotIssues = useMemo(
    () => checkSlotMappings(slots, columnKeys, SEMANTIC_SLOTS.map((item) => item.key)),
    [columnKeys, slots],
  );
  const blockers = useMemo(
    () =>
      publishBlockers(
        { table_id: tableId, slots, respond_action: { mode: respondMode, template: respondTemplate } },
        columnKeys,
      ),
    [columnKeys, respondMode, respondTemplate, slots, tableId],
  );

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const preview = await importSceneTable(file);
      const table = preview.table;
      setLocalTables((current) => [table, ...current.filter((row) => row.id !== table.id)]);
      setTableId(table.id);
      setTablePreview(preview);
      const { blocking } = splitQuality(table.quality);
      if (blocking.length > 0) {
        notify.error(`表里有 ${blocking.length} 个必须修复的问题，见下方导入检查`);
      } else {
        notify.success(`已导入 ${table.row_count} 行`);
      }
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '导入失败');
    } finally {
      setUploading(false);
    }
  }

  function toPayload() {
    return {
      name: name.trim(),
      description: description.trim(),
      icon: icon.trim(),
      table_id: tableId,
      status,
      trigger,
      slots,
      match_action: matchAction,
      respond_action: {
        mode: respondMode,
        template: respondTemplate,
        max_items: matchAction.top_k,
      },
      shortcut: { action: shortcutAction, url: shortcutUrl.trim() },
    };
  }

  async function save(nextStatus?: SceneStatus) {
    const targetStatus = nextStatus ?? status;
    if (!name.trim()) {
      notify.error('场景名称不能为空');
      setActiveSection(1);
      return;
    }
    if (!tableId) {
      notify.error('先选一张数据表');
      setActiveSection(2);
      return;
    }
    // 发布前必须过完整性检查；草稿允许半成品（用户就是要边配边存）
    if (targetStatus === 'published') {
      const issues = publishBlockers(
        { table_id: tableId, slots, respond_action: { mode: respondMode, template: respondTemplate } },
        columnKeys,
      );
      if (issues.length > 0) {
        notify.error(`还不能发布：${issues.join('；')}`);
        return;
      }
    }

    setSaving(true);
    try {
      const payload = { ...toPayload(), status: targetStatus };
      const saved: SceneRead = isNew
        ? await createScene({ ...payload, agent_id: agentIds[0] ?? null })
        : await updateScene(sceneId, payload);
      // 绑定是独立接口（整体覆盖语义）。新建时已经带了第一个员工，
      // 但若用户在弹窗里勾了多个，仍需再同步一次。
      if (!isNew) {
        await setSceneAgents(saved.id, agentIds);
      }
      setStatus(targetStatus);
      notify.success(isNew ? '场景已创建' : '已保存');
      await onSaved();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    if (!sceneId) {
      notify.error('先保存场景，再试跑');
      return;
    }
    const payload: Record<string, number> = {};
    for (const slot of slots) {
      const value = parseSlotInput(runSlots[slot.key] ?? '');
      if (value !== null) payload[slot.key] = value;
    }
    if (Object.keys(payload).length === 0) {
      notify.error('至少填一个条件再试跑');
      return;
    }
    setRunning(true);
    try {
      const result = await runScene(sceneId, payload);
      setRunResult(result);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '试跑失败');
    } finally {
      setRunning(false);
    }
  }

  // 三级兜底：预览 → 列表里那份 → 空。
  // 中间那级的 `?.quality` 不能省：预览请求可能返回不带 table 的异常结构
  // （老版本接口 / 代理截断 / 测试替身），少了它整个定义器白屏。
  const quality = tablePreview?.table?.quality ?? currentTable?.quality ?? [];
  const { blocking, warnings } = splitQuality(quality);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-[rgba(24,24,26,0.28)]">
      {/* `w-full max-w-[1180px]` 会把抽屉推到视口最左边：1280px 屏幕上抽屉左缘落在
          x=100，正好压在左侧导航栏上面，标题和每个输入框的左半截都被盖住。
          这里按侧边栏实际宽度留出左侧空间（展开 --sidebar-width 已含 island gap），
          让抽屉要么贴右侧、要么被挤窄，但不能钻到导航栏底下。
          用 calc 而不是写死 240px：侧边栏收起后只占 icon 宽度，硬留 240 会白掉一大块。 */}
      <div
        className="ml-[calc(var(--sidebar-width)+2*var(--island-gap))] flex h-full w-full max-w-[1180px] flex-col border-l border-[rgba(24,24,26,0.14)] bg-[#fbfbfa] shadow-[-24px_0_48px_-24px_rgba(24,24,26,0.28)]"
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? '新建场景' : '编辑场景'}
      >
        {/* 头部 */}
        <div className="flex items-center gap-[12px] border-b border-[rgba(24,24,26,0.14)] px-[28px] py-[18px]">
          <h2 className="m-0 font-serif text-[19px] font-semibold text-[#18181a]">
            {isNew ? '新建场景' : `编辑场景 · ${name || '未命名'}`}
          </h2>
          {(() => {
            const meta = statusMeta(status);
            return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
          })()}
          <div className="ml-auto flex items-center gap-[8px]">
            <button
              onClick={onClose}
              className="rounded-[8px] px-[12px] py-[6px] text-[12.5px] text-[#6d6d72] transition-colors hover:bg-black/5"
            >
              取消
            </button>
            <button
              disabled={saving}
              onClick={() => void save()}
              className="rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[12px] py-[6px] text-[12.5px] text-[#18181a] transition-colors hover:border-[rgba(24,24,26,0.3)] disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存草稿'}
            </button>
            <button
              disabled={saving}
              onClick={() => void save('published')}
              title={blockers.length > 0 ? blockers.join('；') : undefined}
              className="rounded-[8px] bg-[#0f766e] px-[14px] py-[6px] text-[12.5px] font-semibold text-white transition-colors hover:bg-[#0c6158] disabled:opacity-50"
            >
              发布
            </button>
          </div>
        </div>

        {loading ? (
          <div className="grid flex-1 place-items-center text-[13px] text-[#6d6d72]">加载中…</div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* 左：六个区块 */}
            <div className="min-w-0 flex-1 overflow-y-auto px-[28px] py-[22px]">
              {/* 1 基础信息 */}
              <Section index={1} title="基础信息" active={activeSection} onEnter={setActiveSection}>
                <Field label="场景名称" required>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：滑雪行程推荐"
                    className={INPUT_CLASS}
                  />
                </Field>
                <Field label="场景描述" hint="告诉员工什么时候该用它，会进模型的系统提示">
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={2}
                    placeholder="例如：根据人数、天数、预算，从价目表里推荐合适的滑雪套餐"
                    className={cnTextarea}
                  />
                </Field>
                <Field label="图标" hint="一个 emoji，显示在快捷按钮上">
                  <input
                    value={icon}
                    onChange={(event) => setIcon(event.target.value)}
                    placeholder="🎿"
                    className={`${INPUT_CLASS} w-[100px]`}
                  />
                </Field>
              </Section>

              {/* 2 数据表 */}
              <Section index={2} title="数据表" active={activeSection} onEnter={setActiveSection}>
                <div className="flex flex-wrap items-center gap-[10px]">
                  <select
                    value={tableId}
                    onChange={(event) => {
                      setTableId(event.target.value);
                      setRunResult(null);
                    }}
                    className={`${INPUT_CLASS} w-[280px]`}
                  >
                    <option value="">选择数据表</option>
                    {localTables.map((table) => (
                      <option key={table.id} value={table.id}>
                        {table.name}（{table.row_count} 行）
                      </option>
                    ))}
                  </select>
                  <label className="cursor-pointer rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[10px] py-[6px] text-[12.5px] transition-colors hover:border-[rgba(24,24,26,0.3)]">
                    {uploading ? '导入中…' : '＋ 导入 xlsx / csv'}
                    <input
                      type="file"
                      accept=".xlsx,.xlsm,.csv"
                      className="hidden"
                      onChange={(event) => void handleUpload(event.target.files?.[0])}
                    />
                  </label>
                </div>

                {/* 质量问题必须显式呈现：静默通过会让用户以为表里没这些数据 */}
                {(blocking.length > 0 || warnings.length > 0) && (
                  <ul className="m-0 mt-[12px] flex list-none flex-col gap-[6px] p-0">
                    {[...blocking, ...warnings].map((issue, index) => (
                      <li
                        key={`${issue.code}-${issue.column}-${index}`}
                        className={`flex items-start gap-[7px] rounded-[8px] px-[10px] py-[7px] text-[12px] leading-[18px] ${
                          issue.level === 'error'
                            ? 'bg-[#fce7e7] text-[#d20b0b]'
                            : 'bg-[#fff2e5] text-[#b45309]'
                        }`}
                      >
                        <span className="shrink-0 font-semibold">{qualityLevelText(issue.level)}</span>
                        <span className="min-w-0">
                          {issue.column ? `「${issue.column}」：` : ''}
                          {issue.message}
                          {issue.row_count > 0 ? `（${issue.row_count} 行）` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {tablePreview && tablePreview.rows.length > 0 && (
                  <div className="mt-[14px] overflow-x-auto rounded-[10px] border border-[rgba(24,24,26,0.10)]">
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="bg-[#f2f1ee]">
                          {tablePreview.table.columns.map((column) => (
                            <th
                              key={column.key}
                              className="whitespace-nowrap px-[10px] py-[7px] text-left font-medium text-[#6d6d72]"
                            >
                              {column.label}
                              {column.unit ? (
                                <span className="ml-[3px] text-[10px] text-[#9a9a9f]">({column.unit})</span>
                              ) : null}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tablePreview.rows.slice(0, 5).map((row) => (
                          <tr key={row.row_index} className="border-t border-[rgba(24,24,26,0.06)]">
                            {tablePreview.table.columns.map((column) => (
                              <td
                                key={column.key}
                                className="max-w-[220px] truncate px-[10px] py-[6px] text-[#18181a]"
                              >
                                {String(row.values[column.key] ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>

              {/* 3 触发条件 */}
              <Section index={3} title="触发条件" active={activeSection} onEnter={setActiveSection}>
                <ToggleRow
                  label="显示快捷按钮"
                  hint="聊天输入框上方显示一颗按钮，点开直接填表"
                  checked={trigger.shortcut}
                  onChange={(next) => setTrigger({ ...trigger, shortcut: next })}
                />
                {trigger.shortcut && (
                  <Field label="按钮文案" hint="留空则用场景名">
                    <input
                      value={trigger.shortcut_label}
                      onChange={(event) =>
                        setTrigger({ ...trigger, shortcut_label: event.target.value })
                      }
                      placeholder={name || '滑雪行程推荐'}
                      className={`${INPUT_CLASS} w-[260px]`}
                    />
                  </Field>
                )}
                <Field label="意图关键词" hint="用户说到这些词时路由到这个场景，回车添加">
                  <TagInput
                    values={trigger.keywords}
                    onChange={(next) => setTrigger({ ...trigger, keywords: next })}
                    placeholder="例如：推荐行程 / 滑雪 / 报价"
                  />
                </Field>
                <ToggleRow
                  label="跳过意图路由"
                  hint="开启后点按钮直接进入，不让模型再判一次（更稳，但只能靠按钮触发）"
                  checked={trigger.bypass_llm_router}
                  onChange={(next) => setTrigger({ ...trigger, bypass_llm_router: next })}
                />
                <ToggleRow
                  label="必须收齐槽位才执行"
                  hint="关闭后条件不全也直接查表（缺维度就跳过该层筛选）"
                  checked={trigger.require_slots}
                  onChange={(next) => setTrigger({ ...trigger, require_slots: next })}
                />
              </Section>

              {/* 4 槽位 */}
              <Section index={4} title="槽位（要问用户什么）" active={activeSection} onEnter={setActiveSection}>
                <p className="m-0 mb-[10px] text-[12px] leading-[18px] text-[#9a9a9f]">
                  三个语义槽位对应匹配的三层：人数是硬约束、天数允许 ±1、预算按相对偏差排序。
                  key 不能改（匹配层按它取值），只需要把「对应列」指对。
                </p>
                <div className="flex flex-col gap-[10px]">
                  {slots.map((slot, index) => {
                    const issue = slotIssues.find((item) => item.key === slot.key);
                    return (
                      <div
                        key={slot.key}
                        className="flex flex-wrap items-center gap-[10px] rounded-[10px] border border-[rgba(24,24,26,0.10)] bg-white px-[12px] py-[10px]"
                      >
                        <span className="w-[52px] shrink-0 text-[12.5px] font-medium text-[#18181a]">
                          {slot.label ?? slot.key}
                        </span>
                        <span className="text-[11px] text-[#9a9a9f]">{slot.unit}</span>
                        <span className="text-[12px] text-[#6d6d72]">→</span>
                        <select
                          value={slot.target ?? ''}
                          onChange={(event) => {
                            const next = [...slots];
                            next[index] = { ...slot, target: event.target.value };
                            setSlots(next);
                          }}
                          className={`${INPUT_CLASS} w-[180px]`}
                        >
                          <option value="">未映射</option>
                          {columnKeys.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </select>
                        <label className="flex items-center gap-[5px] text-[12px] text-[#6d6d72]">
                          <input
                            type="checkbox"
                            checked={Boolean(slot.required)}
                            onChange={(event) => {
                              const next = [...slots];
                              next[index] = { ...slot, required: event.target.checked };
                              setSlots(next);
                            }}
                          />
                          必填
                        </label>
                        <button
                          onClick={() => setSlots(slots.filter((_, i) => i !== index))}
                          aria-label={`删除槽位 ${slot.label ?? slot.key}`}
                          className="ml-auto grid size-6 place-items-center rounded-[6px] text-[#9a9a9f] transition-colors hover:bg-black/5 hover:text-[#d20b0b]"
                        >
                          <IconTrash className="size-3" />
                        </button>
                        {issue && (
                          <p
                            className={`m-0 w-full text-[11.5px] leading-[16px] ${
                              issue.level === 'error' ? 'text-[#d20b0b]' : 'text-[#b45309]'
                            }`}
                          >
                            {issue.message}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* 挂不到具体行上的问题（典型是「根本没配某个语义槽位」）必须单独列出来。
                    原先只把它渲染在对应槽位行内，而缺失的槽位没有行 —— 提示直接消失，
                    用户以为配全了，发布后才发现只按人数筛。 */}
                {slotIssues
                  .filter((issue) => !slots.some((slot) => slot.key === issue.key))
                  .map((issue) => (
                    <p
                      key={`orphan-${issue.key}`}
                      className={`m-0 text-[11.5px] leading-[16px] ${
                        issue.level === 'error' ? 'text-[#d20b0b]' : 'text-[#b45309]'
                      }`}
                    >
                      {issue.message}
                    </p>
                  ))}
                <div className="mt-[10px] flex gap-[8px]">
                  <button
                    onClick={() => adoptSemanticSlots(columnKeys)}
                    className="rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[10px] py-[5px] text-[12px] text-[#18181a] transition-colors hover:border-[rgba(24,24,26,0.3)]"
                  >
                    按表头自动映射
                  </button>
                  <button
                    onClick={() =>
                      setSlots([
                        ...slots,
                        { key: `extra_${slots.length + 1}`, label: '新槽位', target: '', type: 'number' },
                      ])
                    }
                    className="rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[10px] py-[5px] text-[12px] text-[#18181a] transition-colors hover:border-[rgba(24,24,26,0.3)]"
                  >
                    ＋ 添加槽位
                  </button>
                </div>
              </Section>

              {/* 5 匹配策略 */}
              <Section index={5} title="匹配策略" active={activeSection} onEnter={setActiveSection}>
                <div className="grid grid-cols-2 gap-[12px]">
                  <NumberField
                    label="天数容差（天）"
                    hint="用户说 5 天，4 天和 6 天的行也算命中"
                    value={matchAction.days_tolerance}
                    onChange={(v) => setMatchAction({ ...matchAction, days_tolerance: v })}
                  />
                  <NumberField
                    label="最多返回几条"
                    hint="命中按分数排序后取前 N 条"
                    value={matchAction.top_k}
                    onChange={(v) => setMatchAction({ ...matchAction, top_k: v })}
                  />
                  <NumberField
                    label="淘汰阈值"
                    hint="综合偏差超过这个值就当作完全不相关（越小越严格）"
                    value={matchAction.max_score}
                    onChange={(v) => setMatchAction({ ...matchAction, max_score: v })}
                  />
                  <NumberField
                    label="天数权重"
                    hint="相对预算权重，天数更重要就调大"
                    value={matchAction.days_weight}
                    onChange={(v) => setMatchAction({ ...matchAction, days_weight: v })}
                  />
                </div>
                <Field label="完全没有命中时" hint="这决定了空结果时员工怎么说话">
                  <select
                    value={matchAction.on_empty}
                    onChange={(event) =>
                      setMatchAction({
                        ...matchAction,
                        on_empty: event.target.value as SceneMatchAction['on_empty'],
                      })
                    }
                    className={`${INPUT_CLASS} w-[260px]`}
                  >
                    <option value="nearest">给出差距最小的一批（推荐）</option>
                    <option value="clarify">反问用户能否放宽条件</option>
                    <option value="nothing">只说明没有结果</option>
                  </select>
                </Field>
                <ToggleRow
                  label="用决策模型辅助排序"
                  hint="开启后规则分与模型置信度融合；模型不可用时自动退回纯规则"
                  checked={matchAction.use_decision_model}
                  onChange={(next) => setMatchAction({ ...matchAction, use_decision_model: next })}
                />
              </Section>

              {/* 6 命中后回答 */}
              <Section index={6} title="命中后回答" active={activeSection} onEnter={setActiveSection}>
                <Field label="回答方式">
                  <select
                    value={respondMode}
                    onChange={(event) => setRespondMode(event.target.value as 'template' | 'llm')}
                    className={`${INPUT_CLASS} w-[280px]`}
                  >
                    <option value="template">套模板（内容可控，推荐）</option>
                    <option value="llm">交给模型组织语言（更自然，可能发挥）</option>
                  </select>
                </Field>
                {respondMode === 'template' && (
                  <>
                    <Field
                      label="回答模板"
                      hint="用 {{列名}} 引用命中行的字段，例如 {{计划内容}}"
                    >
                      <textarea
                        value={respondTemplate}
                        onChange={(event) => setRespondTemplate(event.target.value)}
                        rows={5}
                        placeholder={'为你找到 {{计划内容}}\n价格：{{预算}} 元\n行程天数：{{天数}} 天'}
                        className={cnTextarea}
                      />
                    </Field>
                    {unknownTemplateKeys(respondTemplate, columnKeys).length > 0 && (
                      <p className="m-0 text-[11.5px] leading-[16px] text-[#b45309]">
                        模板里这些占位符表里没有对应列：
                        {unknownTemplateKeys(respondTemplate, columnKeys).join('、')} —— 会原样显示出来
                      </p>
                    )}
                    {runResult && runResult.hits.length > 0 && (
                      <Field label="预览（用第一条命中渲染）">
                        <pre className="m-0 max-h-[160px] overflow-auto rounded-[10px] bg-[#f2f1ee] p-[12px] text-[12px] leading-[19px] whitespace-pre-wrap text-[#18181a]">
                          {renderTemplate(respondTemplate, runResult.hits[0].values)}
                        </pre>
                      </Field>
                    )}
                  </>
                )}
                <Field label="快捷按钮点击后">
                  <select
                    value={shortcutAction}
                    onChange={(event) =>
                      setShortcutAction(event.target.value as 'form' | 'message' | 'url')
                    }
                    className={`${INPUT_CLASS} w-[280px]`}
                  >
                    <option value="form">弹表单收槽位</option>
                    <option value="message">直接发一句话</option>
                    <option value="url">打开链接</option>
                  </select>
                </Field>
                {shortcutAction === 'url' && (
                  <Field label="跳转链接" hint="必须以 http/https 开头">
                    <input
                      value={shortcutUrl}
                      onChange={(event) => setShortcutUrl(event.target.value)}
                      placeholder="https://…"
                      className={INPUT_CLASS}
                    />
                  </Field>
                )}
              </Section>

              {/* 绑定员工 */}
              <Section index={7} title="绑定员工" active={activeSection} onEnter={setActiveSection}>
                {agents.length === 0 ? (
                  <p className="m-0 text-[12px] text-[#9a9a9f]">还没有可绑定的员工。</p>
                ) : (
                  <div className="flex flex-wrap gap-[8px]">
                    {agents.map((agent) => {
                      const checked = agentIds.includes(agent.id);
                      return (
                        <label
                          key={agent.id}
                          className={`flex cursor-pointer items-center gap-[6px] rounded-[999px] border px-[11px] py-[5px] text-[12px] transition-colors ${
                            checked
                              ? 'border-[#0f766e] bg-[#e6f2f0] text-[#0f766e]'
                              : 'border-[rgba(24,24,26,0.14)] bg-white text-[#6d6d72]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="hidden"
                            checked={checked}
                            onChange={() =>
                              setAgentIds(
                                checked
                                  ? agentIds.filter((id) => id !== agent.id)
                                  : [...agentIds, agent.id],
                              )
                            }
                          />
                          {checked ? '✓ ' : ''}
                          {agent.name}
                        </label>
                      );
                    })}
                  </div>
                )}
                {isNew && agentIds.length > 1 && (
                  <p className="m-0 mt-[8px] text-[11.5px] leading-[16px] text-[#b45309]">
                    新建时只会绑定第一个员工；其余的在保存后到员工档案页补挂。
                  </p>
                )}
              </Section>

              <div className="h-[40px]" />
            </div>

            {/* 右：试跑面板 */}
            <aside className="flex w-[360px] shrink-0 flex-col border-l border-[rgba(24,24,26,0.14)] bg-white">
              <div className="flex items-center gap-[8px] border-b border-[rgba(24,24,26,0.10)] px-[18px] py-[14px]">
                <span className="text-[13px] font-medium text-[#18181a]">试跑</span>
                <span className="text-[11px] text-[#9a9a9f]">用这组条件查一次表</span>
                <button
                  onClick={() => void handleRun()}
                  disabled={running || isNew}
                  title={isNew ? '先保存再试跑' : undefined}
                  className="ml-auto flex items-center gap-[5px] rounded-[8px] bg-[#0f766e] px-[10px] py-[5px] text-[12px] font-medium text-white transition-colors hover:bg-[#0c6158] disabled:opacity-50"
                >
                  <IconRefresh className="size-3" />
                  {running ? '查表中…' : '试跑'}
                </button>
              </div>

              <div className="flex flex-col gap-[10px] px-[18px] py-[14px]">
                {slots.length === 0 && <p className="m-0 text-[12px] text-[#9a9a9f]">先配槽位。</p>}
                {slots.map((slot) => (
                  <label key={slot.key} className="flex items-center gap-[8px]">
                    <span className="w-[52px] shrink-0 text-[12px] text-[#6d6d72]">
                      {slot.label ?? slot.key}
                    </span>
                    <input
                      value={runSlots[slot.key] ?? ''}
                      onChange={(event) =>
                        setRunSlots({ ...runSlots, [slot.key]: event.target.value })
                      }
                      inputMode="numeric"
                      placeholder={slot.unit ? `单位：${slot.unit}` : ''}
                      className={`${INPUT_CLASS} flex-1`}
                    />
                  </label>
                ))}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[18px]">
                {runResult && (
                  <RunResultPanel result={runResult} columnKeys={columnKeys} />
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

const INPUT_CLASS =
  'h-[32px] rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[9px] text-[12.5px] text-[#18181a] outline-none transition-colors focus:border-[#0f766e]';
const cnTextarea =
  'w-full resize-y rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[9px] py-[7px] text-[12.5px] leading-[19px] text-[#18181a] outline-none transition-colors focus:border-[#0f766e]';

function Section({
  index,
  title,
  active,
  onEnter,
  children,
}: {
  index: number;
  title: string;
  active: number;
  onEnter: (index: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="mb-[14px] rounded-[14px] border border-[rgba(24,24,26,0.10)] bg-white px-[18px] py-[16px]"
      onFocusCapture={() => onEnter(index)}
      data-active={active === index || undefined}
    >
      <h3 className="m-0 mb-[12px] flex items-center gap-[8px] text-[13.5px] font-semibold text-[#18181a]">
        <span className="grid size-[18px] place-items-center rounded-full bg-[#f2f1ee] text-[10px] text-[#6d6d72]">
          {index}
        </span>
        {title}
      </h3>
      <div className="flex flex-col gap-[12px]">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="text-[12px] text-[#6d6d72]">
        {label}
        {required ? <span className="ml-[2px] text-[#d20b0b]">*</span> : null}
        {hint ? <span className="ml-[6px] text-[11px] text-[#9a9a9f]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        step="0.1"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value);
          // 空串/非数字一律不写回：写回 0 会让「阈值=0」把全部行淘汰，
          // 用户只是删掉数字想重打一遍而已。
          if (Number.isFinite(next)) onChange(next);
        }}
        className={INPUT_CLASS}
      />
    </Field>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-[14px]">
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="text-[12.5px] text-[#18181a]">{label}</span>
        <span className="text-[11px] leading-[16px] text-[#9a9a9f]">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-[20px] w-[36px] shrink-0 rounded-full transition-colors ${
          checked ? 'bg-[#0f766e]' : 'bg-[#d5d3ce]'
        }`}
      >
        <span
          className={`absolute top-[2px] size-[16px] rounded-full bg-white transition-all ${
            checked ? 'left-[18px]' : 'left-[2px]'
          }`}
        />
      </button>
    </label>
  );
}

function TagInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const text = draft.trim();
    if (!text) return;
    if (!values.includes(text)) onChange([...values, text]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-[6px] rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[8px] py-[6px]">
      {values.map((value) => (
        <span
          key={value}
          className="flex items-center gap-[4px] rounded-full bg-[#f2f1ee] px-[8px] py-[2px] text-[11.5px] text-[#6d6d72]"
        >
          {value}
          <button
            type="button"
            aria-label={`移除 ${value}`}
            onClick={() => onChange(values.filter((item) => item !== value))}
            className="text-[#9a9a9f] hover:text-[#d20b0b]"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ''}
        className="min-w-[120px] flex-1 border-0 bg-transparent text-[12.5px] text-[#18181a] outline-none"
      />
    </div>
  );
}

/** 试跑结果：漏斗 + 命中行 + 空结果解释。 */
function RunResultPanel({
  result,
  columnKeys,
}: {
  result: SceneRunResult;
  columnKeys: string[];
}) {
  const steps = visibleSteps(result.steps);
  const reason = explainRunResult(result);
  const displayColumns = columnKeys.slice(0, 4);

  return (
    <div className="flex flex-col gap-[12px]">
      {/* 漏斗：让「为什么只剩这几条」看得见 */}
      <div className="rounded-[10px] bg-[#fbfbfa] p-[10px]">
        <div className="mb-[6px] flex items-center gap-[6px] text-[11.5px] text-[#6d6d72]">
          <span>{result.total} 行</span>
          <span>→</span>
          <span className="font-medium text-[#18181a]">{result.hits.length} 条命中</span>
          <span className="ml-auto text-[10.5px] text-[#9a9a9f]">
            {hitRatioText(result.hits.length, result.total)}
          </span>
        </div>
        <ul className="m-0 flex list-none flex-col gap-[3px] p-0">
          {steps.map((step) => (
            <li key={step.key} className="flex items-baseline gap-[6px] text-[11px] leading-[16px]">
              <span className="w-[52px] shrink-0 text-[#9a9a9f]">{step.label}</span>
              <span className="text-[#6d6d72]">
                {step.from} → {step.to}
              </span>
              {step.dropText ? (
                <span className="min-w-0 truncate text-[#b45309]" title={step.dropText}>
                  {step.dropText}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {reason && (
        <p className="m-0 rounded-[10px] bg-[#fff2e5] px-[10px] py-[8px] text-[11.5px] leading-[17px] text-[#b45309]">
          {reason}
        </p>
      )}

      {result.hits.map((hit, index) => (
        <div
          key={hit.row_id}
          className="rounded-[10px] border border-[rgba(24,24,26,0.10)] bg-white p-[10px]"
        >
          <div className="mb-[5px] flex items-center gap-[6px]">
            <span className="grid size-[16px] place-items-center rounded-full bg-[#e6f2f0] text-[10px] font-semibold text-[#0f766e]">
              {index + 1}
            </span>
            <span className="text-[10.5px] text-[#9a9a9f]">
              偏差 天 {hit.days_dev.toFixed(2)} / 预算 {hit.budget_dev.toFixed(2)}
            </span>
          </div>
          <dl className="m-0 grid grid-cols-2 gap-x-[8px] gap-y-[3px]">
            {displayColumns.map((key) => (
              <div key={key} className="min-w-0">
                <dt className="text-[10px] text-[#9a9a9f]">{key}</dt>
                <dd className="m-0 truncate text-[11.5px] text-[#18181a]" title={String(hit.values[key] ?? '')}>
                  {String(hit.values[key] ?? '')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

export { SceneEditor };