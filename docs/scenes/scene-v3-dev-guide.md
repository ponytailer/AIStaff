# 场景开发手册（Scene Developer Guide）

> **这份文档解决一个问题：以后要加一个新场景 / 新 module / 新处理类型时，照着做就能做完，不用先读三份设计文档、不用问人。**
>
> 它同时给人看和给 AI 看。给 AI 看的部分是**硬约束、清单、验收命令** —— 那些是可机械执行的；给人看的部分是**为什么**（每条约束都跟了一句「不做会怎样」）。
>
> | 项 | 值 |
> |---|---|
> | 适用版本 | 场景 v3（插件模块模型，commit `bb79071c` 之后） |
> | 代码基线 | `backend/app/scene_modules/`、`frontend-enterprise/src/scenes/` |
> | 同步要求 | **这份文档必须跟着代码走。** 改了 `types.py` / `types.ts` / `constants.py` 的契约 → 当次改动里必须一起改本文，见 §9 |

---

## 0. 先读这一节（3 分钟）

### 0.1 场景是什么

一句话：**场景 = 一段带专属 UI 的处理逻辑，挂在员工身上，员工就获得了这个能力。**

```
管理员写前端 module 代码 ──┐
                          ├──> 场景实例（一条 DB 记录）──> 绑定到员工 ──> 用户对话里触发
管理员在定义器里装配参数 ──┘
```

三层角色，别搞混：

| 角色 | 做什么 | 碰代码吗 |
|---|---|---|
| **平台开发**（你） | 新增处理类型、新增 module、改契约 | 是 |
| **管理员** | 在定义器里建场景实例、选 module、配参数、传表 | 否，只点界面 |
| **终端用户** | 在对话里用，无感知 | 否 |

### 0.2 四个概念，一次说清

| 概念 | 是什么 | 在哪 |
|---|---|---|
| **scene_type** | 处理逻辑的类型，**固定 4 个**：`table_match` / `sop_flow` / `handoff` / `script` | 后端 `types.py`、枚举 |
| **module** | 前端渲染代码，一个目录。决定「消息里那块 UI 长什么样」 | 前端 `src/scenes/modules/<module_key>/` |
| **场景实例** | DB 里一条 `Scene` 记录：选了哪个类型、哪个 module、哪些参数、哪些表 | 后端 `Scene` 表 |
| **block** | 后端产出的一块 UI 描述：`kind` + `data`。**只说「发生了什么」，不说「怎么画」** | 后端 `SceneUiBlock` |

**关键分工：`scene_type` 决定「后端怎么处理」，`module_key` 决定「前端怎么画」。两者独立。**

一个 `table_match` 场景可以用 `generic.table_match`（通用列表），也可以换成 `travel.itinerary`（逐日时间轴）—— 后端完全不用改。

### 0.3 三条铁律

> **① 后端只产出语义，不产出 UI 描述。**
> `SceneUiBlock` **不许有** `title` / `color` / `layout` / `primary_action` / `detail_fields`。一旦加了，整个方案就退回「配置驱动」，前端 module 的定制能力被后端锁死。
>
> **② module 目录名必须 === `meta.module_key`。**
> 注册表用 `import.meta.glob` 按目录名建映射。不一致的症状：后端能存、胶囊能返回、点击能触发，**但消息里那块 UI 永久降级成纯文本，不报错、不打日志**。这是本项目最难自查的失败。
>
> **③ 表数量档位只有一个字段：`needs_table`（三档）。**
> 不许出现 `table_range` / `min_tables`。历史上并存过，结果是「一侧读到 `undefined` 被静默当成不用表」→ `table_match` 的数据表区块整块不渲染、且不报错。

### 0.4 一个 module 从写完到能用，经过什么

**必须清楚这一点，否则会误判「可插拔」的含义：**

```
你写 module 目录 ──> 前端重新构建（vite）──> 发布新前端 ──> 管理员才能在定义器里选到它
                                              ↑
                        glob 是**构建期**展开的，不是运行期读目录
```

所以：

| 问题 | 答案 |
|---|---|
| 加 module 要改后端吗 | **不要**。后端只认 `module_key` 字符串，不校验它是否存在 |
| 加 module 要重启后端吗 | **不要** |
| 加 module 要重新构建前端吗 | **要**（`import.meta.glob` 在 build 时展开） |
| 管理员能自己加 module 吗 | **不能**。这是平台开发的活，管理员只能「选已发布的 module、配参数、传表」 |
| 那「可插拔」体现在哪 | 体现在**后端零改动**：同一份后端可以搭配任意 module 集合，新增场景能力不触碰业务逻辑 |

**灰度是必然态，不是异常。** 后端可能先拿到一个前端还不认识的 `module_key`（前端未发布/发布中）。这时 `SceneBlockList` 会渲染降级卡而不是白屏 —— 这是刻意设计，别把它当 bug 修掉。

### 0.5 当前实现状态（动手前先看这一节）

> 这一节是**唯一会随时过期的**部分，但它必须存在 —— 没有它，你无法区分「这个能力还没做」和「这个能力坏了」。

| 能力 | 后端 | 前端代码 | 已挂载到界面 | 有测试 |
|---|---|---|---|---|
| 4 个 generic module + `travel.itinerary` | — | ✅ 完成 | ✅ 经 `SceneBlockList` 渲染 | ✅ `constants.test.ts` / `SceneBlockList.test.tsx` |
| 场景管理台（列表 + 定义器 8 区块） | ✅ | ✅ 完成 | ✅ `/enterprise/scenes` 路由 | ✅ `ScenesPage.test.tsx` |
| 定义器试跑面板 | ✅ `/run` | ✅ 完成（在 `ScenesPage` 内） | ✅ | ✅ `SceneRunPanel.test.tsx` |
| 会话内触发（消息 → 场景帧 → block 回显） | ✅ | — | ✅ `MessageBubble` → `SceneBlockList` | ✅ `test_scene_api.py` |
| **入口胶囊 `SceneChips.tsx`** | ✅ `GET /api/chat/scenes` | ✅ **组件已写完** | ⚠️ **未挂载**：全库无 import，`Composer` 只渲染 `ChatPromptSuggestions` | ❌ 无测试 |
| `execution_mode="scene_module"` 直通 | ✅ 四处白名单齐 | — | ✅ | ✅ |

**关于入口胶囊这条 ⚠️**：`SceneChips.tsx` 的取数、`MAX_VISIBLE_SCENE_CHIPS`、「更多」折叠、视觉契约都已实现，`SceneChip` 类型也齐。**唯一缺的是在 `Composer` 里 import 并渲染它，再把 `onSelect` 接到 `open_form` / `send_text` 两个分支上**（`loadSceneModuleMeta()` 就是为这个准备的）。

> 换句话说：**场景能力可以正常用，只是用户目前只能靠「打字触发」，看不到入口胶囊。** 加 module / 加 scene_type 都不受影响。
>
> 这条如果被补上了，请把本行的 ⚠️ 改成 ✅ 并删掉这段说明 —— 这是 §9.1 里「实现状态变化」的唯一落点。

---

## 1. 我要做的事，对应哪一条路

