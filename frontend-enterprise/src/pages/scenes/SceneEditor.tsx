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
  getScenePresetDefaults,
  getSceneTable,
  importSceneTable,
  listScenePresetOptions,
  runScene,
  updateScene,
  type SceneMatchAction,
  type SceneRunResult,
  type SceneSlot,
  type SceneStatus,
  type SceneTablePreview,
  type SceneTableRead,
  type SceneTrigger,
  type ScenePresetOption,
} from '../../api/scenes';
import type { SceneType } from '@/scenes/types';
import { sceneTypeMeta, tableCountWarnings } from '@/scenes/types';
import ScenePreviewCard from './ScenePreviewCard';
import {
  SCENE_BTN_PRIMARY,
  SCENE_BTN_PRIMARY_SM,
  SCENE_BTN_SECONDARY,
  SCENE_BTN_SM,
  SCENE_FORM_SECTION,
  SCENE_FORM_SECTION_HEAD,
  SCENE_FORM_SECTION_N,
  SCENE_FORM_SECTION_NOTE,
  SCENE_INPUT,
  SCENE_TEXTAREA,
} from './sceneUi';
import { metaForModule, useSceneModuleCatalog } from '@/scenes/registry';
import {
  checkSlotMappings,
  explainRunResult,
  hitRatioText,
  parseSlotInput,
  publishBlockers,
  qualityLevelText,
  splitQuality,
  statusMeta,
  visibleSteps,
} from './sceneUtils';

