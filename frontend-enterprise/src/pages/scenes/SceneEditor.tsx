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
import type { SceneType } from '@/scenes/types';
import { SCENE_TYPES, sceneTypeMeta, tableCountWarnings } from '@/scenes/types';
import {
  metaForModule,
  modulesForSceneType,
  useSceneModuleCatalog,
} from '@/scenes/registry';
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
 * 区块按「配一个场景时人类真实的思考顺序」排。v3 目标是八个（契约 §4.2 的
 * 区块显隐表）：
 * 1. 基础信息（叫什么、干什么）
 * 2. 场景界面（用哪个 module + 它的参数 + 兜底文本）  ← 待补
 * 3. 触发条件（什么时候轮到它）
 * 4. 槽位（问用户什么）
 * 5. 数据表（查哪张表）        ← 仅 needs_table !== 'none' 时渲染
 * 6. 匹配策略（怎么算命中）    ← 同上
 * 7. 兜底文本                  ← 待补
 * 8. 绑定员工                  ← 待补
 *
 * **当前实现覆盖 1-8 全部区块**（v3 形状）：基础信息含类型选择器、
 * 场景界面含 module 单选卡 + params_schema 驱动的参数 + 兜底文本、
 * 数据表支持 0..N 张且可排序、按类型显隐。
 *
 * 顺序不能按后端字段顺序排（trigger 在 slots 前、match_action 在 respond 前），
 * 那样管理员要来回跳：「想改回答方式」得先滑过三个不相干的区块。
 *
 * **区块显隐必须是「不渲染」而不是置灰**（契约 §4.2 + §7.3）：类型创建后基本
 * 不变，置灰会让管理员以为「以后能开」，而实际上永远开不了。这是 demo 与实现
 * 唯一刻意不同处，不要按 demo 的置灰去「对齐」。
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
  /**
   * 归属于本场景的表，**有序**（顺序即合并池的 `order_index`）。0..N 张。
   *
   * v3 起一个场景私有 0 到 N 张表（PRD §4.3.1）。曾经这里是单值 `tableId`，
   * 那会让「同构合并查多张价目表」这个核心能力无处表达。
   *
   * 用数组而不是 `Set`：顺序有意义，且要能原样发给后端 `tables`。
   */
  const [tableIds, setTableIdsState] = useState<string[]>(
    tables.length > 0 && tables[0].id ? [tables[0].id] : [],
  );
  /**
   * 用户是否**动过**表清单（加/删/排序/导入）。
   *
   * 这个标记只为一件事存在：更新场景时决定要不要带 `tables` 字段。
   * 后端语义是「`None` = 不改，`[]` = 清空」（`scenes/schema.py:152`），
   * 而 `SceneEditor` 保存时总是把整个表单拼成一次 PUT —— 如果无条件带
   * `tables: tableIds`，那么「只改了个场景名」也会重新提交表清单；一旦
   * 此时 `tableIds` 还是空（加载失败、或表的响应慢于表单），管理员已有的表
   * 就被悄悄清空了，且界面不报错。
   *
   * `JSON.stringify` 会丢掉 `undefined` 但保留 `[]`，所以「不发」必须靠
   * **不赋值**实现，不能靠赋 `undefined`（那样类型上也不成立）。
   */
  const [tablesDirty, setTablesDirty] = useState(false);

  /**
   * 改表清单的**唯一入口**，顺带标 dirty。
   *
   * 刻意只收 updater 函数而不收值：写点有「导入追加 / 下拉添加 / 移除 /
   * 上移 / 下移」五处，逐个手写 `setTablesDirty(true)` 迟早漏掉一处，而漏掉的
   * 表现是「用户明明改了表，保存后却没生效」——比清空更难查。
   *
   * 「载入已有场景」是唯一例外，它走 `setTableIdsState`（见 load effect）：
   * 回填不是用户的修改，标脏会让「只改了名字」也提交一次表清单。
   */
  const setTableIds = useCallback((updater: (current: string[]) => string[]) => {
    setTablesDirty(true);
    setTableIdsState(updater);
  }, []);
  const [trigger, setTrigger] = useState<SceneTrigger>({ ...DEFAULT_TRIGGER });
  const [slots, setSlots] = useState<SceneSlot[]>([]);
  const [matchAction, setMatchAction] = useState<SceneMatchAction>({ ...DEFAULT_MATCH_ACTION });
  const [respondMode, setRespondMode] = useState<'template' | 'llm'>('template');
  const [respondTemplate, setRespondTemplate] = useState('');
  const [shortcutAction, setShortcutAction] = useState<'form' | 'message' | 'url'>('form');
  const [shortcutUrl, setShortcutUrl] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>(defaultAgentId ? [defaultAgentId] : []);

  /**
   * 场景类型。决定「数据表 / 匹配策略 / 槽位」三个区块显不显（契约 §4.2）。
   *
   * 显隐必须是**不渲染**而不是置灰：类型创建后基本不变，置灰会让管理员
   * 以为「以后能开」，而实际上永远开不了。这是 demo 与实现唯一刻意不同处。
   */
  const [sceneType, setSceneType] = useState<SceneType>('table_match');
  /**
   * 用哪个前端 module 来画这块 UI。`''` = 没选（后端会用 `generic.*` 预填）。
   *
   * 它必须能改：module 决定「消息里那块 UI 长什么样」，是场景最核心的
   * 可视能力；只读回填等于管理员永远用默认 module。
   */
  const [moduleKey, setModuleKey] = useState('');
  /** module 私有参数，键由 module 的 `params_schema` 定，框架只透传不解释。 */
  const [moduleParams, setModuleParams] = useState<Record<string, unknown>>({});
  /** UI 渲染不出来时的纯文本兜底。**必填**（契约 §4.2）。 */
  const [fallbackText, setFallbackText] = useState('');

  /**
   * 定义器里的 module 目录。会拉下每个 module 的 chunk —— 只在管理页面发生，
   * 聊天端不走这条路径（见 `registry.ts` 的 `loadSceneModuleCatalog` 注释）。
   */
  const { metas: moduleMetas, loading: moduleMetasLoading } = useSceneModuleCatalog();
  /** 只列支持当前类型的 module（PRD §6.1：事前不可选，不是选了报错）。 */
  const candidateModules = useMemo(
    () => modulesForSceneType(moduleMetas, sceneType),
    [moduleMetas, sceneType],
  );
  const selectedModuleMeta = useMemo(
    () => metaForModule(moduleMetas, moduleKey),
    [moduleMetas, moduleKey],
  );

  const [agents, setAgents] = useState<AgentProfileRead[]>([]);
  const [tablePreview, setTablePreview] = useState<SceneTablePreview | null>(null);
  const [uploading, setUploading] = useState(false);
  const [localTables, setLocalTables] = useState<SceneTableRead[]>(tables);

  const [runSlots, setRunSlots] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<SceneRunResult | null>(null);
  const [running, setRunning] = useState(false);

  /**
   * 预览用哪张表：取已选列表里的第一张。
   *
   * 为什么只预览第一张：列定义用来配槽位，而槽位是**跨表同一套**的
   * （多表要求同构，见 PRD §4.2）。逐张预览会让「到底按哪张配槽位」变模糊。
   * 真正的多表数据核对在「试跑」面板里做——那里才看得到合并后的命中行。
   */
  const previewTableId = tableIds[0] ?? '';
  const currentTable = useMemo(
    () => localTables.find((table) => table.id === previewTableId) ?? null,
    [localTables, previewTableId],
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
        // 读侧字段是 `table_ids`（后端 `SceneRead.table_ids`），不是 `table_id`。
        // 写成 `row.table_id` 会恒 undefined → 打开已配好表的场景显示「未选表」，
        // 然后管理员一保存就把原有的表全清了。这是二次伤害，比读不出来更糟。
        setTableIdsState(Array.isArray(row.table_ids) ? row.table_ids : []);
        setSceneType((row.scene_type as SceneType) ?? 'table_match');
        setModuleKey(row.module_key ?? '');
        // `ui_config` 是 `{schema_version, params, fallback_text}`（后端 `ui_config`
        // 字段，刻意不冗余 module_key）。这里三个都要回填——只回填 params 会让
        // 「打开已有场景，兜底文本变空」然后一保存就把它清掉。
        setModuleParams(
          row.ui_config && typeof row.ui_config.params === 'object'
            ? { ...(row.ui_config.params as Record<string, unknown>) }
            : {},
        );
        setFallbackText(row.ui_config?.fallback_text ?? '');
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

  // 预览表变了就拉预览（需要列定义来配槽位）
  useEffect(() => {
    if (!previewTableId) {
      setTablePreview(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const preview = await getSceneTable(previewTableId, 20);
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
  }, [previewTableId]);

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
        {
          table_ids: tableIds,
          scene_type: sceneType,
          slots,
          respond_action: { mode: respondMode, template: respondTemplate },
        },
        columnKeys,
        // module 可以收紧档位（`travel.itinerary` 声明 required）。
        // 漏传的后果见 `tableCountWarnings` 调用点的注释 —— 三处必须同时传。
        selectedModuleMeta?.needs_table,
      ),
    [
      columnKeys,
      respondMode,
      respondTemplate,
      sceneType,
      selectedModuleMeta?.needs_table,
      slots,
      tableIds,
    ],
  );

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const preview = await importSceneTable(file);
      const table = preview.table;
      setLocalTables((current) => [table, ...current.filter((row) => row.id !== table.id)]);
      // 追加到已选列表末尾（不是替换）：多表场景要「再传一张」，
      // 替换会让刚配好的第一张表被悄悄踢掉。
      setTableIds((current) => (current.includes(table.id) ? current : [...current, table.id]));
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
      scene_type: sceneType,
      // 请求侧字段名是 `tables`（不是 `table_ids`）：写侧用「我提交的表清单」，
      // 读侧用「后端算给我的表清单」。两边名字不同是刻意的，见 api/scenes.ts。
      //
      // 更新时按 `tablesDirty` 条件展开：后端语义是「不传 = 不改，传 [] = 清空」。
      // 无条件带 `tables` 会让「只改个名字」也重提交表清单，而 `[]` 会被当成
      // 「把表全删了」——管理员上传的价目表就这么没了，界面还不报错。
      // 新建时必须带（`isNew` 为真），否则后端拿不到首张表。
      ...(isNew || tablesDirty ? { tables: tableIds } : {}),
      // module 身份必须发：不发等于「保存成功但消息 UI 一直是默认 module」。
      // `fallback_text` 进 ui_config，不进 module_config —— 前者是「渲染不出来给谁看」，
      // 后者是「module 自己的业务参数」，两者生命周期不同。
      module_key: moduleKey,
      module_config: moduleParams,
      ui_config: {
        schema_version: 1,
        params: moduleParams,
        fallback_text: fallbackText.trim(),
      },
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
    // 表数量阻断由 publishBlockers 内的 tableCountIssues 统一判，这里不再硬拦
    // 「必须先选表」——table_match 是 optional 档，先建后补表是合法路径。
    // 发布前必须过完整性检查；草稿允许半成品（用户就是要边配边存）
    if (targetStatus === 'published') {
      const issues = publishBlockers(
        {
          table_ids: tableIds,
          scene_type: sceneType,
          slots,
          respond_action: { mode: respondMode, template: respondTemplate },
        },
        columnKeys,
        selectedModuleMeta?.needs_table,
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
                {/*
                  场景类型：与名称同排（契约 §4 基础信息区块的 `row2`）。
                  选项文案 `中文 · type` 照抄 demo —— 只写中文会让人对不上
                  后端字段，只写英文则管理员看不懂。
                  切换它会收放「数据表 / 匹配策略 / 槽位」三个区块。
                */}
                <Field label="场景类型" required hint="决定这个场景怎么处理，建好后基本不改">
                  <select
                    value={sceneType}
                    onChange={(event) => {
                      setSceneType(event.target.value as SceneType);
                      // 切类型后旧的试跑结果不再有意义（换了处理通道）
                      setRunResult(null);
                    }}
                    className={`${INPUT_CLASS} w-[280px]`}
                  >
                    {SCENE_TYPES.map((type) => {
                      const meta = sceneTypeMeta(type);
                      return (
                        <option key={type} value={type}>
                          {`${meta.label} · ${type}`}
                        </option>
                      );
                    })}
                  </select>
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

              {/* 2 场景界面（选 module）—— 契约 §4.1 */}
              <Section index={2} title="场景界面" active={activeSection} onEnter={setActiveSection}>
                <p className="m-0 mb-[8px] text-[12px] leading-[18px] text-[#9a9b95]">
                  下面只列出<b>支持当前类型</b>的 module。选中后，消息里那块 UI 由它的代码决定。
                </p>
                {moduleMetasLoading ? (
                  <p className="m-0 text-[12px] text-[#9a9b95]">加载 module 目录…</p>
                ) : candidateModules.length === 0 ? (
                  // 空态要说清是「这个类型还没有 module」而不是「加载失败」——
                  // 两者的处置完全不同（前者去找开发加 module，后者刷新即可）。
                  <p className="m-0 rounded-[8px] bg-[#fff2e5] px-[10px] py-[8px] text-[12px] leading-[18px] text-[#b45309]">
                    还没有支持「{sceneTypeMeta(sceneType).label}」的 module。保存后消息里只会显示兜底文本。
                  </p>
                ) : (
                  candidateModules.map((meta) => {
                    const picked = meta.module_key === moduleKey;
                    return (
                      <button
                        key={meta.module_key}
                        type="button"
                        onClick={() => {
                          setModuleKey(meta.module_key);
                          // 换 module 后旧的参数不再对得上新的 params_schema，
                          // 保留会让「改文案不用发版」变成「改出一堆无效键」。
                          setModuleParams({});
                        }}
                        className={`mb-[7px] flex w-full gap-[10px] rounded-[10px] border px-[11px] py-[9px] text-left transition-colors ${
                          picked
                            ? 'border-[#0f766e] bg-[#e1f1ed]'
                            : 'border-[#ded7cc] bg-white hover:border-[#0f766e]'
                        }`}
                      >
                        <span
                          className={`mt-[2px] grid size-[13px] shrink-0 place-items-center rounded-full border-[1.5px] ${
                            picked ? 'border-[#0f766e]' : 'border-[#cfc5b7]'
                          }`}
                        >
                          {picked ? <span className="size-[6px] rounded-full bg-[#0f766e]" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-baseline gap-[6px]">
                            <span className="text-[12px] font-semibold text-[#18181a]">
                              {meta.display_name || meta.module_key}
                            </span>
                            <span className="font-mono text-[11px] text-[#9a9b95]">
                              {meta.module_key}
                            </span>
                          </span>
                          <span className="mt-[2px] block text-[11px] leading-[1.5] text-[#9a9b95]">
                            {meta.summary}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}

                {/* module 参数：由 params_schema 驱动，加新 module 时这里零改动 */}
                {selectedModuleMeta && selectedModuleMeta.params_schema.length > 0 && (
                  <div className="mt-[11px] border-t border-[#e7dfd3] pt-[11px]">
                    <p className="m-0 mb-[7px] text-[12px] font-semibold text-[#343633]">
                      这个 module 的参数
                      <span className="ml-[6px] font-normal text-[11px] text-[#9a9b95]">
                        改文案不用发版
                      </span>
                    </p>
                    {selectedModuleMeta.params_schema.map((field) => (
                      field.type === 'boolean' ? (
                        // 布尔项直接渲染成一行开关，不再套 Field —— 套了会出现
                        // 「label 一行、空 label 的开关又一行」，同一个参数两个标题。
                        <ToggleRow
                          key={field.key}
                          label={field.label}
                          hint=""
                          checked={Boolean(moduleParams[field.key] ?? field.default ?? false)}
                          onChange={(next) =>
                            setModuleParams((current) => ({ ...current, [field.key]: next }))
                          }
                        />
                      ) : (
                        <Field key={field.key} label={field.label}>
                          <input
                            value={String(moduleParams[field.key] ?? '')}
                            onChange={(event) =>
                              setModuleParams((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }))
                            }
                            placeholder={
                              field.type === 'column' ? field.help ?? '填写表列 key' : field.placeholder
                            }
                            className={INPUT_CLASS}
                          />
                        </Field>
                      )
                    ))}
                  </div>
                )}

                {/*
                  兜底文本：必填（契约 §4.2「兜底文本 显示（必填）」）。
                  这是 module chunk 加载失败 / 后端上了新 kind / 非 UI 渠道
                  三种情况下**唯一**还能给用户看的东西。不是可选项。
                */}
                <Field
                  label="兜底文本"
                  required
                  hint="UI 渲染不出来时用户看到的纯文本，别写「暂无数据」"
                >
                  <textarea
                    value={fallbackText}
                    onChange={(event) => setFallbackText(event.target.value)}
                    rows={2}
                    placeholder="例如：找到了合适的套餐，详情看上面的卡片"
                    className={cnTextarea}
                  />
                </Field>
              </Section>

              {/* 3 数据表 —— 按 scene_type 显隐（契约 §4.2：不渲染，不置灰） */}
              {sceneTypeMeta(sceneType).blocks.tables && (
                <Section index={3} title="数据表" active={activeSection} onEnter={setActiveSection}>
                  {/* 已选表按顺序列出：顺序即合并池的 order_index，
                      调整顺序会改变命中优先级，所以要让人看见并挪得动。 */}
                  {tableIds.length > 0 ? (
                    <ul className="m-0 mb-[10px] flex list-none flex-col gap-[6px] p-0">
                      {tableIds.map((id, index) => {
                        const table = localTables.find((row) => row.id === id);
                        return (
                          <li
                            key={id}
                            className="flex items-center gap-[8px] rounded-[8px] border border-[rgba(24,24,26,0.10)] bg-[#fbfaf6] px-[10px] py-[7px]"
                          >
                            <span className="grid size-[17px] shrink-0 place-items-center rounded-[5px] bg-[#e1f1ed] text-[10px] font-bold text-[#0f766e]">
                              {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#18181a]">
                              {table?.name ?? '表已删除'}
                              {table ? (
                                <span className="ml-[5px] text-[11px] text-[#9a9b95]">
                                  {table.row_count} 行
                                </span>
                              ) : null}
                            </span>
                            {/* 上移/下移：顺序有意义，但没有顺序就调不了优先级 */}
                            <button
                              type="button"
                              disabled={index === 0}
                              onClick={() =>
                                setTableIds((current) => {
                                  const next = [...current];
                                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                  return next;
                                })
                              }
                              className="rounded-[5px] px-[5px] py-[2px] text-[11px] text-[#6d6d72] hover:bg-[#eeece4] disabled:opacity-30"
                              aria-label="上移"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={index === tableIds.length - 1}
                              onClick={() =>
                                setTableIds((current) => {
                                  const next = [...current];
                                  [next[index], next[index + 1]] = [next[index + 1], next[index]];
                                  return next;
                                })
                              }
                              className="rounded-[5px] px-[5px] py-[2px] text-[11px] text-[#6d6d72] hover:bg-[#eeece4] disabled:opacity-30"
                              aria-label="下移"
                            >
                              ↓
                            </button>
                            {/* 移除只是从本场景解绑，不删表本身 —— 文案要说清，
                                否则管理员不敢点，怕把上传的数据删了。 */}
                            <button
                              type="button"
                              onClick={() => setTableIds((current) => current.filter((row) => row !== id))}
                              className="rounded-[5px] px-[5px] py-[2px] text-[11px] text-[#b45309] hover:bg-[#fff2e5]"
                              title="从本场景移除（不会删除表本身）"
                            >
                              移除
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="m-0 mb-[10px] rounded-[8px] bg-[#fbfaf6] px-[10px] py-[8px] text-[12px] leading-[18px] text-[#9a9b95]">
                      还没有配数据表。这个类型可以先建好再补表。
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-[10px]">
                    <select
                      value=""
                      onChange={(event) => {
                        const id = event.target.value;
                        if (!id) return;
                        // 追加到末尾，不替换已有选择。
                        setTableIds((current) => (current.includes(id) ? current : [...current, id]));
                        setRunResult(null);
                      }}
                      className={`${INPUT_CLASS} w-[280px]`}
                    >
                      <option value="">＋ 添加已有数据表</option>
                      {localTables
                        .filter((table) => !tableIds.includes(table.id))
                        .map((table) => (
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
                    <span className="text-[11px] text-[#9a9b95]">
                      {tableIds.length > 0 ? `已配 ${tableIds.length} 张表` : '尚未配数据表'}
                    </span>
                  </div>

                  {/* 表数量提示（不阻断）。**不要**渲染成红色错误样式 ——
                      table_match 缺表只是建议，不拦发布。

                      ⚠️ 第三个参数 `moduleNeeds` 必须与上面两处 `publishBlockers`
                      同时传。漏一处的表现是「提示说没事、保存却 400」，比全都不传
                      更难查：因为 warning 说可以、按钮却报错，用户会以为界面坏了。 */}
                  {tableCountWarnings(sceneType, tableIds.length, selectedModuleMeta?.needs_table).map((text) => (
                    <p
                      key={text}
                      className="m-0 mt-[8px] text-[12px] leading-[18px] text-[#b45309]"
                    >
                      {text}
                    </p>
                  ))}

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
              )}

              {/* 3 触发条件 */}
              <Section index={4} title="触发条件" active={activeSection} onEnter={setActiveSection}>
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
              <Section index={5} title="槽位（要问用户什么）" active={activeSection} onEnter={setActiveSection}>
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
              <Section index={6} title="匹配策略" active={activeSection} onEnter={setActiveSection}>
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
              <Section index={7} title="命中后回答" active={activeSection} onEnter={setActiveSection}>
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
              <Section index={8} title="绑定员工" active={activeSection} onEnter={setActiveSection}>
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