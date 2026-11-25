import { describe, expect, it } from 'vitest';

import type { SceneQualityIssue, SceneSlot } from '@/api/scenes';
import { tableCountWarnings } from '@/scenes/types';

import {
  bindingText,
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
 * 场景页面的纯逻辑层。
 *
 * 这里每条用例都对应一个「看起来对、实际会错」的判断。这些判断如果只靠点界面
 * 验证，改一次配置就要重跑一遍手工回归，而且回归列表没人维护。
 */

const slot = (key: string, target: string, label = key): SceneSlot => ({
  key,
  target,
  label,
  type: 'number',
});

describe('checkSlotMappings', () => {
  it('槽位全部指对列时没有问题', () => {
    const issues = checkSlotMappings(
      [slot('people', '人数'), slot('days', '天数'), slot('budget', '预算')],
      ['人数', '天数', '预算', '计划内容'],
      ['people', 'days', 'budget'],
    );
    expect(issues).toEqual([]);
  });

  it('指向表里不存在的列 → error（保存下去就是永远命中不到）', () => {
    const issues = checkSlotMappings([slot('people', '成团人数')], ['人数'], []);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toContain('成团人数');
  });

  it('多个槽位指向同一列 → error（同一个值当两个维度用，结果荒谬但不报错）', () => {
    const issues = checkSlotMappings(
      [slot('people', '人数'), slot('days', '人数')],
      ['人数'],
      [],
    );
    const dup = issues.find((issue) => issue.message.includes('共用'));
    expect(dup).toBeDefined();
    expect(dup!.level).toBe('error');
  });

  it('缺预算槽位 → warning 而非 error（方案允许只按部分维度筛）', () => {
    const issues = checkSlotMappings([slot('people', '人数')], ['人数'], ['people', 'budget']);
    const missing = issues.find((issue) => issue.key === 'budget');
    expect(missing).toBeDefined();
    expect(missing!.level).toBe('warning');
    expect(missing!.message).toContain('天数排序');
  });

  it('没有 target 的槽位 → error', () => {
    const issues = checkSlotMappings([{ key: 'people', target: '' }], ['人数'], []);
    expect(issues[0].level).toBe('error');
  });

  it('列还没加载（columnKeys 为空）时不误报「列不存在」', () => {
    // 数据表刚选上、预览还没回来，此时报错会让用户以为配错了
    const issues = checkSlotMappings([slot('people', '人数')], [], []);
    expect(issues.filter((issue) => issue.message.includes('没有'))).toEqual([]);
  });
});

describe('splitQuality', () => {
  it('error 拦、warning 放行', () => {
    const quality: SceneQualityIssue[] = [
      { level: 'error', code: 'empty_table', message: '空表', column: '', row_count: 0 },
      { level: 'warning', code: 'unit_mismatch', message: '单位不符', column: '人数', row_count: 2 },
      { level: 'info', code: 'note', message: '提示', column: '', row_count: 0 },
    ];
    const { blocking, warnings } = splitQuality(quality);
    expect(blocking.map((item) => item.code)).toEqual(['empty_table']);
    expect(warnings.map((item) => item.code)).toEqual(['unit_mismatch', 'note']);
  });

  it('没有问题时两边都空（不是 undefined，调用方要能直接 .length）', () => {
    const { blocking, warnings } = splitQuality([]);
    expect(blocking).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('qualityLevelText', () => {
  it('三种级别各有中文文案', () => {
    expect(qualityLevelText('error')).toBe('必须修复');
    expect(qualityLevelText('warning')).toBe('建议检查');
    expect(qualityLevelText('info')).toBe('提示');
  });
});

describe('publishBlockers', () => {
  const table = ['人数', '天数', '预算'];

  it('配完整时没有阻塞项', () => {
    const blockers = publishBlockers(
      {
        table_ids: ['t1'],
        scene_type: 'table_match',
        slots: [slot('people', '人数'), slot('days', '天数'), slot('budget', '预算')],
        respond_action: { mode: 'template', template: '{{预算}}' },
      },
      table,
    );
    expect(blockers).toEqual([]);
  });

  it('没配槽位 / 模板空 都要拦住', () => {
    const blockers = publishBlockers(
      {
        table_ids: [],
        scene_type: 'table_match',
        slots: [],
        respond_action: { mode: 'template', template: '  ' },
      },
      [],
    );
    expect(blockers.some((item) => item.includes('槽位'))).toBe(true);
    // 模板空且 mode=template 才算问题；mode=llm 不需要模板
    expect(blockers.some((item) => item.includes('模版') || item.includes('模板'))).toBe(true);
  });

  /**
   * 这条是本文件最重要的一条断言。
   *
   * 曾经的 bug：`publishBlockers` 里写 `if (!scene.table_id) blockers.push('还没选数据表')`。
   * v3 删掉 `table_id` 之后该字段恒 `undefined` → **任何场景都发布不了**，
   * 而当时所有夹具都还带着 `table_id: 'tbl_x'`，所以 66 条测试全绿。
   *
   * 现在把「表数量」口头交给 `tableCountIssues`，档位随类型变：
   * `table_match` 是 `optional`（0 张表不阻断），`script` 是 `none`（也不阻断）。
   * 这两个类型 0 张表时必须**没有**表相关阻断。
   */
  it('table_match / script 在 0 张表时不得产生表相关阻断（回归：曾恒阻断）', () => {
    const base = {
      slots: [slot('people', '人数')],
      respond_action: { mode: 'template' as const, template: 'x' },
    };
    for (const type of ['table_match', 'script'] as const) {
      const blockers = publishBlockers(
        { ...base, table_ids: [], scene_type: type },
        table,
      );
      expect(
        blockers.some((item) => item.includes('表')),
        `${type} 在 0 张表时不该有表相关阻断，实际得到 ${JSON.stringify(blockers)}`,
      ).toBe(false);
    }
  });

  it('mode=llm 时不要求模板', () => {
    const blockers = publishBlockers(
      {
        table_ids: ['t1'],
        scene_type: 'table_match',
        slots: [slot('people', '人数')],
        respond_action: { mode: 'llm', template: '' },
      },
      table,
    );
    expect(blockers.some((item) => item.includes('模版') || item.includes('模板'))).toBe(false);
  });

  /**
   * 这两条是「0 张表可发布」与「required 要阻断」的唯一分界线。
   *
   * 少了第二条，实现里很容易把两件事合并成「一律不阻断」——所有用例照样绿，
   * 但 `travel.itinerary`（`needs_table: 'required'`）缺表也能发布，发布后
   * 它画不出空态，用户看到白块。
   *
   * 关键点：`table_match` 在类型层是 `optional`，`required` **只可能来自
   * module**。所以第二条必须走 moduleNeeds 参数，不能靠换 scene_type 达到——
   * 类型层根本没有 required 档。
   */
  it('0 张表的 table_match 场景可以发布（只 warning 不阻断）', () => {
    const blockers = publishBlockers(
      {
        table_ids: [],
        scene_type: 'table_match',
        slots: [slot('people', '人数')],
        respond_action: { mode: 'template', template: 'x' },
      },
      table,
    );
    expect(blockers).not.toContain('还没选数据表');
    expect(blockers.some((item) => item.includes('数据表'))).toBe(false);
    // 同时断言 warning 通道**确实有话说**：不阻断 ≠ 不提示。
    // 若这里也空，说明「只 warning」退化成了「什么都不说」。
    expect(tableCountWarnings('table_match', 0)).toHaveLength(1);
  });

  it('module 声明 required 时 0 张表阻断（与上一条的唯一区别）', () => {
    const scene = {
      table_ids: [] as string[],
      scene_type: 'table_match' as const,
      slots: [slot('people', '人数')],
      respond_action: { mode: 'template' as const, template: 'x' },
    };
    const optional = publishBlockers(scene, table, 'optional');
    const required = publishBlockers(scene, table, 'required');
    // 同一种 scene_type、同一个表数量，只因 module 档位不同结论就相反。
    expect(optional.some((item) => item.includes('数据表'))).toBe(false);
    expect(required.length).toBeGreaterThan(optional.length);
    expect(required.some((item) => item.includes('数据表'))).toBe(true);
  });

  it('required 档在 0 张表时不再同时进 warning 通道（避免又报错又安抚）', () => {
    expect(tableCountWarnings('table_match', 0, 'required')).toEqual([]);
  });

  it('槽位指向不存在的列时拦住发布', () => {
    const blockers = publishBlockers(
      {
        table_ids: ['t1'],
        scene_type: 'table_match',
        slots: [slot('people', '不存在的列')],
        respond_action: { mode: 'template', template: 'x' },
      },
      table,
    );
    expect(blockers.some((item) => item.includes('不存在'))).toBe(true);
  });

  it('「没绑员工」不算阻塞项（可以先建后挂）', () => {
    const blockers = publishBlockers(
      {
        table_ids: ['t1'],
        scene_type: 'table_match',
        slots: [slot('people', '人数')],
        respond_action: { mode: 'template', template: 'x' },
      },
      table,
    );
    expect(blockers.some((item) => item.includes('员工'))).toBe(false);
  });
});

describe('explainRunResult', () => {
  const base = {
    scene_id: 's1',
    hits: [],
    ranked: [],
    steps: [],
    total: 0,
    normalized_count: 0,
    unconvertible: 0,
    gate_out: 0,
    reranked: false,
    model_used: false,
    invalid_budget: false,
    empty_reason: '',
    run_id: '',
  };

  it('有命中时不需要解释', () => {
    expect(
      explainRunResult({
        ...base,
        hits: [{ row_id: 'r1', values: {}, score: 0, days_dev: 0, budget_dev: 0, fused: null }],
      }),
    ).toBe('');
  });

  it('优先用后端给的量化原因', () => {
    expect(
      explainRunResult({ ...base, total: 5, empty_reason: '表里没有 99 人的方案' }),
    ).toBe('表里没有 99 人的方案');
  });

  it('后端没给原因时必须给兜底文案，不能返回空串', () => {
    // 空串会让界面显示「暂无结果」——等于把问题丢回给用户
    const text = explainRunResult({ ...base, total: 5 });
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('放宽');
  });

  it('表里没数据时说的是「导入数据」而不是「放宽条件」', () => {
    expect(explainRunResult({ ...base, total: 0 })).toContain('数据');
  });

  it('null 结果返回空串', () => {
    expect(explainRunResult(null)).toBe('');
  });
});

describe('visibleSteps', () => {
  it('保留第一步，跳过没筛掉任何东西的步骤', () => {
    const steps = [
      { key: 'normalize', label: '解析', detail: '', from: 5, to: 5, dropText: '', ratio: 0 },
      { key: 'people', label: '人数', detail: '', from: 5, to: 5, dropText: '', ratio: 0 },
      { key: 'days', label: '天数', detail: '', from: 5, to: 2, dropText: '3 行', ratio: 0.6 },
    ];
    expect(visibleSteps(steps).map((step) => step.key)).toEqual(['normalize', 'days']);
  });

  it('全都没筛掉时至少留第一步（否则漏斗是空白的）', () => {
    const steps = [{ key: 'normalize', label: '解析', detail: '', from: 3, to: 3, dropText: '', ratio: 0 }];
    expect(visibleSteps(steps)).toHaveLength(1);
  });
});

describe('hitRatioText', () => {
  it('0 行数据时显示破折号而不是 0%', () => {
    // 0% 读起来像「一条都没匹配上」，会让用户去调条件，但其实是表里没数据
    expect(hitRatioText(0, 0)).toBe('—');
  });

  it('正常按百分比取整', () => {
    expect(hitRatioText(1, 3)).toBe('33%');
    expect(hitRatioText(3, 3)).toBe('100%');
  });
});

describe('renderTemplate', () => {
  const values = { 计划内容: '经典雪山五日', 预算: 3000, 备注: null };

  it('替换 {{列名}} 占位符', () => {
    expect(renderTemplate('推荐 {{计划内容}}', values)).toBe('推荐 经典雪山五日');
  });

  it('占位符容忍空格', () => {
    expect(renderTemplate('{{ 预算 }} 元', values)).toBe('3000 元');
  });

  it('null 值渲染成空串而不是 "null"', () => {
    expect(renderTemplate('备注：{{备注}}', values)).toBe('备注：');
  });

  it('未知占位符原样保留（让用户看出写错了，而不是静默消失）', () => {
    expect(renderTemplate('{{不存在}}', values)).toBe('{{不存在}}');
  });

  it('空模板返回空串', () => {
    expect(renderTemplate('', values)).toBe('');
  });

  it('不误伤正文里的单花括号（JSON 片段）', () => {
    const text = renderTemplate('{"a":1} 和 {{预算}}', values);
    expect(text).toBe('{"a":1} 和 3000');
  });
});

describe('unknownTemplateKeys', () => {
  it('列出模板里表没有的列', () => {
    expect(unknownTemplateKeys('{{预算}} {{乱写}}', ['预算', '人数'])).toEqual(['乱写']);
  });

  it('全部合法时返回空数组', () => {
    expect(unknownTemplateKeys('{{预算}}', ['预算'])).toEqual([]);
  });

  it('重复的错误占位符只报一次', () => {
    expect(unknownTemplateKeys('{{乱写}}{{乱写}}', [])).toEqual(['乱写']);
  });
});

describe('parseSlotInput', () => {
  it('空串返回 null 而不是 0（「没填」不等于「填了 0」）', () => {
    expect(parseSlotInput('')).toBeNull();
    expect(parseSlotInput('   ')).toBeNull();
  });

  it('正常数字解析', () => {
    expect(parseSlotInput(' 3000 ')).toBe(3000);
    expect(parseSlotInput('4.5')).toBe(4.5);
  });

  it('非数字返回 null', () => {
    expect(parseSlotInput('三千')).toBeNull();
    expect(parseSlotInput('abc')).toBeNull();
  });
});

describe('bindingText', () => {
  it('0 个员工说「未绑定」而不是空白', () => {
    expect(bindingText([], {})).toBe('未绑定员工');
  });

  it('1~2 个直接列名字', () => {
    expect(bindingText(['a1'], { a1: '行程管家' })).toBe('已绑定 行程管家');
    expect(bindingText(['a1', 'a2'], { a1: 'A', a2: 'B' })).toBe('已绑定 A、B');
  });

  it('3 个以上只显示第一个 + 总数', () => {
    expect(bindingText(['a1', 'a2', 'a3'], { a1: 'A' })).toBe('已绑定 A 等 3 个员工');
  });

  it('查不到名字时退回 id（不能显示空白）', () => {
    expect(bindingText(['agent_x'], {})).toBe('已绑定 agent_x');
  });
});

describe('statusMeta', () => {
  it('三种状态有对应文案与色调', () => {
    expect(statusMeta('published')).toEqual({ label: '已发布', tone: 'green' });
    expect(statusMeta('draft')).toEqual({ label: '草稿', tone: 'orange' });
    expect(statusMeta('archived')).toEqual({ label: '已归档', tone: 'gray' });
  });

  it('未知状态退回灰底并原样显示（不能变成空白）', () => {
    const meta = statusMeta('weird');
    expect(meta.tone).toBe('gray');
    expect(meta.label).toBe('weird');
  });

  it('空状态不显示成空白', () => {
    expect(statusMeta('').label).toBe('未知');
  });
});