| 你的需求 | 走哪条路 | 章节 |
|---|---|---|
| 加一个**新的 UI 样式**（换个卡片画法） | 新增 module | §3 |
| 加一个**新的业务处理逻辑**（比如「工单派发」） | 新增 scene_type | §4 |
| 只是**改现有 module 的文案/布局** | 改 module | §3.6 |
| 改**表数量规则** | 改 `needs_table` | §5 |
| 改**消息里 block 怎么分发** | 改挂载位 | §6 |
| 加**新的 block kind** | ⚠️ 需要前后端同时改 | §4.5 |

**先判断一件事：你需要新 `scene_type` 吗？**

```
你的新需求，能不能用现有 4 个类型 + 一个新 module 实现？
  ├─ 能（只是 UI 不同 / 只是数据来源表不同）→ 只加 module，走 §3。绝大多数情况是这条。
  └─ 不能（处理逻辑本身是新的，比如要调外部 API、要走状态机）→ 加 scene_type，走 §4。
```

**90% 的需求应该是「只加 module」。** 加 scene_type 的代价是 **8 个文件、10 处改动**（后端 5 个文件 / 前端 3 个文件）+ 4 处 `execution_mode` 白名单，见 §4.1。加 module 的代价是 **1 个新目录、0 处存量改动**。

---

## 2. 契约速查（前后端唯一接口）

> 改这里 = breaking change。改完必须同步 §9 的清单。

### 2.1 block 契约

后端 `backend/app/scene_modules/types.py` ↔ 前端 `frontend-enterprise/src/scenes/types.ts`

```
SceneUiBlock {
  kind:            BlockKind        ← 只允许 6 个值，不许造新的
  data:            dict             ← 形状由 kind 定死
  module_key:      str              ← 谁画（从 scene 带过来）
  module_version:  int
  fallback_text:   str              ← block 级覆盖，空则用场景级
}

BlockKind = "text" | "result" | "empty" | "step" | "handoff" | "form"
```

**`kind` → 组件 映射（唯一合法映射，不要扩）：**

| kind | 由谁画 | 说明 |
|---|---|---|
| `form` | module 的 `SlotForm` | 收集条件 |
| `result` | module 的 `ResultCard` | 结果卡 |
| `empty` | module 的 `EmptyState` | 空结果 |
| `step` | module 的 `StepView` | 步骤 |
| `text` | 平台 `SceneTextBlock` | module **没有**这个组件位 |
| `handoff` | 平台 `SceneTextBlock` | 同上 |

> **「可少实现、不可多造 kind」**。没实现 `EmptyState` 就降级渲染 `fallback_text`，不要为了空态好看去造 `kind: "empty_fancy"` —— 那会让后端枚举与前端漂移，且后端的 `match` 分派永远产不出它。

**`SceneUiBlock` 在后端只有这 5 个字段**，一行都不能加。想加的时候先问：这个字段是「发生了什么」还是「画成什么样」？后者一律加在 module 里。

**保存场景时后端只校验 `module_key` 的格式，不校验它是否存在。** `validate_module_key()`（`constants.py`，grep `def validate_module_key`）只做正则匹配（`<域>.<场景>`，小写 + 下划线 + 至少一个点）。所以：

- 拼错但格式合法的 key（`acme.invoic`）**能存进去**，症状是 UI 静默降级
- 这是刻意的：后端不可能知道前端构建了哪些 module。存在性由前端注册表在渲染时决定（降级成卡片，不报错）

### 2.2 类型层元信息

后端 `constants.py` 的 `SCENE_TYPE_META` ↔ 前端 `types.ts` 的 `SCENE_TYPE_META`。**两份手抄，必须一致，有测试兜住。**

```python
SCENE_TYPE_META = {
    "table_match": {"label": "查表推荐", "icon": "📊", "needs_table": "optional"},
    "sop_flow":    {"label": "流程办理", "icon": "🧭", "needs_table": "none"},
    "handoff":     {"label": "转人工",   "icon": "🙋", "needs_table": "none"},
    "script":      {"label": "固定话术", "icon": "💬", "needs_table": "none"},
}
```

**前端多一个必填字段 `tagline`**（后端没有它，纯前端展示）：

```ts
export const SCENE_TYPE_META: Record<SceneType, SceneTypeMeta> = {
  table_match: buildTypeMeta({
    type: 'table_match', label: '查表推荐', icon: '📊',
    tagline: '收条件 → 从表里筛出候选 → 列出结果',   // ← 后端没有这一项
    needs_table: 'optional',
  }),
  // ...
};
```

前端的 `blocks` 字段（`tables` / `matchStrategy` / `slots` / `slotsReadOnly`）**不要手写**，由 `buildTypeMeta()` 从 `needs_table` 推导：`needs_table !== 'none'` 时 `tables` 与 `matchStrategy` 同真，否则同假。手写一遍等于给推导逻辑留了个可以撒谎的副本。

> 新类型时 `tagline` 怎么填：照现有句式 `<输入> → <处理> → <产出>`，一句话，不带句号。它是定义器下拉里的副标题，不是文档。

### 2.3 表数量三档（唯一的表数量口径）

| `needs_table` | 渲染表区块 | 数量下限 | 缺表时发布 |
|---|---|---|---|
| `none` | ❌ 不渲染 | 0 | 不校验 |
| `optional` | ✅ 渲染 | 0 | **warning，不阻断** |
| `required` | ✅ 渲染 | ≥1 | **阻断** |

- **上限 20 张与档位无关**（`MAX_TABLES_PER_SCENE`，性能护栏）。它在 `table_count_issues()` 里**必须排第一位**，否则 `optional` + 21 会被最后的 `return []` 放过。
- **module 层只能收紧，不能放宽**：`optional → required` 允许（`travel.itinerary`），`required → optional` / `optional → none` 不允许。实现是取 `max`，不写特例分支。

---

## 3. 新增一个 module（最常用）

### 3.1 一句话流程

```
建目录 → 写 index.tsx（meta + 组件）→ 跑测试 → 在定义器里就能选到
```

**不需要改后端、不需要改注册表、不需要改任何 index 文件。** 注册表是 `import.meta.glob` 构建期自动发现。

### 3.2 目录与文件

```
frontend-enterprise/src/scenes/modules/
└── <域>.<场景>/              ← 目录名 === meta.module_key
    ├── index.tsx            ← 必须，default export defineSceneModule(...)
    ├── params.ts            ← 可选，params_schema 拆出来
    └── XxxCard.tsx          ← 可选，组件拆文件
```

**命名规则**：`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` —— 小写字母/数字/下划线，**至少一个点**。

```
generic.table_match   ✅   （generic 是域，table_match 是场景）
table_match           ❌   没有点，「域」的分组能力消失
Travel.Itinerary      ❌   大写
travel-itinerary      ❌   连字符
```

### 3.3 最小可运行 module

```tsx
// frontend-enterprise/src/scenes/modules/acme.invoice/index.tsx
import { defineSceneModule } from '../../define';

export default defineSceneModule({
  meta: {
    module_key: 'acme.invoice',            // 必须 === 目录名
    module_version: 1,                     // 改 bug 就 +1
    supported_scene_types: ['table_match'],// ⚠️ 只写 1 个，有断言锁着
    summary: '把发票按「编号 + 金额 + 开票方」三列紧凑列出。', // 真会被读：员工档案下拉 + 列表页
    required_slots: [],                    // 它需要场景提供哪些输入
    params_schema: [],                     // 定义器据此渲染参数表单
    entry_behavior: 'open_form',           // open_form 弹表单 / send_text 直接发一句
    display_name: '发票列表',               // 可选，给人看的名字
  },
  // 只实现需要的组件。一个都不实现也是合法的（降级纯文本）。
});
```

