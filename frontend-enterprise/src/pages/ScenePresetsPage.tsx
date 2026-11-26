import { useCallback, useEffect, useMemo, useState } from 'react';
import { Save as SaveIcon, Sparkles } from 'lucide-react';
import {
  Button as UIButton,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Switch,
  Textarea,
  notify,
} from '@/components/ui';
import {
  listScenePresets,
  saveScenePreset,
  type ScenePresetPayload,
  type ScenePresetRead,
} from '../api/scenes';
import { loadSceneModule, metaForModule, useSceneModuleCatalog } from '@/scenes/registry';
import type { SceneModule, SceneUiBlock } from '@/scenes/types';
import type { EnterpriseAuthUser } from '../auth';

/**
 * 场景预设配置页（**L2 层**，只有超管能进）。
 *
 * ## 这页解决的问题
 *
 * 场景能力分三层，这页管中间那层：
 *
 * | 层 | 谁定 | 存在哪 | 改它要发版吗 |
 * |---|---|---|---|
 * | L1 module 实现 | 开发者写代码 | `src/scenes/modules/<module_key>/` | **要** |
 * | **L2 预设（本页）** | 超管 | `scene_presets` 表 | **不要** |
 * | L3 场景实例 | 用户 | `scenes` 表 | 不要 |
 *
 * 用户建场景时只填名称/图标/描述/槽位/匹配策略；「按钮叫什么」「价格说明写什么」
 * 「兜底文案是什么」这些**全局参数**在这里改一次，全租户所有存量场景立即生效
 * （渲染时实时回读，见 `backend/app/scenes/presets.py::effective_ui_config`）。
 *
 * ## 为什么右边有真卡片预览
 *
 * 改「主按钮文案」时如果不看卡片，你不知道改完长短会不会把价格条挤换行。
 * 所以右侧用**同一个 module 组件**渲染样例数据 —— 与聊天里一致，
 * 不是另外画一张示意图（`docs/scenes/scene-v3-visual-contract.md` §0 第 3 条）。
 *
 * ## 为什么参数编辑是「结构化表单 + JSON 兜底」而不是纯 JSON 输入框
 *
 * 纯 JSON 让超管手写嵌套结构，一个逗号错就整体保存失败且看不出错在哪；
 * 纯表单又表达不了将来 module 新增的任意参数。折中：**常用项做成表单**，
 * 下面留一个「完整 JSON」折叠区给高级改动（它才是真正提交的内容）。
 */

type FormState = {
  display_name: string;
  icon: string;
  enabled: boolean;
  order_index: string;
  /** 完整 JSON 文本。提交的就是它（表单改动会同步进来）。 */
  json: string;
};

const EMPTY_FORM: FormState = {
  display_name: '',
  icon: '',
  enabled: true,
  order_index: '0',
  json: '{}',
};

