// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  BLOCK_KINDS,
  MAX_TABLES_PER_SCENE,
  NEEDS_TABLE_ORDER,
  SCENE_TYPES,
  SCENE_TYPE_META,
  effectiveNeedsTable,
  isBlockKind,
  minTablesForType,
  sceneTypeMeta,
  tableCountIssues,
  tableCountWarnings,
  type NeedsTable,
} from '../types';
import { knownSceneModuleKeys, loadSceneModuleCatalog } from '../registry';

/**
 * 类型常量护栏。
 *
 * 这个文件存在的唯一理由：**`src/scenes/types.ts` 与
 * `backend/app/scene_modules/constants.py` 是两份手抄的同构常量**。
 * 两份手抄必然漂，而漂的方式恰好都是「不报错」：
 *
 * - 字段名不一致（一侧 `needs_table`、另一侧 `table_range`）→ 读不到的那侧拿到
 *   `undefined` → 被静默当成「这个类型不用表」→ `table_match` 的数据表区块
 *   整块不渲染且不报错 → 表现是「新建查表场景没有传表入口」。
 * - 档位值不一致（一侧 `optional`、另一侧写错成 `opt`）→ 同上。
 * - `blocks.tables` 与 `needs_table` 两处各写一份 → 它们可以互相矛盾。
 *
 * 所以下面断言的不是「实现细节」，而是「两侧字段名与取值逐字一致」。
 */

/** 后端 `backend/app/scene_modules/constants.py` 的 `SCENE_TYPE_META`（逐字抄下来）。 */
const BACKEND_SCENE_TYPE_META: Record<string, { label: string; icon: string; needs_table: string }> = {
  table_match: { label: '查表推荐', icon: '📊', needs_table: 'optional' },
  sop_flow: { label: '流程办理', icon: '🧭', needs_table: 'none' },
  handoff: { label: '转人工', icon: '🙋', needs_table: 'none' },
  script: { label: '固定话术', icon: '💬', needs_table: 'none' },
  tool_submit: { label: '表单提交', icon: '📮', needs_table: 'none' },
};

/** 后端 `SCENE_TYPES`（顺序也一致）。 */
const BACKEND_SCENE_TYPES = ['table_match', 'sop_flow', 'handoff', 'script', 'tool_submit'];

/** 后端 `DEFAULT_MODULE_BY_SCENE_TYPE`。前端必须存在同名 module，否则胶囊点了没反应。 */
const BACKEND_DEFAULT_MODULE_BY_TYPE: Record<string, string> = {
  table_match: 'generic.table_match',
  sop_flow: 'generic.sop_flow',
  handoff: 'generic.handoff',
  script: 'generic.script',
  tool_submit: 'generic.tool_submit',
};

/** 后端 `MAX_TABLES_PER_SCENE`。 */
const BACKEND_MAX_TABLES = 20;

describe('场景类型常量与后端一致', () => {
  it('类型集合与顺序完全一致', () => {
    expect([...SCENE_TYPES]).toEqual(BACKEND_SCENE_TYPES);
    expect(Object.keys(SCENE_TYPE_META).sort()).toEqual([...BACKEND_SCENE_TYPES].sort());
  });

  it.each(BACKEND_SCENE_TYPES)('%s 的 label / icon / needs_table 逐字一致', (type) => {
    const backend = BACKEND_SCENE_TYPE_META[type];
    const frontend = SCENE_TYPE_META[type as keyof typeof SCENE_TYPE_META];
    expect(frontend.label).toBe(backend.label);
    expect(frontend.icon).toBe(backend.icon);
    expect(frontend.needs_table).toBe(backend.needs_table);
  });

  it('表数量上限与后端一致（性能护栏，与档位无关）', () => {
    expect(MAX_TABLES_PER_SCENE).toBe(BACKEND_MAX_TABLES);
  });

  it('档位严格程度排序与后端 NEEDS_TABLE_ORDER 一致', () => {
    expect(NEEDS_TABLE_ORDER).toEqual({ none: 0, optional: 1, required: 2 });
  });

  it('常量里只有 needs_table 一档，不许并存 table_range / min_tables', () => {
    for (const meta of Object.values(SCENE_TYPE_META)) {
      const keys = Object.keys(meta);
      expect(keys).toContain('needs_table');
      expect(keys).not.toContain('table_range');
      expect(keys).not.toContain('min_tables');
      // `table_range` / `min_tables` 一旦混进 meta，两个字段会互相矛盾，
      // 而「读不到的那个」会被静默当成「不用表」。
    }
  });
});