**`meta` 七项必填**，少一项 `defineSceneModule` 在 DEV 期直接抛错。这不是形式主义 —— module 是动态 import 的，灰度期可能出现「新 module + 旧编译产物」，那时类型检查已经跑完了。

七项的实际作用（**每一项都有消费方，没有纯装饰字段**）：

| 字段 | 谁读它 | 读不到会怎样 |
|---|---|---|
| `module_key` | 注册表、`SceneEditor`、`SceneChips` | 整个 module 挂不上 |
| `module_version` | 后端 block 里带一份，前端比对，用于灰度诊断 | 排查版本错配时失去唯一线索 |
| `supported_scene_types` | 定义器的 module 下拉**过滤**（事前不可选，不是事后报错） | 所有类型都能选到它，管理员配出跑不通的组合 |
| `summary` | 员工档案下拉 + 列表页「能力」列 | 管理员只看到一堆 `key`，看不懂该选哪个 |
| `required_slots` | 定义器槽位区块 → **缺就阻断发布** | 场景没配必要槽位也能发布，运行时拿不到输入 |
| `params_schema` | 定义器「场景界面」区块渲染参数表单 | 管理员无法配置这个 module 的任何行为 |
| `entry_behavior` | `SceneChips` 点击时经 `loadSceneModuleMeta()` 读它（**点击时才解析，不是渲染时** —— glob 不带 `eager`，主包里没有 `meta`） | 点击胶囊无反应，或永远按 `open_form` 处理 |

> `display_name` 是**唯一可选**项。没有它时下拉显示 `module_key`。
>
> `needs_table` 也是可选（不写 = 沿用类型层档位）。写它只用于收紧，见 §2.3。

### 3.4 实现组件

四个组件都是**同一个 props 形状**（`SceneBlockProps`，定义在 `src/scenes/types.ts`）。**不要自己声明 props 类型**，直接 `import type { ResultCardProps } from '../../types'` —— 平台会加字段，自己声明等于钉死一份旧快照。

真实字段（10 个，不是 3 个）：

```tsx
export type SceneBlockProps = {
  block: SceneUiBlock;                          // 这块数据
  siblings: SceneUiBlock[];                     // 同一轮的全部块（要跨块联动时用）
  params: Record<string, unknown>;               // 场景参数（已按 params_schema 校验）
  sendText: (text: string) => void;              // 发一句话走新一轮（所有交互最终都归到它）
  submitSlots: (values: Record<string, unknown>) => void;  // 提交结构化槽位
  openExternal: (url: string) => void;           // 打开外链（分享页/历史回看为 no-op）
  disabled?: boolean;                            // 只读态（分享页 / 历史回看 / 已归档）
  renderBuiltin?: (block: SceneUiBlock) => ReactNode;      // 平台内置渲染器
  renderForm?: (data: Record<string, unknown>) => ReactNode; // 复用平台表单
};
```

> **`params` 是第二参数来源。** 场景实例的 UI 参数（`ui_config_json.params`）通过它进来，module 的「开关型」行为（比如 `show_source_table`）都该读它，而不是读 `block.data` —— 后者是数据，前者是配置，混在一起以后没法区分「这条数据没有这个字段」和「管理员关掉了它」。

实例（`travel.itinerary` 的真实写法）：

```tsx
export default defineSceneModule({
  meta: { /* ... */ },
  ResultCard: ItineraryResultCard,   // kind: 'result'
  EmptyState: ItineraryEmptyState,   // kind: 'empty'
});
```

**只实现 `ResultCard`，不实现 `EmptyState` 会怎样？** `componentForKind('empty')` 返回 `undefined`，平台降级渲染 `fallback_text`。**这是合法状态**，不是 bug —— 但你要确保场景的 `fallback_text` 填得好（定义器里是必填项）。

### 3.4.1 一份能直接改的完整骨架

把 `acme.invoice` 换成你的 module_key，`table_match` 换成你的类型，就能跑：

```tsx
// frontend-enterprise/src/scenes/modules/acme.invoice/index.tsx
import { defineSceneModule } from '../../define';
import type { ResultCardProps, EmptyStateProps } from '../../types';

const CARD =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

function InvoiceCard({ block, params, disabled }: ResultCardProps) {
  // items 的形状见 §4.4：row_id / values / score / source_table ...
  const items = Array.isArray(block.data?.items) ? block.data.items : [];
  const showSource = params.show_source_table !== false;   // 读 params，不读 data

  if (items.length === 0) {
    // 自己判空比依赖 empty 块更稳：后端可能只发一个 result 块
    return <div className={CARD + ' px-[14px] py-[11px] text-[12px]'}>{block.fallback_text}</div>;
  }

  return (
    <div className={CARD}>
      {items.map((raw, i) => {
        const values = (raw as { values?: Record<string, unknown> }).values ?? {};
        const source = String((raw as { source_table?: string }).source_table ?? '');
        return (
          <div key={i} className="border-b border-[#e7dfd3] px-[14px] py-[11px] last:border-b-0">
            <div className="text-[13px] text-[#20201d]">{String(values['编号'] ?? '')}</div>
            <div className="mt-[3px] text-[12px] text-[#343633]">
              {String(values['金额'] ?? '')}
              {showSource && source ? ` · ${source}` : ''}
            </div>
          </div>
        );
      })}
      {disabled && null /* 只读态不要隐藏内容，只禁用交互；这里没有交互所以留空 */}
    </div>
  );
}

export default defineSceneModule({
  meta: {
    module_key: 'acme.invoice',              // === 目录名，否则永久降级
    module_version: 1,
    supported_scene_types: ['table_match'],  // 只写 1 个
    summary: '把发票按「编号 + 金额 + 开票方」紧凑列出。',
    required_slots: [],
    params_schema: [
      { key: 'show_source_table', label: '显示数据来源', type: 'boolean', default: true },
    ],
    entry_behavior: 'open_form',
    display_name: '发票列表',
  },
  ResultCard: InvoiceCard,
  // EmptyState 不实现 —— 合法，降级用 fallback_text
});
```

**三个容易写错的地方：**

| 写法 | 问题 |
|---|---|
| `block.data.title` | 后端**不产出** `title`（§4.4）。永远 `undefined`，不报错 |
| 直接 `block.data.items.map(...)` | 后端可能发 `{}`，`items` 是 `undefined` → 整卡崩。先 `Array.isArray` |
| 用 `params` 判断「有没有数据」 | `params` 是配置（管理员设的），`data` 才是数据。混用后没法区分「这条没这个字段」和「管理员关了它」 |

**`params_schema` 的字段类型**（`SceneParamField`，定义在 `src/scenes/types.ts`。**只有 4 种，没有 `number` / `select`**）：

| `type` | 定义器渲染成 | 必填/可选字段 |
|---|---|---|
| `text` | 单行输入 | `placeholder?` |
| `textarea` | 多行输入 | `placeholder?` |
| `boolean` | 开关（`ToggleRow`，不套 `Field`） | `default?` |
| `column` | 单行输入，但语义是「表列 key」，placeholder 用 `help` 提示 | `help?` |

