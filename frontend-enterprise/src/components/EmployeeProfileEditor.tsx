import { IdcardOutlined, PlusOutlined } from '../icons';
import { Share2, X as XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  Button as UIButton,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  notify,
} from '@/components/ui';
import { SELECT_TRIGGER_CLASS } from '@/lib/enterprise-ui';
import { toClientDateISO } from '@/lib/timezone';
import { api, TENANT_ID } from '../api/client';
import AgentShareDialog from './AgentShareDialog';
import type { EnterpriseAuthUser } from '../auth';
import {
  GREETING_MESSAGE_MAX_LENGTH,
  SUGGESTED_PROMPT_LIMIT,
  SUGGESTED_PROMPT_MAX_LENGTH,
  employeeDisplayName,
  employeeProfile,
  greetingPreviewText,
  normalizeGreetingMessage,
  normalizeSuggestedPrompts,
} from '../employee';
import type { AgentProfileRead } from '../types';
import EmployeeAvatar from './EmployeeAvatar';

type EmployeeProfileFormValues = {
  name: string;
  roleName: string;
  onboardedAt: string;
  description: string;
  personaPrompt: string;
  systemPromptSummary: string;
  workStyles: string[];
  expertiseTags: string[];
  workModes: string[];
  /** 聊天空态展示的快捷提问（1-3 条），落到 metadata.suggested_prompts。 */
  suggestedPrompts: string[];
  /** 新建会话时主动发的开场白正文（不含抬头），落到 metadata.greeting_message。 */
  greetingMessage: string;
  harnessMaxActions: number;
  status: 'active' | 'archived';
  publishedToGallery: boolean;
};

const STYLE_OPTIONS = ['目标明确', '证据优先', '动作可追溯', '事实先行', '流程推进', '风险克制', '及时追问'];
const EXPERTISE_OPTIONS = ['业务问答', 'SOP 执行', '工具调用', '代码检索', '报销核对', '事务跟进', '资料维护'];
const WORK_MODE_OPTIONS = ['识别意图', '补齐信息', '调用 SOP', '查询资料', '执行并复盘', '确认后执行', '必要时转人工'];

/** 快捷提问的占位符按行给引导，第一行示范「查资料」，后面示范「要产出」。 */
const SUGGESTED_PROMPT_PLACEHOLDERS = [
  '例如：帮我查一下最新的报销标准',
  '例如：把这周的会议纪要整理成待办',
  '例如：给我一份本周工作复盘提纲',
];

const BLANK_FORM: EmployeeProfileFormValues = {
  name: '',
  roleName: '',
  onboardedAt: '',
  description: '',
  personaPrompt: '',
  systemPromptSummary: '',
  workStyles: [],
  expertiseTags: [],
  workModes: [],
  suggestedPrompts: [],
  greetingMessage: '',
  harnessMaxActions: 32,
  status: 'active',
  publishedToGallery: false,
};