describe('blocks 由 needs_table 推导，不另写一份', () => {
  it.each(BACKEND_SCENE_TYPES)('%s 的 tables / matchStrategy 与档位一致', (type) => {
    const meta = SCENE_TYPE_META[type as keyof typeof SCENE_TYPE_META];
    const hasTables = meta.needs_table !== 'none';
    expect(meta.blocks.tables).toBe(hasTables);
    // 有表才有「匹配策略」—— 两者必须同真同假，否则会出现
    // 「匹配策略区块渲染了但一张表都没有」的空转界面。
    expect(meta.blocks.matchStrategy).toBe(hasTables);
  });

  it('只有 script 的槽位是只读的', () => {
    expect(SCENE_TYPE_META.script.blocks.slotsReadOnly).toBe(true);
    expect(SCENE_TYPE_META.table_match.blocks.slotsReadOnly).toBe(false);
    expect(SCENE_TYPE_META.sop_flow.blocks.slotsReadOnly).toBe(false);
    expect(SCENE_TYPE_META.handoff.blocks.slotsReadOnly).toBe(false);
  });

  it('table_match 必须渲染表区块且不因 0 张表被拦发布', () => {
    // 这两件事必须同时成立（team-lead 明确要求）：
    // 只做「渲染」不让 0 张过，或少做「0 张放行」却不渲染区块，都是错的。
    expect(SCENE_TYPE_META.table_match.needs_table).toBe('optional');
    expect(SCENE_TYPE_META.table_match.blocks.tables).toBe(true);
    expect(tableCountIssues('table_match', 0)).toEqual([]);
    expect(tableCountWarnings('table_match', 0)).toHaveLength(1);
  });
});

describe('sceneTypeMeta 回落', () => {
  it('未知类型回落到 table_match（给管理员一个能改的界面，而不是空白页）', () => {
    expect(sceneTypeMeta(undefined).type).toBe('table_match');
    expect(sceneTypeMeta('').type).toBe('table_match');
    expect(sceneTypeMeta('not_a_type').type).toBe('table_match');
  });
});

describe('minTablesForType', () => {
  it('只有 required 档要求 ≥1', () => {
    expect(minTablesForType('table_match')).toBe(0);
    expect(minTablesForType('script')).toBe(0);
    // 类型层没有 required 档；通过 effectiveNeedsTable 收紧后才有。
    expect(Object.values(SCENE_TYPE_META).every((meta) => minTablesForType(meta.type) === 0)).toBe(true);
  });
});

describe('effectiveNeedsTable：module 只能收紧不能放宽', () => {
  it('optional → required 允许（定制 module 没表画不出空态）', () => {
    expect(effectiveNeedsTable('table_match', 'required')).toBe('required');
  });

  it('required → optional 不允许（会把阻断降成 warning）', () => {
    // P0 的类型层没有 required 档（4 个类型都是 none / optional），所以这条
    // 放宽路径在当下不可达。这里断言的是「比较逻辑本身」而不是某个具体类型：
    // 用 NEEDS_TABLE_ORDER 直接表达「更严的基数不会被更宽的 module 档位覆盖」。
    const order = NEEDS_TABLE_ORDER;
    expect(order.required > order.optional).toBe(true);
    expect(order.required > order.none).toBe(true);
    expect(order.optional > order.none).toBe(true);
    // 反向确认：没有任何类型的 needs_table 是 required（若将来加了，这个断言会红，
    // 提醒把上面那条不可达注释删掉并按真实类型补用例）。
    expect(Object.values(SCENE_TYPE_META).some((meta) => meta.needs_table === 'required')).toBe(false);
  });

  it('optional → none 不允许（会让传表区块静默消失）', () => {
    expect(effectiveNeedsTable('table_match', 'none')).toBe('optional');
  });

  it('module 不声明时用类型档位', () => {
    expect(effectiveNeedsTable('table_match', undefined)).toBe('optional');
    expect(effectiveNeedsTable('sop_flow', undefined)).toBe('none');
  });

  it('收紧永不放宽：对每个可达 (类型, module 档位) 组合取更严者', () => {
    // 只遍历**实际存在**的类型档位（none / optional）。required 基数不可达，
    // 用上面的比较逻辑断言覆盖。
    const reachableBaseTypes = SCENE_TYPES.filter(
      (type) => SCENE_TYPE_META[type].needs_table !== 'required',
    );
    // 不写死数字：写死会让每次新增类型都红一次，而红的原因与这条用例
    // 真正要守的东西（「取更严者」）毫无关系。这里只断言「确实遍历到了东西」，
    // 避免 `filter` 出空数组导致循环体一次都不执行（等于没测）。
    expect(reachableBaseTypes.length).toBeGreaterThan(0);
    for (const type of reachableBaseTypes) {
      const base = SCENE_TYPE_META[type].needs_table;
      for (const moduleNeeds of ['none', 'optional', 'required'] as NeedsTable[]) {
        const got = effectiveNeedsTable(type, moduleNeeds);
        const expected = NEEDS_TABLE_ORDER[base] >= NEEDS_TABLE_ORDER[moduleNeeds]
          ? base
          : moduleNeeds;
        expect(got).toBe(expected);
        // 结果永不弱于类型层档位 —— 这就是「只能收紧不能放宽」。
        expect(NEEDS_TABLE_ORDER[got]).toBeGreaterThanOrEqual(NEEDS_TABLE_ORDER[base]);
      }
    }
  });
});