> **`column` 是「让管理员填一个列名」的语义标记**，不是下拉选择器 —— 它渲染的还是普通输入框，只是提示文案不同。想限定取值范围目前做不到，请在 `summary` 里写清可用列名。
>
> **`number` / `select` 不存在于 `params_schema`**，写了会 `tsc` 报错（联合类型收窄）。需要「只能在几个值里选」的时候，用 `text` + 在 `help`/`summary` 里写清枚举值，然后在 module 里做一次白名单校验：
>
> ```tsx
> const palette = ['red', 'green'].includes(String(params.color)) ? String(params.color) : 'red';
> ```

#### `required_slots` 和 `params_schema` 是两套不同的 `type`，别抄错

这是最容易混的一处 —— 两个字段都叫 `type`，但取值集合**不同**：

| | `required_slots[].type` | `params_schema[].type` |
|---|---|---|
| 给谁用的 | **场景实例**要提供哪些输入 | 定义器要渲染哪些**配置项** |
| 取值 | `number` / `text` / `date` / `select` / `boolean` | `text` / `textarea` / `boolean` / `column` |
| 谁读它 | 定义器槽位区块 → 发布校验（缺就阻断） | 定义器「场景界面」区块 → 参数表单 |
| 额外字段 | `required?` / `unit?`（如 `unit: '人'`） | `placeholder?` / `default?` / `help?` |

```tsx
// required_slots —— 场景必须收集的用户输入
required_slots: [
  { key: 'people', label: '人数', type: 'number', required: true, unit: '人' },
],
// params_schema —— 管理员可调的 module 行为
params_schema: [
  { key: 'people_column', label: '人数列', type: 'column', help: '留空则依次尝试 人数 / 成团人数' },
  { key: 'show_source_table', label: '显示来源表名', type: 'boolean', default: true },
],
```

#### 两个实践约定（`travel.itinerary` 的写法，建议照抄）

**① 列映射一律用 `type: 'column'` 让管理员显式指定，同时给同名兜底候选。**

module 不知道场景的表里列叫什么，所以「标题取哪列」必须让管理员指一下。但不指也要能跑 —— 在 `params.ts` 里写一份候选表：

```ts
export const COLUMN_CANDIDATES: Record<string, string[]> = {
  people: ['人数', '成团人数', '出行人数'],
  days:   ['天数', '行程天数', '晚数'],
};
```

**② 默认值集中在一处导出，不在组件里散落字面量。**

```ts
export const TRAVEL_ITINERARY_PARAM_DEFAULTS = {
  primary_action_label: '选这个',
  show_source_table: true,
} as const;
```

组件统一 `params.xxx ?? DEFAULTS.xxx`。散写字面量的后果是「默认值」变成三处不同的字符串，改一次要全文搜索，且**漏改的那处不会报错**。

### 3.5 视觉规格

UI 细节（间距/颜色/圆角）的唯一来源是 `docs/scenes/scene-v3-visual-contract.md`，里面是**逐值 Tailwind 对照表**，照抄数值即可。

```tsx
// 示例：来自 ItineraryCard 的真实取值
const CARD_CLASS =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';
```

设计令牌（只用这些，不许自造色值。全量清单在 `frontend-enterprise/src/styles.css`，引用时写 `var(--xxx)` 或附录 A 的 Tailwind 字面值）：

```
--background:#fbfbfa  --surface:#ffffff  --surface-muted:#eeece4  --surface-subtle:#fbfaf6
--border:#ded7cc      --border-strong:#cfc5b7  --line:#e7dfd3     --muted-soft:#9a9b95
--ink-soft:#343633    --foreground:#20201d
--accent:#0f766e      --accent-soft:#e1f1ed     --accent-foreground:#ffffff
--danger:#dc2626      --warning:#b45309         --success:#138a55
--copper:#a85d32      --olive:#6f7b42
--island-radius:20px  --island-radius-sm:16px   --island-gap:16px
--elev-card: 0 1px 2px rgba(17,17,17,.04), 0 1px 8px rgba(70,76,94,.06)
```

### 3.6 改现有 module

**不用改目录名**，除非你确实要换 `module_key`（换 key = 所有存量场景失效，因为 DB 里存的是旧 key）。

改文案/布局 → 直接改组件。
改了 `data` 的消费形状 → 必须同时确认后端那个通道产出的 `data` 形状没变，见 §4.4。

### 3.7 验收（必跑）

```bash
cd frontend-enterprise

# 1. 类型 + 目录名一致性（这条最重要，它兜住「目录名 ≠ module_key」）
npx tsc -b
npx vitest run src/scenes src/pages/scenes

# 2. 构建（确认新 module 有独立 chunk —— 证明 code-split 没坏）
npx vite build 2>&1 | grep <你的module_key>
```

**第 1 步的 `src/scenes` 里有一条硬断言**：`__tests__/constants.test.ts` 的「每个场景目录名 === `meta.module_key`，且点号命名」。它比 `define.tsx` 的 DEV 告警可靠 —— 后者靠调用栈猜路径，猜不到就静默跳过。

**第 2 步的期望输出**：`dist/assets/<你的module_key>-<8位hash>.js` 这么一行（如 `travel.itinerary-t4NFQjqv.js`）。**没有这一行 = 你的 module 被打进主包了**，检查是不是有人给 `import.meta.glob` 加了 `{ eager: true }`。

---

## 4. 新增一个 scene_type（重活，先确认 §1 的判断题）

### 4.1 要动的 10 处，一个都不能漏

> **这是本手册最重要的一张表。** 漏任何一处的症状都在「不报错」那一栏 —— 这就是为什么它必须被列全。

| # | 文件 | 改什么 | 漏了会怎样 |
|---|---|---|---|
| 1 | `backend/app/scene_modules/types.py` | `SceneType` 加值 | 类型层不认识，下游全部报错（这个还好，会红） |
| 2 | `backend/app/scene_modules/constants.py` | `SCENE_TYPE_META` 加一条（`label`/`icon`/`needs_table`） | 测试红；未知类型回落 `none` |
| 3 | 同上 | `SCENE_TYPES` 加值 | 穷尽性断言红（`set(SCENE_TYPE_META) == set(SCENE_TYPES)`） |
| 4 | 同上 | `DEFAULT_MODULE_BY_SCENE_TYPE` 加默认 module | 新建场景拿到 `generic.table_match`，UI 完全错配 |
| 5 | `backend/app/scenes/schema.py` 的 `SceneTypeLiteral`（grep `SceneTypeLiteral = Literal`） | 加值 | **API 层 422 或静默丢弃**，建不出这种场景 |
| 6 | `backend/app/scene_modules/channels.py` | 写 `_run_xxx()`（签名照抄 §4.2） | `dispatch_scene` 走 `case _` → 降级「类型暂不支持」 |
| 7 | `backend/app/scene_modules/runtime.py` 的 `dispatch_scene`（grep `match scene_type:`） | `match` 加 `case` | 同上 |
| 8 | `frontend-enterprise/src/scenes/types.ts` | `SceneType` + `SCENE_TYPES` + `SCENE_TYPE_META`（含 `tagline`）加值 | 定义器下拉里选不到 |
| 9 | `frontend-enterprise/src/scenes/__tests__/constants.test.ts` | 3 个手抄副本 `BACKEND_SCENE_TYPE_META` / `BACKEND_SCENE_TYPES` / `BACKEND_DEFAULT_MODULE_BY_TYPE` 各加一条 | **这条会红**（`toEqual` 数组全等 + 逐键比对），拦住合并 —— 但它红得正确，改完即绿 |
| 10 | `frontend-enterprise/src/scenes/modules/generic.<新类型>/` | 建一个默认 module | 新建场景时 `module_key` 指向不存在的 module → **UI 静默降级纯文本** |