/**
 * 场景定义器（**用户视角**，不是开发者视角）。
 *
 * ## 三层分层：这里只让用户填「他自己的东西」
 *
 * | 层 | 谁定 | 在这页里 |
 * |---|---|---|
 * | L1 module 实现 | 开发者写代码 | 看不见 |
 * | L2 预设 | 超管在 `/enterprise/scene-presets` 改 | **看不见**，但决定默认值 |
 * | L3 场景实例 | 用户 | 名称 / 图标 / 描述 / 槽位 / 匹配策略 |
 *
 * 所以这页只有五个区块：
 *
 * 1. 基础信息 —— 场景名称、类型下拉（数据来自预设，目前只有「行程规划」）、
 *    图标下拉（选项来自预设）、描述
 * 2. 数据表 —— 按类型的 `needs_table` 显隐（`travel.itinerary` 是 required）
 * 3. 槽位 —— 保留可改（换表后列名不同必须能重新映射）
 * 4. 匹配策略 —— 保留可改（初始值来自预设）
 * 5. 命中后回答 —— **只读预览**，用真实的 module 卡片渲染，不可配
 *
 * ## 被刻意拿掉的四个区块
 *
 * | 原区块 | 去哪了 | 为什么 |
 * |---|---|---|
 * | 2 场景界面（选 module + 参数） | 预设页 | 用户不该选 module —— 类型下拉已经定了它 |
 * | 触发条件 | 预设页 | 固定「按钮触发 + 跳过意图路由」，配错只会让场景不响应 |
 * | 7 命中后回答（回答方式/模板/按钮动作） | 预设页 | 回答长什么样由 module 的代码决定 |
 * | 8 绑定员工 | 员工档案页 | 建场景的地方不是挂场景的地方，双入口会让人以为要建两次 |
 *
 * 「不渲染」而不是「置灰」：这些项用户永远改不了（改在预设页），
 * 置灰会让他以为以后能开。这是契约 §4.2 的硬要求。
 *
 * 试跑面板固定在右侧 —— 没有试跑，调匹配策略就是盲调。
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
  /**
   * 触发条件：**用户不能改**（固定按钮触发 + 跳过意图路由）。
   *
   * 保留这个 state 只为两件事：把预设里的值原样回写给后端（存量场景可能存过
   * 关键词，不能因为「这页不展示」就把它抹掉），以及新建时用预设的默认值。
   * 页面上没有任何输入控件绑它。
   */
  const [trigger, setTrigger] = useState<SceneTrigger>({ ...DEFAULT_TRIGGER });
  const [slots, setSlots] = useState<SceneSlot[]>([]);
  const [matchAction, setMatchAction] = useState<SceneMatchAction>({ ...DEFAULT_MATCH_ACTION });
  /**
   * 回答方式：**用户不能改**，恒为 `template`，且模板由预设/module 决定。
   *
   * 为什么不再让用户选：回答长什么样由 module 的 UI 代码画（`travel.itinerary`
   * 是逐日时间轴卡），「回答方式」这个开关在 v3 里已被 module 取代。
   * 留 `template` 是为了兼容后端 `publishBlockers` 的「模板不能为空」校验
   * —— 但这里的 template 不再由用户填，见 `respondTemplate` 的赋值处。
   */
  const respondMode = 'template' as const;
  /** 预设里的回答模板（用户不可见、不可改）。空 = 后端按命中行拼一句话。 */
  const [respondTemplate, setRespondTemplate] = useState('');

  /**
   * 「表单引导语」—— 点开胶囊后，**表格上方**那句话（用户可改）。
   *
   * 为什么把它留给员工而不是超管的预设：这句话说的是「为什么现在要问你」，
   * 内容取决于这个场景要解决的事（「先确认三个条件，我按方案表逐层筛」）。
   * 超管不知道员工给场景起了什么名字、面向谁；同一套预设下的两个场景，
   * 这句引导语本来就该不一样。
   *
   * 存 `respond_action.ask_prompt`（不是 `ui_config`）：
   * - `ui_config` 里放的是「渲染成什么样」（标题、副标题、module 参数），
   *   `effective_ui_config()` 会让预设覆盖本地的非空值 —— 员工改的被抹掉；
   * - `respond_action` 是场景实例自己的回答策略（`intro` / `max_items` 也在这），
   *   后端 `_run_table_match` 直接读 `scene.respond_action_json`，不经过预设合并。
   *
   * 空串 = 用后端的类型默认句，不是「不显示引导语」。后端在 `ask_prompt` 为空时
   * 会补默认句（`channels.py::_run_table_match`），这样老场景也不会退化成一上来
   * 就一张光秃秃的表格。
   */
  const [askPrompt, setAskPrompt] = useState('');
  /**
   * 「表单副标题」—— 卡头标题下面那句短说明（用户可改）。
   *
   * 存 `ui_config.form_subtitle`（不是 `respond_action`）：它是**卡片自己的一部分**，
   * 跟着 `form` 块的 `data` 下发，和 `form_title` 是一对。放一起才对得上
   * 「卡头 = 图标 + 标题 + 副标题」这个结构。
   *
   * ⚠️ 它走 `effective_ui_config()` 的按键合并，**清空不等于没有**：该函数
   * 只让非空值覆盖，所以这里填空串时会回落到管理员预设的预填值（再退到默认句）。
   * 想彻底去掉这句话只能让超管把预设里的这句也清掉。输入框的 hint 已按这个
   * 语义写，不要改成「留空用默认句」——那会让员工以为能自己抹掉它。
   */
  const [formSubtitle, setFormSubtitle] = useState('');

  /**
   * 场景类型。决定「数据表 / 匹配策略 / 槽位」三个区块显不显（契约 §4.2）。
   *
   * 显隐必须是**不渲染**而不是置灰：类型创建后基本不变，置灰会让管理员
   * 以为「以后能开」，而实际上永远开不了。这是 demo 与实现唯一刻意不同处。
   */
  const [sceneType, setSceneType] = useState<SceneType>('table_match');
  /**
   * 用哪个前端 module 来画这块 UI。
   *
   * **用户不选它**：选了「行程规划」这个类型，就等于选了 `travel.itinerary`
   * 这个 module（映射来自预设的 `scene_type` + 预设的 `module_key`）。
   * 保留 state 是因为保存时要把它发给后端，且编辑存量场景时要回填。
   */
  const [moduleKey, setModuleKey] = useState('');
  /**
   * module 私有参数：**用户不能改**，只在保存时原样回写（避免把超管配的值抹掉）。
   *
   * 真正的参数在预设表里，渲染时实时继承（见 `app/scenes/presets.py`）。
   * 这页不再渲染任何参数输入框 —— 这是本次改造最核心的一条。
   */
  const [moduleParams, setModuleParams] = useState<Record<string, unknown>>({});
  /** UI 渲染不出来时的纯文本兜底。**必填**，但用户不填（来自预设）。 */
  const [fallbackText, setFallbackText] = useState('');

  /**
   * 预设下拉选项（「场景类型」那一栏的数据源）。
   *
   * 只列 `enabled=true` 的预设 —— 停用的预设不该出现在新建入口。
   * 拉不到时退化成空数组，页面会提示「还没有可用的场景类型」而不是白屏。
   */
  const [presetOptions, setPresetOptions] = useState<ScenePresetOption[]>([]);
  const [presetLoading, setPresetLoading] = useState(true);

  /**
   * 定义器里的 module 目录。会拉下每个 module 的 chunk —— 只在管理页面发生，
   * 聊天端不走这条路径（见 `registry.ts` 的 `loadSceneModuleCatalog` 注释）。
   */
  const { metas: moduleMetas } = useSceneModuleCatalog();
  const selectedModuleMeta = useMemo(
    () => metaForModule(moduleMetas, moduleKey),
    [moduleMetas, moduleKey],
  );

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

  /**
   * 当前选中预设的展示名（「行程规划」）。空则回落到类型标签。
   *
   * 用它而不是 `sceneTypeMeta(sceneType).label`（「查表推荐」）：用户看到的是
   * 「行程规划」，你给他显示「查表推荐」他会以为选错了。
   */
  const currentPresetName = useMemo(() => {
    const hit = presetOptions.find((item) => item.module_key === moduleKey);
    return hit?.display_name ?? '';
  }, [moduleKey, presetOptions]);

  /**
   * 图标下拉的选项。
   *
   * 三级合并：当前预设的 `icons` → 全部预设的图标并集 → 一个写死的兜底集。
   * 为什么要并集：用户在两个预设之间切换过、或换过场景类型时，旧的 icon
   * 可能不在新预设的清单里。只列新预设的图标会让 `<select>` 显示成第一项，
   * 而 state 还是旧值 —— 看起来改了、保存却没改。
   */
  const activeIcons = useMemo(() => {
    const own = presetOptions.find((item) => item.module_key === moduleKey)?.icons ?? [];
    const all = presetOptions.flatMap((item) => item.icons);
    const merged = [...own, ...all, ...FALLBACK_ICONS];
    const unique = Array.from(new Set(merged.filter(Boolean)));
    // 当前值必须能选中，否则 select 会「显示第一项但实际不是它」
    if (icon && !unique.includes(icon)) unique.unshift(icon);
    return unique;
  }, [icon, moduleKey, presetOptions]);

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
        // 卡头副标题也要回填，理由同上一行：漏了就「打开已有场景 → 副标题变空
        // → 一保存就把它清掉」。它和 `fallback_text` / `form_title` 同级。
        setFormSubtitle(String(row.ui_config?.form_subtitle ?? ''));
        setTrigger({ ...DEFAULT_TRIGGER, ...row.trigger });
        setSlots(row.slots ?? []);
        setMatchAction({ ...DEFAULT_MATCH_ACTION, ...row.match_action });
        // 回答模板原样回填：用户看不到它，但保存时必须带回去，
        // 否则「打开老场景 → 只改个名字 → 保存」会把预设/历史的模板清空。
        // `respondMode` 恒为 template（常量），不需要 setter。
        setRespondTemplate(row.respond_action?.template ?? '');
        // 引导语同理：`respond_action` 在保存时是**整份覆盖**写回的
        // （后端 `if payload.respond_action is not None: row.respond_action_json = payload.respond_action`），
        // 不回填 + 不带回去 = 每次保存都清空员工配的引导语。
        setAskPrompt(row.respond_action?.ask_prompt ?? '');
        // `shortcut` / `agent_ids` 仍由后端持有，但这页不再展示：
        // - `shortcut`（按钮动作）由预设决定，保存时不回写（见 toPayload）
        // - 绑定员工在员工档案页管，这页不回写 `agent_ids`
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

  // 预设下拉选项（这一页唯一的「场景类型」来源）。
  //
  // 不需要管理员权限：普通用户在员工档案里建场景时也要能选类型。
  // 拉不到时只提示、不抛错 —— 类型下拉变空，页面照常可用（只是没法新建）。
  useEffect(() => {
    let alive = true;
    setPresetLoading(true);
    void (async () => {
      try {
        const rows = await listScenePresetOptions();
        if (!alive) return;
        setPresetOptions(Array.isArray(rows) ? rows : []);
      } catch {
        if (alive) setPresetOptions([]);
      } finally {
        if (alive) setPresetLoading(false);
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

  /**
   * 选中某个预设类型：把它的默认值铺到表单上。
   *
   * ## 为什么必须是一次「整份套用」而不是逐个字段 if
   *
   * 切类型意味着换了一个完全不同的处理通道（`travel.itinerary` 要表、
   * `generic.script` 不要表），逐字段判断会留下「上一个类型的槽位」「上一个
   * 类型的匹配策略」这种杂交状态，而它们在新类型下可能完全不成立。
   *
   * ## 哪些字段会覆盖用户已经填的
   *
   * - `module_key` / `scene_type` / `ui_config` / `fallbackText` / `trigger`：
   *   **一定覆盖**（这些用户本来就改不了，是预设说了算的）
   * - `icon` / `description` / `slots` / `matchAction`：**只在还没填过时填**
   *   （空串 / 空数组才用默认值），避免用户填一半切类型就被清空
   * - 名称 `name`：**从不覆盖** —— 用户可能已经想好了名字
   */
  const applyPreset = useCallback(async (option: ScenePresetOption) => {
    setModuleKey(option.module_key);
    setSceneType((option.scene_type as SceneType) || 'table_match');
    // 切类型后旧的试跑结果不再有意义（换了处理通道）
    setRunResult(null);

    // 先落已知的轻量值，让界面立刻有反馈（默认值请求可能慢一秒）
    setIcon((current) => current || option.icon || '');
    setDescription((current) => current || option.description || '');

    try {
      const defaults = await getScenePresetDefaults(option.module_key);
      const uiConfig = (defaults.ui_config ?? {}) as Record<string, unknown>;
      const params = (uiConfig.params ?? {}) as Record<string, unknown>;
      setModuleParams({ ...params });
      setFallbackText(String(uiConfig.fallback_text ?? ''));
      // 卡头副标题来自预设（员工改过就不覆盖 —— 切类型是「换玩法」，
      // 但文案是员工自己斟酌过的，清掉比留着更烦）。
      setFormSubtitle((current) => current || String(uiConfig.form_subtitle ?? ''));
      setTrigger({ ...DEFAULT_TRIGGER, ...(defaults.trigger as Partial<SceneTrigger>) });
      // 回答模板来自预设（用户不可见）。`intro` 之类后端会自己兜。
      setRespondTemplate(String((defaults as Record<string, unknown>).respond_template ?? ''));
      // 引导语：预设给建议值，员工手写的不覆盖（同上一条的理由）。
      //
      // 读 `defaults.respond_action.ask_prompt`（后端 `initial_scene_fields()`
      // 原样透传预设的 `respond_action`）—— 不读顶层键，因为**保存时也写在这里**，
      // 路径不一致就会出现「预填读得到、保存写丢了」。
      const presetRespond = (defaults.respond_action ?? {}) as Record<string, unknown>;
      setAskPrompt((current) => current || String(presetRespond.ask_prompt ?? ''));

      // 槽位：只在空的时候用预设的（用户可能已经按自己的表头映射过）
      setSlots((current) => (current.length > 0 ? current : (defaults.slots ?? [])));
      // 匹配策略：整份套用预设值。
      //
      // 为什么不做「保留用户改过的键」：`current` 初值就是 DEFAULT_MATCH_ACTION，
      // 与「用户手动改过」在类型上无法区分 —— 想做保留就必须额外存一份
      // 「哪些键被动过」的脏标记，而切类型后旧标记又没有意义。
      // 切类型本来就是「换一套玩法」，整份重置比杂交状态更可预期。
      setMatchAction({
        ...DEFAULT_MATCH_ACTION,
        ...(defaults.match_action as Partial<SceneMatchAction>),
      });
      // 图标：如果之前是空的，用预设默认
      setIcon((current) => current || String(defaults.icon ?? ''));
      setDescription((current) => current || String(defaults.description ?? ''));
    } catch (error) {
      // 默认值拉不到不阻塞：类型/名称已经落下了，用户可以手工补
      notify.error(error instanceof Error ? error.message : '读取场景默认值失败');
    }
  }, []);

  // 新建场景：预设选项到达后自动选中第一个 —— 让用户一打开就看到一张填好的表单
  useEffect(() => {
    if (!isNew) return;
    if (presetLoading) return;
    if (moduleKey) return;
    const first = presetOptions[0];
    if (!first) return;
    void applyPreset(first);
  }, [applyPreset, isNew, moduleKey, presetLoading, presetOptions]);

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
      //
      // ⚠️ `module_key` / `ui_config` / `trigger` 这三项**用户改不了**（页面上
      // 没有对应控件），它们在这里原样回写只为一件事：**不覆盖超管在预设页
      // 配的值**。真正生效的值在渲染时由 `app/scenes/presets.py` 实时合并，
      // 这里写什么都会被预设覆盖掉「没显式配的键」。
      module_key: moduleKey,
      module_config: moduleParams,
      ui_config: {
        schema_version: 1,
        params: moduleParams,
        fallback_text: fallbackText.trim(),
        // 卡头副标题：空串也发。后端 `_slot_form_block` 对空值走默认句兜底，
        // 所以「清空」是有意义的状态（= 用默认句），不能靠「不传」表达 ——
        // 不传等于保留上一次的值，员工就清不掉了。
        form_subtitle: formSubtitle.trim(),
      },
      status,
      trigger,
      slots,
      match_action: matchAction,
      respond_action: {
        mode: respondMode,
        template: respondTemplate,
        max_items: matchAction.top_k,
        // 引导语：同上，空串 = 用后端默认句。
        ask_prompt: askPrompt.trim(),
      },
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
      // 绑定走 `agent_id`（新建时带上传入的那个员工）。这页**不再有绑定区块**：
      // 场景挂在哪个员工上由员工档案页管，建场景的地方不是挂场景的地方。
      // `defaultAgentId` 是宿主页（员工档案）传进来的「在谁名下新建」，不是用户选的。
      // 返回值不用：保存成功后由 `onSaved()` 让宿主页重拉列表。
      if (isNew) {
        await createScene({ ...payload, agent_id: defaultAgentId ?? null });
      } else {
        await updateScene(sceneId, payload);
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
              className={SCENE_BTN_SECONDARY}
            >
              {saving ? '保存中…' : '保存草稿'}
            </button>
            <button
              disabled={saving}
              onClick={() => void save('published')}
              title={blockers.length > 0 ? blockers.join('；') : undefined}
              className={SCENE_BTN_PRIMARY}
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
              <Section index={1} title="基础信息" note="这些都能改" active={activeSection} onEnter={setActiveSection}>
                <Field label="场景名称" required hint="在员工档案和聊天按钮上显示">
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：滑雪行程推荐"
                    className={INPUT_CLASS}
                  />
                </Field>
                {/*
                  场景类型：**下拉，选项来自预设**（不是写死的 SCENE_TYPES）。

                  这是本次简化的核心：用户不需要知道「table_match / sop_flow」
                  这些后端枚举，他只看到「行程规划」这种人话。选了它就等于
                  选定了 module（映射关系在预设里，见 scene_presets 表）。

                  切换会整份套用该预设的默认值（`applyPreset`）——
                  用户只需在此基础上改名称/图标/描述。
                */}
                <Field label="场景类型" required hint="决定这个场景能做什么，由管理员预设">
                  {presetLoading ? (
                    <span className="text-[12px] text-[#9a9b95]">加载场景类型…</span>
                  ) : presetOptions.length === 0 ? (
                    // 空态要说清是「管理员还没配类型」而不是「加载失败」——
                    // 两者处置完全不同（前者找管理员，后者刷新即可）。
                    <span className="rounded-[8px] bg-[#fff2e5] px-[10px] py-[6px] text-[12px] leading-[18px] text-[#b45309]">
                      还没有可用的场景类型，请联系管理员在「场景预设」里配置。
                    </span>
                  ) : (
                    <select
                      value={moduleKey}
                      onChange={(event) => {
                        const option = presetOptions.find(
                          (item) => item.module_key === event.target.value,
                        );
                        if (option) void applyPreset(option);
                      }}
                      className={`${INPUT_CLASS} w-[320px]`}
                    >
                      {/* 存量场景的 module 可能已从预设里停用/删除。此时不能
                          悄悄回落到第一项 —— 一保存就把场景换了个 module，
                          用户看到的界面会莫名其妙全变。所以补一个只读占位项。 */}
                      {moduleKey && !presetOptions.some((item) => item.module_key === moduleKey) && (
                        <option value={moduleKey}>{`${moduleKey}（已停用）`}</option>
                      )}
                      {presetOptions.map((option) => (
                        <option key={option.module_key} value={option.module_key}>
                          {`${option.icon ? `${option.icon} ` : ''}${option.display_name}`}
                        </option>
                      ))}
                    </select>
                  )}
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
                {/*
                  图标：**下拉**（选项来自预设的 `icons`）。

                  原先是自由输入框，用户能填任何东西（包括三个 emoji、一段文字、
                  或者空）。下拉把「能填什么」限死，视觉一致性由预设保证。
                  当前值不在选项里时补一个占位项，否则 select 会显示成第一项而
                  实际 state 还是旧值 —— 看起来改了、保存却没改。
                */}
                <Field label="图标" hint="显示在聊天按钮和员工档案上">
                  <IconPicker value={icon} options={activeIcons} onChange={setIcon} />
                </Field>
                {/*
                  两句文案：**引导语**（表格上方）与**副标题**（卡片头里）。

                  为什么不放进「命中后回答」区块：那一块是**只读预览**（卡长什么样
                  由 module 代码决定）。这两句不是「命中后」的文案 —— 它们在用户
                  **还没填**的时候出现，属于「问问题的方式」，是员工能自己斟酌的
                  唯一一段话（超管不知道这个场景面向谁）。

                  两个输入框排在一起是有意的：它们同屏出现、前后脚被读到，
                  分开放会让人只改其中一个，然后奇怪「为什么卡片没变」。
                */}
                <Field
                  label="表单引导语"
                  hint="用户点进来后、表格上方那句话；留空用默认句"
                >
                  <textarea
                    value={askPrompt}
                    onChange={(event) => setAskPrompt(event.target.value)}
                    rows={2}
                    maxLength={200}
                    placeholder="例如：先确认三个条件，我按人数 → 天数 → 预算逐层筛方案表。"
                    className={cnTextarea}
                  />
                </Field>
                <Field
                  label="表单副标题"
                  hint="卡片标题下那句短说明；留空则跟随管理员预设（再退到默认句）"
                >
                  <input
                    value={formSubtitle}
                    onChange={(event) => setFormSubtitle(event.target.value)}
                    maxLength={60}
                    placeholder="例如：填好这三项，我按方案表逐条比对"
                    className={INPUT_CLASS}
                  />
                </Field>
              </Section>

              {/* 2 数据表 —— 按 scene_type 显隐（契约 §4.2：不渲染，不置灰）。
                  原「场景界面」区块已并入「场景类型」下拉：module 由预设决定，
                  参数在超管预设页配，用户不选也不填。 */}
              {sceneTypeMeta(sceneType).blocks.tables && (
                <Section index={2} title="数据表" active={activeSection} onEnter={setActiveSection}>
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
                    {/* 用 `<label>` 包 `<input type="file">`：原生文件框没法改样式，
                        隐藏它、把 label 画成按钮是唯一干净的做法。
                        视觉必须与 `SCENE_BTN_SM` 一致 —— 它下面就是「按表头自动映射」
                        这类同级别按钮，差 1px 内边距就看得出来。 */}
                    <label className={`${SCENE_BTN_SM} cursor-pointer`}>
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

              <Section index={3} title="槽位（要问用户什么）" active={activeSection} onEnter={setActiveSection}>
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
                    className={SCENE_BTN_SM}
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
                    className={SCENE_BTN_SM}
                  >
                    ＋ 添加槽位
                  </button>
                </div>
              </Section>

              {/* 5 匹配策略 */}
              <Section index={4} title="匹配策略" active={activeSection} onEnter={setActiveSection}>
                <div className="grid grid-cols-2 gap-[12px]">
                  <NumberField
                    label="天数容差（天）"
                    hint="用户说 5 天，4 天和 6 天的行也算命中"
                    value={matchAction.days_tolerance}
                    onChange={(v) => setMatchAction({ ...matchAction, days_tolerance: v })}
                  />
                  <NumberField
                    label="人数容差（人）"
                    hint="0 = 必须人数完全一致；填 1 则 3 人需求会带出 4 人方案（会在回答里注明）"
                    value={matchAction.people_tolerance}
                    onChange={(v) => setMatchAction({ ...matchAction, people_tolerance: v })}
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
                    <option value="none">只说明没有结果</option>
                  </select>
                </Field>
                <ToggleRow
                  label="用决策模型辅助排序"
                  hint="开启后规则分与模型置信度融合；模型不可用时自动退回纯规则"
                  checked={matchAction.use_decision_model}
                  onChange={(next) => setMatchAction({ ...matchAction, use_decision_model: next })}
                />
              </Section>

              {/* 4 命中后回答（只读预览）—— 用户不可配，样式由 module 代码决定 */}
              <Section index={5} title="命中后回答" active={activeSection} onEnter={setActiveSection}>
                <p className="m-0 text-[12px] leading-[18px] text-[#9a9b95]">
                  用户命中后会看到这样一张卡。样式由「{currentPresetName || sceneTypeMeta(sceneType).label}」这个场景
                  类型的代码决定，不需要配置；想改文案或按钮，请管理员在「场景预设」里调。
                </p>
                <ScenePreviewCard moduleKey={moduleKey} />
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
                  className={`ml-auto ${SCENE_BTN_PRIMARY_SM}`}
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

/** 图标兜底集：预设没配 `icons` 时也要能选，不能给用户一个空下拉。 */
const FALLBACK_ICONS = ['🎿', '🏔️', '🗺️', '✈️', '🧳', '📊', '🧭', '💬'];

/**
 * 图标下拉。
 *
 * 不用自由输入框（改造前的做法）：用户能填「🎿🏔️」三个 emoji、或一段文字、
 * 或留空，视觉上完全失控。下拉把可选集限死，一致性由预设保证。
 *
 * 用原生 `<select>` 而不是自绘：emoji 在原生下拉里能正常渲染，自绘要处理
 * 定位/键盘/无障碍三件事，收益只有「好看一点」——这里不值得。
 */
function IconPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-[8px]">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="场景图标"
        className={`${INPUT_CLASS} w-[120px]`}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {/* 大号预览：下拉里 emoji 很小，选完不确认一下很容易挑错 */}
      <span
        className="grid size-[32px] shrink-0 place-items-center rounded-[8px] border border-[rgba(24,24,26,0.10)] bg-[#fbfaf6] text-[18px]"
        aria-hidden
      >
        {value || '—'}
      </span>
    </div>
  );
}

/*
 * `INPUT_CLASS` / `cnTextarea` 曾在这里各写一份（圆角 8、边框 rgba(24,24,26,0.14)），
 * 与 `sceneUi.SCENE_INPUT` / `SCENE_TEXTAREA`（边框 #cfc5b7）是同一类控件的两份实现。
 * 两者**肉眼几乎看不出差别**，所以长期没人发现 —— 但它们在颜色上是分开维护的：
 * 改一处、另一处不动，就成了「同一个输入框在两个页面里颜色不一样」。
 * 现在统一走 `sceneUi`，这里只保留别名指向，避免调用点全改一遍。
 */
const INPUT_CLASS = SCENE_INPUT;
const cnTextarea = SCENE_TEXTAREA;

function Section({
  index,
  title,
  note,
  active,
  onEnter,
  children,
}: {
  index: number;
  title: string;
  /** 标题右侧的旁注（demo `.section-note`，如「这些都能改」）。 */
  note?: string;
  active: number;
  onEnter: (index: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={SCENE_FORM_SECTION}
      onFocusCapture={() => onEnter(index)}
      data-active={active === index || undefined}
    >
      <h3 className={SCENE_FORM_SECTION_HEAD}>
        <span className={SCENE_FORM_SECTION_N}>{index}</span>
        {title}
        {note ? <span className={SCENE_FORM_SECTION_NOTE}>{note}</span> : null}
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