describe('tableCountIssues 与 tableCountWarnings 严格互补', () => {
  it('optional + 0 张：无阻断，有 warning', () => {
    expect(tableCountIssues('table_match', 0)).toEqual([]);
    expect(tableCountWarnings('table_match', 0)).toEqual([
      '这个场景还没有数据表，发布后用户触发时只会提示未配表',
    ]);
  });

  it('none + 0 张：无阻断，无 warning', () => {
    expect(tableCountIssues('script', 0)).toEqual([]);
    expect(tableCountWarnings('script', 0)).toEqual([]);
  });

  it('none + N 张：无阻断，有「不生效」warning', () => {
    expect(tableCountIssues('handoff', 3)).toEqual([]);
    expect(tableCountWarnings('handoff', 3)).toHaveLength(1);
    expect(tableCountWarnings('handoff', 3)[0]).toContain('3 张');
  });

  it('超过上限：阻断（上限必须排在最前，否则会被最后的 return [] 放过）', () => {
    expect(tableCountIssues('table_match', MAX_TABLES_PER_SCENE + 1)).toHaveLength(1);
    expect(tableCountIssues('table_match', MAX_TABLES_PER_SCENE + 1)[0]).toContain(
      String(MAX_TABLES_PER_SCENE),
    );
    expect(tableCountIssues('table_match', MAX_TABLES_PER_SCENE)).toEqual([]);
  });

  it('warning 永远不是阻断：两个函数返回的是不同字段', () => {
    // PRD §4.3.1：`table_count_issues()` 只返阻断、`table_count_warnings()` 只返提示。
    // 若实现者把 warning 塞进 blockers，前端会渲染成「不能发布」——正好退回
    // 「缺表阻断」，而日志里看不出异常。这条断言是唯一能抓住它的地方。
    for (const type of SCENE_TYPES) {
      for (const count of [0, 1, 2, MAX_TABLES_PER_SCENE, MAX_TABLES_PER_SCENE + 1]) {
        const issues = tableCountIssues(type, count);
        const warnings = tableCountWarnings(type, count);
        // 同一个问题不能同时出现在两个通道里。
        for (const warning of warnings) {
          expect(issues).not.toContain(warning);
        }
      }
    }
  });

  it('负数/NaN 按 0 处理（不抛、不误判）', () => {
    expect(tableCountIssues('table_match', Number.NaN)).toEqual([]);
    expect(tableCountIssues('table_match', -3)).toEqual([]);
    expect(tableCountWarnings('table_match', -3)).toHaveLength(1);
  });
});

describe('BlockKind 枚举', () => {
  it('只有 6 个语义 kind（可少实现，不可多造）', () => {
    expect([...BLOCK_KINDS]).toEqual(['text', 'result', 'empty', 'step', 'handoff', 'form']);
  });

  it('isBlockKind 拒绝框架内置 kind 与脏值', () => {
    expect(isBlockKind('result')).toBe(true);
    // 框架内置 kind 不属于 BlockKind —— 它由 messages metadata 合成，后端永不产出。
    expect(isBlockKind('suggested_actions')).toBe(false);
    expect(isBlockKind('scheduled_task_draft')).toBe(false);
    expect(isBlockKind(undefined)).toBe(false);
    expect(isBlockKind(42)).toBe(false);
  });
});