**第 9 处容易被忽略**：`constants.test.ts` 里的 `BACKEND_*` 常量是**手抄的后端快照**，不是 import 来的。它是「前后端漂移」的守门员，所以必须跟着改；忘改的表现不是测试漏过，而是**新类型刚加就红** —— 这时别去怀疑代码，先看这张表第 9 行。

**还有 4 处 `execution_mode` 白名单 —— 这个和 scene_type 无关，但新增「场景直通」链路时会踩**，见 §4.6。

### 4.2 后端通道函数模板

```python
# backend/app/scene_modules/channels.py

def _run_acme_dispatch(
    db: Session,
    *,
    scene: "Scene",
    slots: dict[str, Any] | None = None,
    message: str = "",
    session_id: str = "",
    user_id: str | None = None,
    persist: bool = False,
    action_overrides: dict[str, Any] | None = None,
) -> SceneRunResult:
    """一句话说明这个通道做什么。

    签名必须与现有 4 个通道**完全一致**（含 `*` 之后的 keyword-only 约定，
    以及 `persist: bool = False` 这个默认值），因为 `dispatch_scene` 用同一份
    调用代码分发 —— 签名不一致不会报错，只会让某个通道永远收到默认值。
    """
    slots = dict(slots or {})

    # 1. 缺配置时给「可行动的原因」，不要给「暂无数据」
    flow = dict(scene.flow_json or {})
    if not flow.get("steps"):
        reason = "这个场景还没有配置处理步骤。"
        return SceneRunResult(
            blocks=[SceneUiBlock(kind="text", data={"content": reason})],
            text=reason,                       # 非 UI 渠道唯一内容来源，必填
            trace=[{"key": "acme", "detail": "配置为空"}],  # 排障用，落 trace_json
            status="no_match",
        )

    # 2. 产 block。只装语义数据，不装颜色/标题/布局
    blocks = [
        SceneUiBlock(
            kind="step",
            data={
                "step_name": "校验发票号",
                "step_index": 0,
                "step_total": 2,
                "status": "done",
                "missing": [],
            },
        )
    ]

    # 3. text 必须有：微信/企微/短信渠道只吃文本
    return SceneRunResult(
        blocks=blocks,
        text="发票校验通过。",
        trace=[{"key": "acme", "steps": 2}],
        status="ok",
    )
```

**三条硬要求：**

1. **`text` 必填。** 非 UI 渠道（企微/微信/短信）只有文本。缺它就是「在微信用里变成空白消息」—— 开发和测试都在 Web 端，这是最难发现的线上 bug。
2. **`trace` 写清走了哪条分支。** 它是唯一的排障入口，落 `SceneRun.trace_json`。
3. **不要自己拼 UI 描述。** 见铁律 ①。

### 4.3 注册到 dispatch

```python
# backend/app/scene_modules/runtime.py 的 dispatch_scene()

match scene_type:
    case "table_match": ...
    case "acme_dispatch":                    # ← 新增
        return _run_acme_dispatch(
            db, scene=scene, slots=slots, message=message,
            session_id=session_id, user_id=user_id,
            persist=persist, action_overrides=action_overrides,
        )
    case _:
        # 未知类型降级成 text block 说明原因，不抛异常
        ...
```

> **为什么用 `match` 不用 `dict[str, Callable]` 注册表？** 4 个已知常量分支时 `match` 能让类型检查器做穷尽性提醒；dict 查表会把「少注册一个」变成运行期 `KeyError`。
>
> ⚠️ **`case _` 分支不能省。** 少了它，未注册的类型会落空返回 `None`，而调用方紧接着执行 `result.blocks = build_ui_blocks(...)` → `AttributeError` → 整轮消息失败（而不是「降级提示」）。降级是刻意的：用户在对话里看到原因，比白屏好。

### 4.4 `data` 形状：前后端约定的临界点

**后端产的 `data` 键名，就是前端 module 读的键名。** 这里没有 schema 校验，改错了不会报错，只会显示空白。

```python
# 后端（channels.py）
SceneUiBlock(kind="step", data={"step_name": ..., "step_index": ...})

# 前端（module 组件）必须读同样的键
const name = block.data.step_name;
```

**已知的 `data` 形状**（P0 宽松口径，未冻结。下表逐键核对过 `channels.py`，**没有的键不要写**）：

| kind | data 键 | 产出处 |
|---|---|---|
| `text` | `content` | `channels.py` 各通道 |
| `result` | `total` / `items[]` / `max_items` | `_run_table_match` |
| `empty` | `reason` / `steps` / `funnel` / `suggestions` | `_run_table_match` |
| `step` | `step_name` / `step_index` / `step_total` / `status` / `missing` | `_run_sop_flow` |
| `handoff` | `target` / `summary` / `ticket_id` / `context` | `_run_handoff` |
| `form` | `build_slot_form()` 的原样输出：`kind` / `skill_id` / `step_id` / `step_name` / `title` / `submit_label` / `fields[]` | `build_slot_form_block` |

`items[]` 每项的形状由 `hit_payload()` 定死（`channels.py`，grep `def hit_payload`）：

```
row_id / values{纯表格列} / score / days_dev / budget_dev / fused / source_table
```

> **`result` 没有 `title` 键。** 早先文档写过 `title`，实测后端从不产出它 —— 前端若按 `data.title` 读标题会永远拿到 `undefined` 而静默回落默认文案。标题请在 module 里自己写死或从 `params` 取。
>
> **`values` 里的 `__` 前缀键已被剥掉。** `hit_payload()` 会过滤所有 `__` 开头的内部键（`__source_table__` 这类），所以 module 不能靠它们判断来源，要用 `source_table`。

### 4.5 加新 `kind`（慎做）

`kind` 是**跨前后端枚举**。加一个要动：`types.py` 的 `BlockKind`、`types.ts` 的 `BlockKind` + `BLOCK_KINDS`、`registry.ts` 的 `componentForKind`、`SceneModule` 的组件位。

**先问：能不能用现有 kind 表达？** 同一个 kind 可以是列表、时间轴或表格 ——**kind 说的是「什么事」，不是「长什么样」**。要做新视觉，改 module 组件，不加 kind。

### 4.6 四处 `execution_mode` 白名单（独立陷阱）

场景直通链路用 `execution_mode = "scene_module"`。这个值在**四处**被校验，漏一处：

| 位置 | 作用 | 漏了会怎样 |
|---|---|---|
| `backend/app/session/session_schema.py` 的 `execution_mode` Literal | 值合法性 | 值非法 |
| `backend/app/core/plan/planner.py` 的 `_normalize` 白名单 | 白名单放行 | 帧被打回 `standard` |
| `backend/app/core/engine/turn_run.py` 的 `light_execution_mode_by_frame_id` | 轻量模式判定 | 同上 |
| `backend/app/core/engine/turn_run.py` 帧循环（grep `light_mode == "scene_module"`） | 实际分派 | 不执行场景 |