export default function ScenePresetsPage({ currentUser: _currentUser }: { currentUser: EnterpriseAuthUser }) {
  const [rows, setRows] = useState<ScenePresetRead[]>([]);
  const [activeKey, setActiveKey] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  /** module 目录（预览要用它拿真实组件）。 */
  const { metas: moduleMetas } = useSceneModuleCatalog();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listScenePresets();
      setRows(list);
      setActiveKey((current) => {
        if (current && list.some((row) => row.module_key === current)) return current;
        return list[0]?.module_key ?? '';
      });
      setResetKey((value) => value + 1);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '读取场景预设失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(
    () => rows.find((row) => row.module_key === activeKey) ?? null,
    [activeKey, rows],
  );

  // 切预设时重置表单（含 JSON 文本）——否则会把上一项的 JSON 存到这一项上
  useEffect(() => {
    if (!active) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      display_name: active.display_name,
      icon: active.icon,
      enabled: active.enabled,
      order_index: String(active.order_index ?? 0),
      json: JSON.stringify(active.preset_json ?? {}, null, 2),
    });
    setResetKey((value) => value + 1);
  }, [active]);

  /** JSON 解析后的对象。解析失败时返回 null —— 界面要能明确告警而不是静默用旧值。 */
  const parsed = useMemo((): ScenePresetPayload | null => {
    try {
      const value: unknown = JSON.parse(form.json || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      return value as ScenePresetPayload;
    } catch {
      return null;
    }
  }, [form.json]);

  const jsonError = parsed === null;

  /**
   * 改某个表单字段，**同步写回 JSON 文本**。
   *
   * 为什么必须同步：提交的永远是 `form.json`（那是唯一事实来源）。
   * 只改表单 state 不同步 JSON 的话，用户改完按钮文案点保存，存进去的还是旧 JSON
   * —— 最典型的「看起来保存了却没生效」。
   */
  function patchJson(mutator: (payload: ScenePresetPayload) => void) {
    if (!parsed) return;
    const next: ScenePresetPayload = JSON.parse(JSON.stringify(parsed));
    mutator(next);
    setForm((current) => ({ ...current, json: JSON.stringify(next, null, 2) }));
  }

  async function save() {
    if (!active) return;
    if (!parsed) {
      notify.error('JSON 格式不对，先修好再保存');
      return;
    }
    setSaving(true);
    try {
      await saveScenePreset(active.module_key, {
        display_name: form.display_name.trim() || active.module_key,
        // scene_type 不在 JSON 里改（它由 module 实现决定，不是文案），原样回传
        scene_type: active.scene_type,
        icon: form.icon.trim(),
        enabled: form.enabled,
        order_index: Number(form.order_index) || 0,
        preset_json: parsed,
      });
      notify.success('已保存，所有使用这个场景的配置会立即生效');
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  /*
   * 「恢复出厂」按钮已删除（用户明确要求）。
   *
   * 它做的是 `resetScenePreset()` —— 删掉库里的覆盖行，回落到
   * `presets.py::BUILTIN_PRESETS` 常量。对一个改坏了配置的管理员这确实有用，
   * 但代价是它**没有确认步骤**（点了立即生效、覆盖全部字段），
   * 而这一页的每个字段都能手改回来。一个不可撤销、覆盖全页的按钮
   * 放在「保存预设」旁边，误点的概率远高于真需要的概率。
   *
   * 后端接口 `DELETE /api/scene-presets/{module_key}` 仍然保留：
   * 它是「恢复出厂」这个能力的唯一入口，运维/脚本还要用。
   * 这里删掉的只是 UI 入口，不是能力本身。
   */

  const params = (parsed?.ui_config?.params ?? {}) as Record<string, unknown>;

  /**
   * 当前 module 声明了哪些参数键。
   *
   * 用来决定「按钮文案」这类**只对某些 module 有意义**的字段是否渲染。
   * 判据取 `params_schema` 而不是写死 module_key：将来别的 module 加回按钮、
   * 或者加一个新参数，这页不用跟着改。
   */
  const paramFieldKeys = new Set(
    (metaForModule(moduleMetas, active?.module_key)?.params_schema ?? []).map((field) => field.key),
  );

  return (
    <>
      <div className="page-title" style={{ paddingRight: 0 }}>
        <div>
          <h3>场景预设</h3>
          <p className="text-[12px] text-muted-foreground">
            这里定义每个场景类型的<b>全局参数</b>：按钮文案、价格说明、兜底文本、默认匹配策略。
            用户建场景时只填名称/图标/描述，其余都吃这里的值；改完立即对全部存量场景生效，不用重新保存场景。
          </p>
        </div>
        <div className="flex items-center gap-[8px]" style={{ alignSelf: 'flex-end' }}>
          <UIButton disabled={saving || !active || jsonError} onClick={() => void save()}>
            <SaveIcon className="size-[14px]" />
            {saving ? '保存中…' : '保存预设'}
          </UIButton>
        </div>
      </div>

      <div className="mx-[28px] max-[760px]:mx-[16px] flex gap-[16px] items-start">
        {/* 左：预设清单 */}
        <div className="w-[240px] shrink-0 max-[900px]:hidden">
          <Card>
            <CardHeader>
              <CardTitle className="text-[13px]">场景类型</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-[6px]">
              {loading ? (
                <p className="m-0 text-[12px] text-muted-foreground">加载中…</p>
              ) : rows.length === 0 ? (
                // 空态说清是「开发还没登记预设」而不是「加载失败」
                <p className="m-0 text-[12px] leading-[18px] text-muted-foreground">
                  还没有可配置的场景类型。新增定制 module 后，开发者会在后端登记一份出厂预设。
                </p>
              ) : (
                rows.map((row) => {
                  const picked = row.module_key === activeKey;
                  return (
                    <button
                      key={row.module_key}
                      type="button"
                      onClick={() => setActiveKey(row.module_key)}
                      className={`flex w-full items-start gap-[8px] rounded-[9px] border px-[10px] py-[8px] text-left transition-colors ${
                        picked
                          ? 'border-[#0f766e] bg-[#e1f1ed]'
                          : 'border-[#ded7cc] bg-white hover:border-[#0f766e]'
                      }`}
                    >
                      <span className="mt-[1px] text-[15px]">{row.icon || '·'}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-[5px]">
                          <span className="truncate text-[12.5px] font-semibold text-[#18181a]">
                            {row.display_name || row.module_key}
                          </span>
                          {!row.enabled && (
                            <span className="shrink-0 rounded-full bg-[#f2f1ee] px-[5px] py-[1px] text-[9.5px] text-[#6d6d72]">
                              已停用
                            </span>
                          )}
                        </span>
                        <span className="mt-[1px] block truncate font-mono text-[10.5px] text-[#9a9b95]">
                          {row.module_key}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>

        {/* 右：编辑 + 预览 */}
        <div className="min-w-0 flex-1">
          {!active ? (
            <Card>
              <CardContent className="py-[28px] text-center text-[12.5px] text-muted-foreground">
                左边选一个场景类型开始配置。
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-[16px] xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="flex min-w-0 flex-col gap-[16px]">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-[13px]">基础信息</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-[14px]">
                    <LabeledField
                      label="场景类型名称"
                      hint="用户在「新建场景」下拉里看到的名字"
                    >
                      <Input
                        value={form.display_name}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, display_name: event.target.value }))
                        }
                        placeholder="行程规划"
                      />
                    </LabeledField>
                    <LabeledField label="默认图标" hint="新建场景时的默认值，用户也可以换">
                      <Input
                        value={form.icon}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, icon: event.target.value }))
                        }
                        placeholder="🎿"
                        className="w-[120px]"
                      />
                    </LabeledField>
                    <LabeledField label="下拉排序" hint="数字小的排前面">
                      <Input
                        type="number"
                        value={form.order_index}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, order_index: event.target.value }))
                        }
                        className="w-[120px]"
                      />
                    </LabeledField>
                    <SwitchRow
                      label="允许用户新建这个场景类型"
                      hint="关闭后它不再出现在「新建场景」下拉里。已建好的场景不受影响"
                      checked={form.enabled}
                      onChange={(next) => setForm((current) => ({ ...current, enabled: next }))}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-[7px] text-[13px]">
                      <Sparkles className="size-[14px] text-[#0f766e]" />
                      回答参数
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-[14px]">
                    <p className="m-0 rounded-[9px] bg-[#f7faff] px-[11px] py-[8px] text-[11px] leading-[17px] text-[#52637d]">
                      这几项决定用户在聊天里看到的卡片长什么样。改完保存，全部存量场景立即生效。
                    </p>
                    {/*
                      按钮文案只给**卡片上真有按钮**的 module 渲染。
                      `travel.itinerary` 的行程卡已经不放「选这个 / 看详情」了
                      （理由见 `ItineraryCard` 价格条注释），这里再留两个输入框，
                      超管会改完保存、然后在预览里找不到任何变化 —— 比没有更糟。
                      判据读 module 的 `params_schema`（声明了才渲染），
                      而不是写死 module_key：将来别的 module 加回按钮不用改这页。
                    */}
                    {paramFieldKeys.has('primary_action_label') && (
                      <LabeledField label="主按钮文案" hint="卡片右下角那个实心按钮">
                        <Input
                          value={String(params.primary_action_label ?? '')}
                          onChange={(event) =>
                            patchJson((payload) => {
                              payload.ui_config = payload.ui_config ?? {};
                              payload.ui_config.params = payload.ui_config.params ?? {};
                              payload.ui_config.params.primary_action_label = event.target.value;
                            })
                          }
                          placeholder="选这个"
                        />
                      </LabeledField>
                    )}
                    {paramFieldKeys.has('secondary_action_label') && (
                      <LabeledField label="次按钮文案" hint="主按钮左边的描边按钮">
                        <Input
                          value={String(params.secondary_action_label ?? '')}
                          onChange={(event) =>
                            patchJson((payload) => {
                              payload.ui_config = payload.ui_config ?? {};
                              payload.ui_config.params = payload.ui_config.params ?? {};
                              payload.ui_config.params.secondary_action_label = event.target.value;
                            })
                          }
                          placeholder="看详情"
                        />
                      </LabeledField>
                    )}
                    <LabeledField label="价格说明" hint="跟在金额后面的小字">
                      <Input
                        value={String(params.price_note ?? '')}
                        onChange={(event) =>
                          patchJson((payload) => {
                            payload.ui_config = payload.ui_config ?? {};
                            payload.ui_config.params = payload.ui_config.params ?? {};
                            payload.ui_config.params.price_note = event.target.value;
                          })
                        }
                        placeholder="/人 · 含住宿、雪票、教练、接送"
                      />
                    </LabeledField>
                    <SwitchRow
                      label="副标题显示来源表名"
                      hint="多表合并查的时候，显示这一行来自哪张表"
                      checked={params.show_source_table !== false}
                      onChange={(next) =>
                        patchJson((payload) => {
                          payload.ui_config = payload.ui_config ?? {};
                          payload.ui_config.params = payload.ui_config.params ?? {};
                          payload.ui_config.params.show_source_table = next;
                        })
                      }
                    />
                    <LabeledField label="兜底文本" hint="卡片渲染不出来时，用户看到的纯文本">
                      <Textarea
                        rows={2}
                        value={String(parsed?.ui_config?.fallback_text ?? '')}
                        onChange={(event) =>
                          patchJson((payload) => {
                            payload.ui_config = payload.ui_config ?? {};
                            payload.ui_config.fallback_text = event.target.value;
                          })
                        }
                        placeholder="找到了合适的行程，详情看上方的卡片"
                      />
                    </LabeledField>
                    {/*
                      两句表单文案：这里是**新建场景时的预填值**，员工在定义器里能改。

                      生效方向（别搞反）：`effective_ui_config()` 是
                      **场景自己显式配了的键优先**，预设只补场景没配的键。
                      所以员工改过 `form_subtitle`，这里再改**不会**盖掉他 ——
                      这一栏只在「员工留空」或「还没建场景」时起作用。

                      ⚠️ 引导语（`respond_action.ask_prompt`）不在这页配，也不要搬进来：
                      它存在场景自己的 `respond_action_json` 里，**完全不经过**
                      `effective_ui_config()` 的合并（见 `channels.py::_run_table_match`）。
                      在这一页给它输入框，超管改完保存，任何已有场景都不会变 ——
                      「改了没反应」，这正是上面主/次按钮文案被删掉的原因。
                      它只能由员工在场景定义器里配。
                    */}
                    <LabeledField
                      label="表单卡头副标题"
                      hint="员工新建场景时的预填值，员工可改；留空则后端按类型给默认句"
                    >
                      <Input
                        value={String(parsed?.ui_config?.form_subtitle ?? '')}
                        onChange={(event) =>
                          patchJson((payload) => {
                            payload.ui_config = payload.ui_config ?? {};
                            payload.ui_config.form_subtitle = event.target.value;
                          })
                        }
                        placeholder="填好这几项，我按方案表逐条比对"
                      />
                    </LabeledField>
                    <LabeledField
                      label="新建场景时的默认描述"
                      hint="用户建场景时预填这一段，可以自己改"
                    >
                      <Textarea
                        rows={2}
                        value={String(parsed?.description ?? '')}
                        onChange={(event) =>
                          patchJson((payload) => {
                            payload.description = event.target.value;
                          })
                        }
                        placeholder="根据人数、天数、预算，从价目表里推荐合适的行程"
                      />
                    </LabeledField>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-[13px]">完整 JSON（高级）</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-[10px]">
                    <p className="m-0 text-[11px] leading-[17px] text-muted-foreground">
                      上面表单改的就是这份 JSON。槽位、匹配策略、触发条件这些没有表单的项在这里改。
                      <b className="text-[#b45309]">保存提交的是这份 JSON</b>，格式错了不能保存。
                    </p>
                    <textarea
                      value={form.json}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, json: event.target.value }))
                      }
                      spellCheck={false}
                      rows={18}
                      className={`w-full resize-y rounded-[8px] border px-[10px] py-[8px] font-mono text-[11.5px] leading-[18px] outline-none ${
                        jsonError
                          ? 'border-[#dc2626] bg-[#fef7f7] text-[#7f1d1d]'
                          : 'border-[rgba(24,24,26,0.14)] bg-white text-[#18181a] focus:border-[#0f766e]'
                      }`}
                    />
                    {jsonError && (
                      <p className="m-0 text-[11.5px] leading-[17px] text-[#dc2626]">
                        JSON 格式有误（多一个逗号 / 少一个引号都会这样）。修好才能保存。
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* 右：真卡片预览 */}
              <div className="xl:sticky xl:top-[16px] xl:self-start">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-[13px]">用户看到的卡片</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <PresetPreview
                      moduleKey={active.module_key}
                      params={params}
                      resetKey={resetKey}
                      summary={metaForModule(moduleMetas, active.module_key)?.summary ?? ''}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 用真 module 组件渲染样例数据。
 *
 * `resetKey` 变化时重新加载：同一 module 换参数后组件要重渲染才能看到新文案。
 * 只用 `params` 做依赖不够 —— `params` 是新对象但 module chunk 不变，
 * 组件内部可能做了 memo，改文案会看不到变化（那是错的行为，但这里不赌）。
 */
function PresetPreview({
  moduleKey,
  params,
  resetKey,
  summary,
}: {
  moduleKey: string;
  params: Record<string, unknown>;
  resetKey: number;
  summary: string;
}) {
  const [module, setModule] = useState<SceneModule | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setModule(null);
    setFailed(false);
    void (async () => {
      const mod = await loadSceneModule(moduleKey);
      if (!alive) return;
      if (mod) setModule(mod);
      else setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [moduleKey, resetKey]);

  if (failed) {
    return (
      <p className="m-0 rounded-[9px] bg-[#fff2e5] px-[11px] py-[9px] text-[11.5px] leading-[17px] text-[#b45309]">
        没有找到「{moduleKey}」的界面组件。这个场景会退回纯文本回答。
      </p>
    );
  }
  if (!module) {
    return <p className="m-0 text-[12px] text-muted-foreground">加载预览…</p>;
  }
  const Card0 = module.ResultCard;
  if (!Card0) {
    return (
      <p className="m-0 rounded-[9px] bg-[#fbfaf6] px-[11px] py-[9px] text-[11.5px] leading-[17px] text-muted-foreground">
        这个场景的回答是纯文本，没有卡片界面。{summary ? `（${summary}）` : ''}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-[8px]">
      <p className="m-0 text-[10.5px] text-muted-foreground">样例数据 · 改上面参数会同步反映</p>
      <div className="rounded-[12px] border border-dashed border-[#cfc5b7] bg-[#fbfaf6] p-[10px]">
        <Card0
          block={PREVIEW_BLOCK}
          siblings={[PREVIEW_BLOCK]}
          params={params}
          sendText={() => {}}
          submitSlots={() => {}}
          openExternal={() => {}}
          disabled
        />
      </div>
    </div>
  );
}

/** 预览样例数据（与定义器里那份同源，见 `SceneEditor.tsx` 的说明）。 */
const PREVIEW_BLOCK: SceneUiBlock = {
  kind: 'result',
  module_key: '',
  module_version: 0,
  fallback_text: '',
  data: {
    total: 1,
    max_items: 1,
    items: [
      {
        row_id: 'preview-1',
        score: 0,
        source_table: '滑雪套餐价目表',
        values: {
          计划内容: '经典雪山五日',
          目的地: '亚布力',
          人数: 4,
          天数: 5,
          预算: 3000,
          日程: [
            { title: '抵达亚布力', description: '哈尔滨接站，入住雪场酒店。', tags: ['含接站', '含晚餐'], phase: '抵达' },
            { title: '初级道练习', description: '上午教练带练，下午自由滑。', tags: ['含雪票', '含教练'], phase: '初级' },
            { title: '进阶训练', description: '中级道压弯与回转技巧。', tags: ['含教练'], phase: '进阶' },
            { title: '自由滑行', description: '全天自由安排，可选雪地摩托。', tags: ['自由活动'], phase: '自由' },
            { title: '返程', description: '早餐后送站。', tags: ['含送站'], phase: '返程' },
          ],
        },
      },
    ],
  },
};

/** 带标签 + 说明的字段（与 `RuntimeSettingsPage` 的 `LabeledField` 视觉一致）。 */
function LabeledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="text-[12px] text-[#343633]">{label}</span>
      {hint ? <span className="text-[11px] leading-[16px] text-muted-foreground">{hint}</span> : null}
      {children}
    </label>
  );
}

function SwitchRow({
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
    <div className="flex items-start justify-between gap-[14px]">
      <span className="flex min-w-0 flex-col gap-[2px]">
        <span className="text-[12px] text-[#343633]">{label}</span>
        <span className="text-[11px] leading-[16px] text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}