describe('注册表：目录名 === meta.module_key', () => {
  /**
   * 这是「四阶段里只有最后一阶段崩」的那个不变式的唯一自动兜底。
   *
   * `import.meta.glob` 用**目录名**建映射（`keyOf()` 取 `./modules/<dir>/index.tsx`
   * 的第一段）。如果目录名与 `meta.module_key` 不一致：后端能存、`/api/chat/scenes`
   * 能返回胶囊、点击也能触发一轮，但消息里那块 UI **永久降级成 `fallback_text`，
   * 不报错、不打日志**。人工 review 很难稳定发现，所以这里逐目录比对。
   */
  it('每个场景目录名 === meta.module_key，且点号命名', async () => {
    const metas = await loadSceneModuleCatalog();
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) {
      // 目录名不可能是空串；glob 匹配到的 key 必须能反向查到同一个 module。
      expect(knownSceneModuleKeys()).toContain(meta.module_key);
      // 点号命名 `<域>.<场景>`：裸单段会让「域」的分组能力消失。
      expect(meta.module_key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it('每个场景类型的默认 module 都已注册', async () => {
    const metas = await loadSceneModuleCatalog();
    const keys = new Set(metas.map((meta) => meta.module_key));
    // 不写死 module 清单：清单会随类型增长，而这条用例要守的是
    // 「`DEFAULT_MODULE_BY_SCENE_TYPE` 指向的 module 真的存在」这一条不变式。
    // 写死清单的后果是每次加类型都要改测试 —— 改测试时很容易顺手连断言一起
    // 放宽，于是真正该拦的问题（少建了 module）反而拦不住。
    for (const expected of Object.values(BACKEND_DEFAULT_MODULE_BY_TYPE)) {
      expect(keys.has(expected), expected).toBe(true);
    }
    // 反向：每个 module 都必须被某个类型用到，否则它是「建了但永远选不到」的死 module。
    const used = new Set(Object.values(BACKEND_DEFAULT_MODULE_BY_TYPE));
    for (const key of keys) {
      // `travel.itinerary` 是 `table_match` 的定制 module，不在默认映射里 ——
      // 它是「管理员主动选」的，不是「新建时的默认值」。
      if (key === 'travel.itinerary') continue;
      expect(used.has(key), key).toBe(true);
    }
  });

  it('每个类型的默认 module 都存在（否则胶囊点了没反应）', async () => {
    const metas = await loadSceneModuleCatalog();
    const keys = new Set(metas.map((meta) => meta.module_key));
    for (const type of BACKEND_SCENE_TYPES) {
      const expected = BACKEND_DEFAULT_MODULE_BY_TYPE[type];
      expect(keys.has(expected)).toBe(true);
      // 而且它必须支持这个类型，否则定义器下拉里根本选不到它。
      const meta = metas.find((item) => item.module_key === expected);
      expect(meta?.supported_scene_types).toContain(type);
    }
  });

  it('P0 每个 module 只声明一种场景类型（数组是过滤语义，不是多类型许可）', async () => {
    const metas = await loadSceneModuleCatalog();
    // 同样不写死总数：断言的是「每个 module 只声明一种类型」，
    // 而不是「一共有几个 module」。数字写死只会让新增类型时多改一行。
    expect(metas.length).toBeGreaterThan(0);
    for (const meta of metas) {
      // 为什么断言长度 1：`supported_scene_types` 是数组，是为了让
      // `modulesForSceneType()` 能用 `.includes()` 做**过滤**（同一个 module 将来
      // 可能被多个类型复用）。但**当前**每条 `data` 的消费形状只对应一种结果结构，
      // 所以 P0 不允许任何 module 声明两种以上 —— 真需要复用请拆成两个 module
      // 共享 `shared/`（arch §4.1.4 的原始论证仍然成立，只是约束点从类型挪到断言）。
      //
      // 这条断言防的是静默故障：有人给 module 加了第二个类型，代码不会报错，
      // 但运行时它会拿到另一种形状的 `data` 而渲染出错误内容。红一次，他就得来问。
      expect(meta.supported_scene_types.length, meta.module_key).toBe(1);
    }
  });

  it('每个 module 都声明了七项必填 meta', async () => {
    const metas = await loadSceneModuleCatalog();
    for (const meta of metas) {
      expect(meta.module_key).toBeTruthy();
      expect(meta.module_version).toBeGreaterThan(0);
      expect(meta.supported_scene_types.length).toBeGreaterThan(0);
      expect(String(meta.summary || '').trim().length).toBeGreaterThan(0);
      expect(Array.isArray(meta.required_slots)).toBe(true);
      expect(Array.isArray(meta.params_schema)).toBe(true);
      expect(['open_form', 'send_text']).toContain(meta.entry_behavior);
    }
  });

  it('module 层 needs_table 只收紧不放宽（对每个 module 都成立）', async () => {
    const metas = await loadSceneModuleCatalog();
    for (const meta of metas) {
      if (!meta.needs_table) continue;
      for (const type of meta.supported_scene_types) {
        const effective = effectiveNeedsTable(type, meta.needs_table);
        // 收紧是允许的；放宽不允许 —— 所以 effective 必须不弱于类型层档位。
        expect(NEEDS_TABLE_ORDER[effective])
          .toBeGreaterThanOrEqual(NEEDS_TABLE_ORDER[sceneTypeMeta(type).needs_table]);
      }
    }
  });
});