> 这四处的准确位置一律用 **grep `"scene_module"`** 定位（`backend/app` 全库 **12 处命中**）。其中**只有 4 处是白名单、必须改**，其余 8 处是消费方与注释，照着改反而会改坏：
>
> | 归属 | 位置 | 要不要动 |
> |---|---|---|
> | ✅ 白名单 | `session_schema.py`（`execution_mode` 的 `Literal`） | **必须** |
> | ✅ 白名单 | `planner.py`（`_normalize` 的集合字面量） | **必须** |
> | ✅ 白名单 | `turn_run.py`（`light_execution_mode_by_frame_id` 的集合） | **必须** |
> | ✅ 白名单 | `turn_run.py` 帧循环（grep `light_mode == "scene_module"`） | **必须** |
> | 消费方 | `runtime.py` 短路计划里 `execution_mode="scene_module"` | 不动 |
> | 消费方 | `turn_frames.py` 两处 `"execution_mode": "scene_module"`（事件埋点） | 不动 |
> | 消费方 | `channels.py` 的 `metadata_json.source` | 不动 |
> | 注释 | `frames.py`、`models.py`、`session_schema.py`（第 2 处） | 不动 |
>
> **不要按行号跳。** 第 4 行是最容易漏的一处 —— `light_execution_mode_by_frame_id` 放行了、帧循环里的 `if` 没加，表现是「场景一次都不执行」，且日志里看不出任何异常。

**漏 `planner.py` 白名单的症状最坑**：帧被归一化回 `standard` → 跑完整 Harness 循环（12-60s）→ **不报错**。用户只觉得「这个场景特别慢」。

### 4.7 验收（必跑）

```bash
cd backend

# 1. 常量一致性 + 穷尽性
.venv/bin/python -m pytest tests/test_scene_constants.py -q

# 2. 通道行为
.venv/bin/python -m pytest tests/test_scene_channels.py -q

# 3. 端到端（建场景 → 试跑）
.venv/bin/python -m pytest tests/test_scene_api.py -q

# 4. 全量。⚠️ 必须带 --basetemp，否则会有 ~182 个假 ERROR
.venv/bin/python -m pytest tests/ -q --basetemp=/tmp/pytest_scene
```

> **`--basetemp` 不能省。** 沙箱会拦 pytest 默认临时目录，报 `FileExistsError: EEXIST: mkdir .../pytest-of-unknown`，产生 182 个假 ERROR。绕过之后只剩 16 个真失败（skills/desktop/packaging 缺依赖），与场景无关。

```bash
cd frontend-enterprise
npx tsc -b && npx vitest run src/scenes src/pages/scenes
```

---

## 5. 改表数量规则

**只有一个入口：`needs_table` 三档。** 不要引入第二个字段。

改类型档位 → 只改 `SCENE_TYPE_META[type].needs_table`（前后端各一份）。
改某 module 的档位 → 只改该 module 的 `meta.needs_table`（**只能收紧**）。

```python
# backend/app/scene_modules/constants.py
def table_count_issues(needs: NeedsTable, n: int) -> list[str]:
    count = max(0, int(n or 0))
    if count > MAX_TABLES_PER_SCENE:        # ← 必须在最前！倒了就漏
        return [f"一个场景最多 {MAX_TABLES_PER_SCENE} 张表，当前 {count} 张"]
    if needs == "required" and count == 0:
        return ["这个场景至少需要 1 张数据表"]
    return []
```

**两条不能动的顺序约束：**

- 上限判断**必须排第一位**。倒了会让 `optional` + 21 被 `return []` 放过 → 上限护栏对 `table_match`（唯一能传多表的类型）静默失效。
- `issues`（阻断）与 `warnings`（提示）**严格分离**。混在一起，前端会把 warning 渲染成阻断，正好变成本次要消灭的「缺表阻断」。

**前端定义器有 3 处调用必须同时传 `moduleNeeds`**（`SceneEditor.tsx`：`blockers` 的 `useMemo` / `save()` 内 / `tableCountWarnings` 渲染处）。漏一处的表现是「提示说没事、保存却 400」。

为什么是 3 处而不是 1 处：定义器用同一个 `publishBlockers()` 算三次不同用途的结果 —— 侧栏导航的红点、点保存时的实际校验、以及表区块下方的 warning 文案。**它们必须用同一个 `moduleNeeds`**，否则红点不亮但保存失败，或者相反。

```ts
// frontend-enterprise/src/scenes/types.ts
export function effectiveNeedsTable(type, moduleNeeds?) {
  const base = sceneTypeMeta(type).needs_table;
  if (!moduleNeeds) return base;
  return NEEDS_TABLE_ORDER[base] >= NEEDS_TABLE_ORDER[moduleNeeds] ? base : moduleNeeds;
}
```

**取 `max` 而不是「相信 module」**，这一步就同时实现了三条规则：`optional → required` 生效、`required → optional` 不生效、`optional → none` 不生效。写特例分支反而会漏掉其中一条。

---

## 6. 消息里 block 怎么分发

一条消息的 `ui_blocks` 走 `messageBlockSlots.ts` 的 4 个挂载位：

| 挂载位 | 收哪些 kind |
|---|---|
| `head` | `dispatch` |
| `body` | `team_progress` |
| `below` | `harness_artifacts`、`knowledge_citations` |
| `tail` | 场景块、`slot_form`、`scheduled_task_draft`、`suggested_actions` |

**两个 block 类型，不能互相赋值：**

| 类型 | 位置 | `kind` 类型 | 职责 |
|---|---|---|---|
| `SceneUiBlock` | `src/scenes/types.ts` | `BlockKind`（收窄枚举） | 渲染契约，交给 module |
| `A2UIBlock` | `src/pages/chat/chatTypes.ts` | `string`（容错） | metadata 容器，来自后端 JSON |

转换点唯一：`messageBlockSlots.ts` 的 `toSceneBlock()`。

> **认不出的 `kind` 要降级成 `text`，不要 `filter` 掉。** filter 会让「后端上新 kind、前端旧构建」时那块 UI 凭空消失。容错与收窄是两个相反的要求，只能靠这个显式转换点隔开。

> **`chatHelpers.tsx` 里 `form.kind !== 'slot_form'` 那个收窄不许动。** 它挡的是「任意 metadata 都被当成表单画出来」。有守护断言，删了会红。

---

## 7. 常见故障对照表

> 这一节按「症状」查，不按原因查。**所有列出的症状都是「不报错」的** —— 会红的问题不需要这张表。