export default function EmployeeProfileEditor({
  agent,
  open,
  onClose,
  onSaved,
  currentUser,
}: {
  agent?: AgentProfileRead | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (agent: AgentProfileRead) => void;
  currentUser?: EnterpriseAuthUser;
}) {
  const [form, setForm] = useState<EmployeeProfileFormValues>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const profile = useMemo(() => employeeProfile(agent), [agent]);

  const update = (patch: Partial<EmployeeProfileFormValues>) => setForm((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open || !agent) return;
    setForm({
      name: employeeDisplayName(agent),
      roleName: profile.roleName === '待补充岗位' ? '' : profile.roleName,
      onboardedAt: profile.onboardedAt === '-' ? toClientDateISO(new Date()) : profile.onboardedAt,
      description: agent.description || '',
      personaPrompt: agent.persona_prompt || '',
      systemPromptSummary: typeof agent.metadata?.system_prompt_summary === 'string' ? agent.metadata.system_prompt_summary : '',
      workStyles: profile.workStyles,
      expertiseTags: profile.expertiseTags,
      workModes: profile.workModes,
      suggestedPrompts: profile.suggestedPrompts,
      greetingMessage: profile.greetingMessage,
      harnessMaxActions: Math.max(1, Math.min(100, agent.harness_max_actions || 32)),
      status: agent.status === 'archived' ? 'archived' : 'active',
      publishedToGallery: agent.metadata?.published_to_gallery === true,
    });
  }, [agent, open, profile]);

  async function save() {
    if (!agent) return;
    if (!form.name.trim()) {
      notify.error('请输入数字员工姓名');
      return;
    }
    setSaving(true);
    try {
      const wasPublished = agent.metadata?.published_to_gallery === true;
      const metadata: Record<string, unknown> = {
        ...(agent.metadata || {}),
        blank_onboarding: false,
        role_name: form.roleName.trim() || '待补充岗位',
        onboarded_at: form.onboardedAt || toClientDateISO(new Date()),
        system_prompt_summary: form.systemPromptSummary.trim(),
        work_styles: compactTags(form.workStyles),
        expertise_tags: compactTags(form.expertiseTags),
        work_modes: compactTags(form.workModes),
        published_to_gallery: form.publishedToGallery,
      };
      /*
       * 快捷提问：空着就把 key 删掉，别留一个空数组。
       * metadata 走的是「整体覆盖」，留 [] 会让「没配过」和「配过又清空」
       * 这两种状态在数据里长得一样；删掉 key 才能让空态与配置页读到同一件事
       * （没配 = 不显示这一块）。
       */
      const suggestedPrompts = normalizeSuggestedPrompts(form.suggestedPrompts);
      if (suggestedPrompts.length) {
        metadata.suggested_prompts = suggestedPrompts;
      } else {
        delete metadata.suggested_prompts;
      }
      /*
       * 开场白同理：空着就删 key。后端判据是「取不到非空字符串 = 没配」，
       * 留一个空串在库里只是脏数据。
       */
      const greetingMessage = normalizeGreetingMessage(form.greetingMessage);
      if (greetingMessage) {
        metadata.greeting_message = greetingMessage;
      } else {
        delete metadata.greeting_message;
      }
      if (form.publishedToGallery && !wasPublished) {
        metadata.gallery_published_at = new Date().toISOString();
        metadata.gallery_published_by = currentUser?.username;
      }
      if (!form.publishedToGallery) {
        delete metadata.gallery_published_at;
        delete metadata.gallery_published_by;
      }

      const saved = await api.put<AgentProfileRead>(`/api/enterprise/agents/${agent.id}`, {
        tenant_id: TENANT_ID,
        name: form.name.trim(),
        description: form.description.trim(),
        persona_prompt: form.personaPrompt.trim(),
        status: form.status,
        harness_max_actions: Math.max(1, Math.min(100, form.harnessMaxActions || 32)),
        metadata,
      });
      notify.success('数字员工档案已更新');
      onSaved?.(saved);
      onClose();
      window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存数字员工档案失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="employee-profile-modal flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-[16px] overflow-hidden rounded-[14px] px-[20px] py-[16px] sm:max-w-[860px]"
      >
        <DialogTitle className="px-[12px] text-[14px] font-normal leading-none text-[#6d6d72]">
          {agent ? `编辑数字员工档案：${employeeDisplayName(agent)}` : '编辑数字员工档案'}
        </DialogTitle>

        <div className="min-h-0 flex-1 overflow-y-auto px-[12px]">
          <div className="employee-profile-editor">
            <div className="employee-profile-preview">
              <EmployeeAvatar agent={agent} size={92} />
              <div>
                <span className="m-0 block text-[12px] text-muted-foreground">数字员工档案</span>
                <h4 className="mt-[4px] mb-[6px] text-[18px] font-semibold text-[#18181a]">{agent ? employeeDisplayName(agent) : '数字员工'}</h4>
                <span className="m-0 block text-[12px] text-muted-foreground">{profile.roleName}</span>
              </div>
              <span className="employee-profile-preview-icon"><IdcardOutlined /></span>
            </div>

            <div className="employee-profile-form flex flex-col gap-[14px]">
              <div className="employee-profile-form-grid">
                <LabeledField label="数字员工姓名">
                  <Input value={form.name} placeholder="例如：默认员工" onChange={(event) => update({ name: event.target.value })} />
                </LabeledField>
                <LabeledField label="岗位">
                  <Input value={form.roleName} placeholder="例如：研发" onChange={(event) => update({ roleName: event.target.value })} />
                </LabeledField>
                <LabeledField label="入职时间">
                  <Input type="date" value={form.onboardedAt} onChange={(event) => update({ onboardedAt: event.target.value })} />
                </LabeledField>
                <LabeledField label="工作状态">
                  <Select value={form.status} onValueChange={(value) => update({ status: value as 'active' | 'archived' })}>
                    <SelectTrigger className={`${SELECT_TRIGGER_CLASS} w-full`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">在线</SelectItem>
                      <SelectItem value="archived">下线</SelectItem>
                    </SelectContent>
                  </Select>
                </LabeledField>
              </div>

              <LabeledField label="岗位描述">
                <Textarea rows={3} value={form.description} placeholder="概括这个数字员工的岗位边界、服务风格和执行重点" onChange={(event) => update({ description: event.target.value })} />
              </LabeledField>
              <LabeledField label="看板摘要">
                <Textarea rows={2} value={form.systemPromptSummary} placeholder="用于数字员工档案页顶部展示的 system prompt 摘要" onChange={(event) => update({ systemPromptSummary: event.target.value })} />
              </LabeledField>
              <LabeledField label="岗位执行约束">
                <Textarea rows={4} value={form.personaPrompt} placeholder="员工在对话中的角色、人设、回复风格和执行边界" onChange={(event) => update({ personaPrompt: event.target.value })} />
              </LabeledField>
              <LabeledField label="默认模型">
                <div className="flex min-h-10 items-center rounded-[10px] border border-[#e6e4df] bg-[#f2f1ee] px-3 text-[13px] text-[#59627a]">
                  统一继承模型配置中的全局默认模型
                </div>
                <span className="text-[11px] text-muted-foreground">员工不再单独绑定模型；切换全局默认模型后，所有员工立即生效。</span>
              </LabeledField>

              <div className="rounded-[14px] border border-[#e6e4df] bg-[#f2f1ee] p-[14px]">
                <LabeledField label="单次 HarnessLoop 最大调用轮次">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={form.harnessMaxActions}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      update({ harnessMaxActions: Number.isFinite(next) ? next : 32 });
                    }}
                  />
                </LabeledField>
                <p className="m-0 mt-[6px] text-[11px] leading-[1.5] text-muted-foreground">
                  限制该员工在一轮对话中可自主执行的模型动作与能力调用总数，范围 1–100；达到上限后未完成任务会进入后续轮次。
                </p>
              </div>

              <div className="employee-profile-form-grid is-tags">
                <LabeledField label="掌握方向">
                  <TagsField value={form.expertiseTags} options={EXPERTISE_OPTIONS} placeholder="输入后回车添加" onChange={(next) => update({ expertiseTags: next })} />
                </LabeledField>
                <LabeledField label="工作风格">
                  <TagsField value={form.workStyles} options={STYLE_OPTIONS} placeholder="输入后回车添加" onChange={(next) => update({ workStyles: next })} />
                </LabeledField>
                <LabeledField label="工作模式">
                  <TagsField value={form.workModes} options={WORK_MODE_OPTIONS} placeholder="输入后回车添加" onChange={(next) => update({ workModes: next })} />
                </LabeledField>
              </div>

              {/*
                开场白：新建会话时由后端主动落一条 assistant 消息。
                抬头「你好，{用户显示名}。」是固定的，用户只写正文——所以这里
                只收正文，并在下面给一段真实预览，避免「以为要自己写称呼」。
              */}
              <div className="rounded-[14px] border border-[#e6e4df] bg-[#f2f1ee] p-[14px]">
                <LabeledField label="开场白">
                  <Textarea
                    rows={3}
                    value={form.greetingMessage}
                    maxLength={GREETING_MESSAGE_MAX_LENGTH}
                    placeholder="例如：我可以帮你查制度、整理会议纪要，也可以直接起草邮件。"
                    onChange={(event) => update({ greetingMessage: event.target.value })}
                  />
                </LabeledField>
                <p className="m-0 mt-[6px] text-[11px] leading-[1.5] text-muted-foreground">
                  新建会话时由我主动发出；留空则不发。抬头「你好，{'用户显示名'}。」自动生成。
                </p>
                {normalizeGreetingMessage(form.greetingMessage) && (
                  <div className="mt-[10px] rounded-[10px] border border-[#e6e4df] bg-white px-[10px] py-[8px]">
                    <span className="block text-[10px] uppercase tracking-[0.04em] text-[#9a9a9f]">效果预览</span>
                    <p className="m-0 mt-[4px] whitespace-pre-line text-[12px] leading-[1.6] text-[#3d3d3f]">
                      {greetingPreviewText(form.greetingMessage, currentUser?.display_name || currentUser?.username)}
                    </p>
                  </div>
                )}
              </div>

              {/*
                快捷提问：配置端只负责「写 1-3 句话」，展示端在聊天空态。
                放在标签组之后、发布开关之前——它属于「这个员工怎么被用」，
                而不是「这个员工是谁」，紧挨着发布开关正好是同一类运营设置。
              */}
              <div className="rounded-[14px] border border-[#e6e4df] bg-[#f2f1ee] p-[14px]">
                <div className="flex items-baseline justify-between gap-[8px]">
                  <span className="text-[12px] font-medium text-[#3d3d3f]">快捷提问</span>
                  <span className="text-[11px] text-muted-foreground">
                    {form.suggestedPrompts.length}/{SUGGESTED_PROMPT_LIMIT}
                  </span>
                </div>
                <p className="m-0 mt-[6px] text-[11px] leading-[1.5] text-muted-foreground">
                  最多 3 条，会显示在对话空态；用户点一下就把这句话直接发给我。
                </p>
                <div className="mt-[10px] flex flex-col gap-[8px]">
                  {form.suggestedPrompts.map((prompt, index) => (
                    <div key={index} className="flex items-center gap-[6px]">
                      <Input
                        value={prompt}
                        maxLength={SUGGESTED_PROMPT_MAX_LENGTH}
                        placeholder={SUGGESTED_PROMPT_PLACEHOLDERS[index] || '例如：帮我把这周的报销单核对一遍'}
                        onChange={(event) => {
                          const next = [...form.suggestedPrompts];
                          next[index] = event.target.value;
                          update({ suggestedPrompts: next });
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`删除第 ${index + 1} 条快捷提问`}
                        onClick={() => update({
                          suggestedPrompts: form.suggestedPrompts.filter((_item, idx) => idx !== index),
                        })}
                        className="grid size-[30px] shrink-0 place-items-center rounded-[8px] text-[#6d6d72] transition-colors hover:bg-white hover:text-[#18181a]"
                      >
                        <XIcon className="size-[13px]" />
                      </button>
                    </div>
                  ))}
                  {form.suggestedPrompts.length < SUGGESTED_PROMPT_LIMIT && (
                    <button
                      type="button"
                      onClick={() => update({ suggestedPrompts: [...form.suggestedPrompts, ''] })}
                      className="inline-flex h-[30px] w-fit items-center gap-[4px] rounded-[8px] border border-dashed border-[#d6d1c9] px-[10px] text-[12px] text-[#6d6d72] transition-colors hover:border-[#18181a] hover:text-[#18181a]"
                    >
                      <PlusOutlined className="size-[12px]" />
                      添加快捷提问
                    </button>
                  )}
                </div>
              </div>

              <div className="employee-profile-publish">
                <div>
                  <strong className="text-[13px] text-[#18181a]">发布到广场</strong>
                  <p className="m-0 mt-[4px] text-[12px] text-muted-foreground">
                    开启后，其他账号可以在对话端和数字员工广场中选择这个员工。
                  </p>
                </div>
                <Switch checked={form.publishedToGallery} onCheckedChange={(next) => update({ publishedToGallery: next })} />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-[8px] px-[12px]">
          <UIButton
            variant="outline"
            disabled={saving || !agent || agent.status !== 'active'}
            onClick={() => setShareOpen(true)}
            className="mr-auto h-[32px] rounded-[10px] border-[#e6e4df] bg-white px-[12px] text-[14px] font-normal text-[#3d3d3f] hover:border-[#e6e4df] hover:bg-[#f2f1ee] hover:text-[#18181a]"
          >
            <Share2 className="size-[14px]" />
            分享
          </UIButton>
          <UIButton
            variant="outline"
            disabled={saving}
            onClick={onClose}
            className="h-[32px] w-[80px] rounded-[10px] border-[#e6e4df] bg-white px-[12px] text-[14px] font-normal text-[#3d3d3f] hover:border-[#e6e4df] hover:bg-[#f2f1ee] hover:text-[#18181a]"
          >
            取消
          </UIButton>
          <UIButton
            disabled={saving}
            onClick={() => void save()}
            className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] text-[14px] font-normal text-white hover:bg-[#303030]"
          >
            保存
          </UIButton>
        </div>
      </DialogContent>
    </Dialog>
    <AgentShareDialog
      agent={agent ?? null}
      open={shareOpen}
      onClose={() => setShareOpen(false)}
    />
    </>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] font-medium text-[#3d3d3f]">{label}</span>
      {children}
    </label>
  );
}