| 症状 | 最可能的原因 | 去哪看 |
|---|---|---|
| 消息里那块 UI 变成纯文本，没报错 | 目录名 ≠ `module_key` | `define.tsx` 的 DEV 告警；`constants.test.ts` 的目录名断言 |
| 同上，但 UI 变成「无法渲染」的降级卡 | `module_key` 有值、注册表里没有这个 key | `SceneFallbackCard`；确认 module 目录存在且被 glob 到 |
| 同上，且刚上线新 module | chunk 404 / 加载失败 | 浏览器 Network；`loadSceneModule` 返回 `null` |
| 消息里那块 UI **整块消失**（不是纯文本） | `isSceneBlock()` 判成了 false → 走进 builtin 分支且无人认领 | `messageBlockSlots.ts` 的 `isSceneBlock`：它要求「有 `module_key`」或「kind 在 `BLOCK_KINDS` 里」 |
| 新建场景时 UI 完全错配 | `DEFAULT_MODULE_BY_SCENE_TYPE` 没加新类型 | `constants.py` |
| 新建场景时 module 下拉是空的 | 没有 module 声明这个 `scene_type` | 新类型必须建 `generic.<新类型>/`（§4.1 第 10 处） |
| 「任何场景都发布不了」 | 读了不存在的字段做阻断（如旧的 `table_id`） | `publishBlockers`；这是踩过的真实故障 |
| 表区块整块不渲染 | `needs_table` 读成 `undefined` → 当成 `none` | 是否并存了 `table_range`/`min_tables` |
| 场景执行特别慢（12-60s） | `planner.py` 白名单漏了 `"scene_module"` → 打回 `standard` | §4.6 四处白名单 |
| 点了胶囊，等很久，得到一段泛泛的回答 | 同 §4.6 —— 帧被归一化回 `standard` | `session_schema` / `planner` / `turn_run` 三处白名单 |
| 微信/企微用户收到空白消息 | 通道没填 `text` | 通道函数的 `SceneRunResult.text` |
| 发布提示说没事、点发布却 400 | `moduleNeeds` 三处只传了部分 | §5 末尾 |
| 管理员改了表，保存后没生效 | `tables` 没发（`tablesDirty` 为假） | `SceneEditor.toPayload()` |
| 新类型刚加完，前端测试就红 | `constants.test.ts` 的手抄快照没同步 | §4.1 第 9 处 |

---

## 8. 开发前自检清单

> **给 AI**：开始动代码前逐条确认；**给人**：卡住时回来对一遍。

```
[ ] 走的是 §1 的判断题吗？确认真的需要新 scene_type，而不是只加一个 module
[ ] 新 module：目录名 === module_key？点号命名？全小写？
[ ] 新 module：supported_scene_types 只写了 1 个？（有断言锁着）
[ ] 新 module：meta 七项齐了吗？
[ ] 新 scene_type：§4.1 的 10 处都改了吗？（第 9 处是测试里的手抄快照，最容易忘）
[ ] 新 scene_type：§4.6 四处 execution_mode 白名单确认过吗？
[ ] 新通道：text 填了吗？trace 写了吗？没拼 UI 描述吗？
[ ] 动契约了吗？动了就同步 §2 和 §9
[ ] tsc -b 是 0 错误吗？
[ ] vitest 全绿吗？
[ ] vite build 后新 module 有独立 chunk 吗？
[ ] 后端 pytest 带 --basetemp 了吗？
```

---

## 9. 文档同步规则（改代码时必须一起做的事）

> **这一节是为了防止这份文档变成「过期文档」。** 已有三份设计文档（`scene-v2-prd.md` / `scene-v2-arch.md` / `scene-v2-impl-map.md`）都曾因代码快速变化导致**全部 `file:line` 失效**，最危险的一次是把「必须保留的代码」记成了错误行号，让人误以为它已被删除。

### 9.1 什么时候必须改这份文档

| 你改了什么 | 本文哪节必须更新 |
|---|---|
| `SceneUiBlock` / `BlockKind` 字段 | §2.1、§4.4 的 `data` 形状表 |
| `SCENE_TYPE_META` 的键或字段 | §2.2 |
| `needs_table` 三档语义 | §2.3、§5 |
| 新增 scene_type | §4.1 表格、§10 示例、§7 若有新故障模式 |
| 新增 module | §3 示例可以不动，但**目录清单**若在本文出现需同步 |
| 新增 `kind` | §2.1 映射表、§4.4、§6 挂载位 |
| 某通道改了 `data` 的键 | §4.4 表格对应行 |
| 消息分发挂载位变化 | §6 |
| `execution_mode` 白名单增删 | §4.6 |
| 新增 `publishedBlockers` 类校验 | §5、§7 |
| **某项能力从「未挂载/未完成」变成「已上线」** | **§0.5 实现状态表**（唯一落点） |
| 验收命令变化（如改 test 路径） | §3.7、§4.7、附录 C |

**没在上表里的改动不用回来改这份文档。** 别为了「保持同步」把实现细节抄进来 —— 抄进来的每一行都是未来的谎言。

**最容易被忘的是 §0.5。** 它记的是「当前做到哪一步」，而这恰好是代码演进中最常变的部分。判断标准很简单：**如果你这次改动让某个人昨天做不了的事今天能做了，就去改 §0.5。**

### 9.2 写法约束：**优先写符号，不要写行号**

```markdown
✅ 好：`publishBlockers`（`sceneUtils.ts`）
❌ 差：`sceneUtils.ts:108-124`
```

行号会随任何人加一行注释而失效，且失效后**看不出来**——读者按旧行号跳过去，会落到一段看起来合理的代码上，然后得出错误结论。

> 本文自身也遵守这条：全文**零行号**，只在 §4.6 这类必须区分「改哪几处」的地方用 `grep` 特征串 + 归属表。

**如果必须定位**，用「文件名 + 函数名/常量名 + 一句可 grep 的特征」：

```markdown
✅ `messageBlockSlots.ts` 的 `toSceneBlock()`（grep `export function toSceneBlock`）
❌ 第 104 行
```

### 9.3 本文与三份设计文档的分工

| 文档 | 定位 | 什么时候看 |
|---|---|---|
| **本文** | **开发手册**：照做就能做 | 动手前 |
| `scene-v2-prd.md` | 为什么这样设计（产品论证） | 想推翻某个决策时 |
| `scene-v2-arch.md` | 架构与不变式 | 想知道「为什么要这样分层」 |
| `scene-v2-impl-map.md` | 当时的施工映射（历史记录） | 考古用，**不要当现状** |
| `scene-v3-visual-contract.md` | UI 逐值规格 | 写 module 组件时 |
| `scene-v3-demo.html` | 视觉基准（浏览器打开对照） | 调 module 的间距/配色时 |

> **冲突时以本文为准**，因为本文是唯一「按当前代码重写、且承诺跟随代码更新」的那份。设计文档冻结在各自的时间点，不追改。
>
> 但**视觉冲突以 `scene-v3-visual-contract.md` + demo 为准**：那些逐值规格是被实现的，不是设计意图，本文只引用不复述数值。

---

## 10. 一次完整的实操示例：加「工单派发」类型

> 走完 §4 全流程的最小例子。

**需求**：用户说「我要报修」，场景收集地点+设备，派一张工单，回显工单号。

**第 0 步：判断题** —— 处理逻辑是新的（要调外部工单 API），不只是 UI 不同 → **确实要新 scene_type**。

**第 1 步：后端类型（4 处）**

```python
# types.py
SceneType = Literal["table_match", "sop_flow", "handoff", "script", "ticket_dispatch"]
#                                                              ^^^^^^^^^^^^^^^

# constants.py
SCENE_TYPE_META = {
    # ...
    "ticket_dispatch": {"label": "工单派发", "icon": "🎫", "needs_table": "none"},
}
SCENE_TYPES = ("table_match", "sop_flow", "handoff", "script", "ticket_dispatch")
DEFAULT_MODULE_BY_SCENE_TYPE = {
    # ...
    "ticket_dispatch": "generic.ticket_dispatch",
}

# backend/app/scenes/schema.py 的 SceneTypeLiteral
SceneTypeLiteral = Literal["table_match", "sop_flow", "handoff", "script", "ticket_dispatch"]
```

**第 2 步：通道函数** —— 照 §4.2 模板写 `_run_ticket_dispatch()`。

**第 3 步：注册** —— `runtime.py` 的 `match` 加 `case "ticket_dispatch"`。

**第 4 步：前端类型（1 个文件，3 个地方）** —— **必须在建 module 之前**，否则 module 里 `supported_scene_types: ['ticket_dispatch']` 会 `tsc` 报「不在 `SceneType` 里」。

```ts
// frontend-enterprise/src/scenes/types.ts
export type SceneType = 'table_match' | 'sop_flow' | 'handoff' | 'script' | 'ticket_dispatch';
export const SCENE_TYPES: SceneType[] = [..., 'ticket_dispatch'];

// SCENE_TYPE_META 加一条。label / icon / needs_table 与后端逐字一致，tagline 只在有前端
export const SCENE_TYPE_META: Record<SceneType, SceneTypeMeta> = {
  // ...
  ticket_dispatch: buildTypeMeta({
    type: 'ticket_dispatch',
    label: '工单派发',
    icon: '🎫',
    tagline: '收地点设备 → 派单 → 回显工单号',
    needs_table: 'none',
  }),
};
```

**第 5 步：同步测试里的手抄快照（§4.1 第 9 处）** —— 三处都要加：

```ts
// frontend-enterprise/src/scenes/__tests__/constants.test.ts
const BACKEND_SCENE_TYPE_META = {
  // ...
  ticket_dispatch: { label: '工单派发', icon: '🎫', needs_table: 'none' },  // ← label/icon 必须逐字
};
const BACKEND_SCENE_TYPES = [..., 'ticket_dispatch'];                       // ← 顺序也要一致
const BACKEND_DEFAULT_MODULE_BY_TYPE = { ..., ticket_dispatch: 'generic.ticket_dispatch' };
```

**第 6 步：默认 module**

```
src/scenes/modules/generic.ticket_dispatch/index.tsx
```

```tsx
export default defineSceneModule({
  meta: {
    module_key: 'generic.ticket_dispatch',
    module_version: 1,
    supported_scene_types: ['ticket_dispatch'],
    summary: '收集地点与设备，派单后回显工单号与预计响应时间。',
    required_slots: [
      { key: 'location', label: '地点', type: 'text', required: true },
      { key: 'device', label: '设备', type: 'text', required: true },
    ],
    params_schema: [],
    entry_behavior: 'open_form',
    display_name: '工单派发',
  },
  ResultCard: TicketCard,   // 自己写
});
```

**第 7 步：验收** —— 跑 §4.7 全部命令。**特别检查 `vite build` 输出里有 `generic.ticket_dispatch-xxxx.js`。**

**第 8 步：回来改这份文档** —— §4.1 表格加一行、§2.2 代码块加一条、§9.1 若有新故障模式。

---

## 附录 A：文件地图

```
backend/app/scene_modules/          ← 运行时（读 DB、分派、产 block）
├── types.py                        ← 契约：SceneUiBlock / BlockKind / SceneType
├── constants.py                    ← SCENE_TYPE_META / 三档 / 表数量校验
├── channels.py                     ← 4 个通道函数（+ 你的新通道）
├── runtime.py                      ← dispatch_scene / run_scene_instance / 短路计划
└── chips.py                        ← GET /api/chat/scenes（入口胶囊）

backend/app/scenes/                 ← 匹配库（纯计算，不知 DB/HTTP）
├── schema.py                       ← pydantic 请求/响应模型
├── matcher.py                      ← run_match（打分/漏斗）
└── normalize.py                    ← 单位与列归一化

frontend-enterprise/src/scenes/     ← 前端框架层（框架无关）
├── types.ts                        ← 契约（与后端同构）
├── registry.ts                     ← import.meta.glob 自动发现 + 懒加载
├── define.tsx                      ← defineSceneModule（唯一的类型保障点）
├── SceneBlockList.tsx              ← 把 blocks 列表变成 UI
├── SceneModuleSurface.tsx          ← 单个 module 的渲染壳
├── shared/                         ← module 共用组件
└── modules/<module_key>/           ← ★ 你的 module 放这里

frontend-enterprise/src/pages/scenes/  ← 管理台
├── ScenesPage.tsx                  ← 列表
├── SceneEditor.tsx                 ← 定义器（8 个 Section：基础信息 / 场景界面 / 数据表 / 触发条件 / 槽位 / 匹配策略 / 命中后回答 / 绑定员工）
├── SceneRunPanel.tsx               ← 试跑面板
└── sceneUtils.ts                   ← 纯逻辑（publishBlockers 等）

frontend-enterprise/src/pages/chat/   ← 对话端
├── messageBlockSlots.ts            ← 4 个挂载位 + toSceneBlock 转换点
└── components/SceneChips.tsx       ← 入口胶囊
```

**定位某个东西时，先想它在「契约 / 运行时 / 渲染 / 管理台」哪一层**：契约在 `types.*`，运行时在 `scene_modules/`，渲染在 `src/scenes/`，管理台在 `src/pages/scenes/`。这四层不会交叉，找错层就会误以为「没有这个文件」。

## 附录 B：命名冲突清单（避免自己踩）

| 容易混的 | 区别 |
|---|---|
| `app.scenes.schema` | pydantic 请求/响应模型（HTTP 层） |
| `app.scene_modules.types` | 运行时 dataclass（`SceneUiBlock` 等） |
| `app.scenes.matcher.run_match` | 纯匹配计算，不知 DB |
| `channels._run_table_match` | 取数 + 调 matcher + 产 block（有 DB 依赖） |
| `SceneUiBlock`（代码） | 文档里曾写成 `SceneUIBlock`，**grep 后者零命中**——不是缺文件，是拼写不同 |
| `SceneType`（4 个处理类型） | vs `module_key`（前端渲染器），两者独立 |
| `SlotForm`（module 组件位） | vs `build_slot_form()`（后端函数，产 `form` block 的 `data`） |
| `params_schema`（管理员配的 UI 参数） | vs `required_slots`（用户要填的业务输入），type 集合不同，见 §3.4.1 |
| `table_count_issues`（阻断） | vs `table_count_warnings`（只提示，永不阻断），**两个函数不能合并** |
| `light_execution_mode_by_frame_id`（判定） | vs 帧循环里的 `if`（实际分派），两处都要有 `"scene_module"` |

## 附录 C：一页速查

```
新 UI 样式      → 加 module（§3）        ← 90% 的需求在这里，不碰后端
新处理逻辑      → 加 scene_type（§4，10 处）
改表数量规则    → 只动 needs_table（§5）
改消息位置      → 动 messageBlockSlots（§6）
看不清症状      → 查 §7 故障表
不确定要不要做  → 查 §1 判断题
改完必须同步文档 → 查 §9.1 映射表
```

**三句话记住这个架构：**

1. `scene_type` 定「后端怎么处理」，`module_key` 定「前端怎么画」，**两者独立**。
2. 后端只说「发生了什么」（`kind` + `data`），从不说「画成什么样」。
3. 加 module 零后端改动；加 scene_type 要动 10 处，其中 1 处在测试文件里。

**改动后必跑：**

```bash
# 后端
cd backend && .venv/bin/python -m pytest tests/ -q --basetemp=/tmp/pytest_scene

# 前端
cd frontend-enterprise && npx tsc -b && npx vitest run && npx vite build
```

> 只看场景相关的话，后端跑 `tests/test_scene_*.py`，前端跑 `npx vitest run src/scenes src/pages/scenes`。

**改完契约别忘了改本文（§9.1）。**