function TagsField({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string[];
  options: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const addTags = (raw: string) => {
    const parts = raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (parts.length) onChange(Array.from(new Set([...value, ...parts])));
    setDraft('');
  };
  const removeTag = (tag: string) => onChange(value.filter((item) => item !== tag));
  const suggestions = options.filter((item) => !value.includes(item));

  return (
    <div className="flex flex-col gap-[8px]">
      <div className="flex min-h-[34px] flex-wrap items-center gap-[6px] rounded-[10px] border-[0.5px] border-[#e6e4df] bg-white px-[8px] py-[5px] transition-colors focus-within:border-[#18181a]">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-[4px] rounded-[6px] bg-[#f2f1ee] px-[8px] py-[2px] text-[12px] text-[#18181a]"
          >
            {tag}
            <button
              type="button"
              aria-label={`移除 ${tag}`}
              onClick={() => removeTag(tag)}
              className="grid place-items-center text-[#6d6d72] hover:text-[#18181a]"
            >
              <XIcon className="size-[12px]" />
            </button>
          </span>
        ))}
        <input
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault();
              addTags(draft);
            } else if (event.key === 'Backspace' && !draft && value.length) {
              removeTag(value[value.length - 1]);
            }
          }}
          onBlur={() => draft.trim() && addTags(draft)}
          className="h-[22px] min-w-[80px] flex-1 bg-transparent text-[12px] text-[#17191f] outline-none placeholder:text-[#d6d1c9]"
        />
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-[6px]">
          {suggestions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => addTags(item)}
              className="rounded-[6px] border-[0.5px] border-[#e6e4df] px-[8px] py-[2px] text-[12px] text-[#6d6d72] hover:border-[#18181a] hover:text-[#18181a]"
            >
              + {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function compactTags(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((item) => item.trim()).filter(Boolean))).slice(0, 12);
}
