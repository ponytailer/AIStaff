// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';

import type { HandoffBrief, HumanHandoffRead } from '@/types';

import type { ComposerAttachment } from '../chatTypes';
import HandoffCard, { formatWaiting } from './HandoffCard';

/** Textarea 会走 i18n 翻译 placeholder，必须包 Provider。 */
function renderCard(element: ReactElement) {
  return render(<I18nProvider>{element}</I18nProvider>);
}

// 项目 vitest 未开 globals，RTL 自动清理不生效，必须显式 cleanup。
afterEach(cleanup);

const baseBrief: HandoffBrief = {
  topic: '电脑outlook登陆总是显示用户名可能不正确',
  reason: 'user_requested',
  ask: '用户已经试过重装 Office，但仍报错。需要你确认账号是否被锁。',
  ask_source: 'transcript',
  findings: [
    { text: '已确认问题类型：Outlook 客户端登录失败，非网络问题' },
    { text: '按《电脑端Outlook配置手册》第 2 页核对，未修改初始密码将无法登入 Outlook' },
    { text: '建议先确认账号是否锁定，再重设密码' },
    { text: '用户已尝试重装 Office，无效' },
    { text: '若仍失败需转 IT 桌面运维现场处理' },
  ],
  slots: [],
  transcript: [
    { role: 'user', text: '电脑outlook登陆总是显示用户名可能不正确', created_at: '2026-02-10T09:00:00Z', citations: [] },
    { role: 'assistant', text: '我先确认一下您的邮箱后缀是否是公司域名？', created_at: '2026-02-10T09:01:00Z', citations: [] },
    { role: 'user', text: '是高科集团的域名', created_at: '2026-02-10T09:02:00Z', citations: [] },
    { role: 'assistant', text: '请按手册核对配置。', created_at: '2026-02-10T09:03:00Z', citations: ['段落组 1'] },
    { role: 'user', text: '我重装了还是不行，转人工', created_at: '2026-02-10T09:04:00Z', citations: [] },
  ],
  citations: [
    { title: 'PDF 文档 / 第 2 页', count: 1 },
    { title: '段落组 1', count: 4 },
  ],
  waiting_seconds: 48,
  rounds: 3,
  attempt_index: 1,
  total_messages: 5,
  transcript_truncated: false,
};

function makeHandoff(patch: Partial<HumanHandoffRead> = {}): HumanHandoffRead {
  return {
    id: 'h1',
    tenant_id: 't1',
    session_id: 's1',
    agent_id: 'a1',
    requester_display_name: '张三',
    context_summary: '用户反馈 Outlook 登录失败',
    pending_question: '转人工',
    status: 'pending',
    created_at: '2026-02-10T09:05:00Z',
    updated_at: '2026-02-10T09:05:00Z',
    brief: baseBrief,
    ...patch,
  };
}

function props(patch: Partial<React.ComponentProps<typeof HandoffCard>> = {}) {
  return {
    handoff: makeHandoff(),
    agent: null,
    fallbackProfile: null,
    reply: '',
    attachments: [] as ComposerAttachment[],
    onReplyChange: vi.fn(),
    onPasteFiles: vi.fn(),
    onPickFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onOpenSession: vi.fn(),
    onDismiss: vi.fn(),
    onSubmit: vi.fn(),
    ...patch,
  };
}

describe('formatWaiting', () => {
  it('按尺度给出人话，不出现 0 秒这种废话', () => {
    expect(formatWaiting(0)).toBe('刚刚');
    expect(formatWaiting(-5)).toBe('刚刚');
    expect(formatWaiting(Number.NaN)).toBe('刚刚');
    expect(formatWaiting(38)).toBe('38 秒');
    expect(formatWaiting(60)).toBe('1 分钟');
    expect(formatWaiting(59 * 60)).toBe('59 分钟');
    expect(formatWaiting(3600)).toBe('1 小时');
    expect(formatWaiting(3600 + 15 * 60)).toBe('1 小时 15 分');
    expect(formatWaiting(24 * 3600)).toBe('1 天 0 小时');
    expect(formatWaiting(26 * 3600)).toBe('1 天 2 小时');
  });
});

describe('HandoffCard', () => {
  it('折叠态只露 ask 与前 2 条结论，对话经过整段不渲染', () => {
    renderCard(<HandoffCard {...props()} />);

    expect(screen.getByText(baseBrief.ask as string)).toBeTruthy();
    // 前 2 条结论可见
    expect(screen.getByText(/已确认问题类型：Outlook 客户端登录失败/)).toBeTruthy();
    expect(screen.getByText(/未修改初始密码将无法登入 Outlook/)).toBeTruthy();
    // 第 3 条开始折叠
    expect(screen.queryByText(/建议先确认账号是否锁定/)).toBeNull();
    // 折叠态不渲染 02/04/05 三个区块
    expect(screen.queryByText('用户在问什么')).toBeNull();
    expect(screen.queryByText(/^对话经过/)).toBeNull();
    expect(screen.queryByText(/AI 引用了/)).toBeNull();
    // 给出展开入口
    expect(screen.getByRole('button', { name: /展开全部 5 条结论与对话经过/ })).toBeTruthy();
  });

  it('展开后补齐结论、已收集信息、对话经过与引用', () => {
    renderCard(<HandoffCard {...props({ defaultOpen: true })} />);

    expect(screen.getByText(/建议先确认账号是否锁定/)).toBeTruthy();
    expect(screen.getByText('用户在问什么')).toBeTruthy();
    expect(screen.getByText(/^对话经过/)).toBeTruthy();
    expect(screen.getByText(/AI 引用了 2 处知识/)).toBeTruthy();
    expect(screen.getByText('PDF 文档 / 第 2 页')).toBeTruthy();
    expect(screen.getByText('×4')).toBeTruthy();
  });

  it('头部带 reason 徽标、等待时长与重复转人工提示', () => {
    renderCard(
      <HandoffCard
        {...props({
          handoff: makeHandoff({
            brief: { ...baseBrief, reason: 'sop_step', attempt_index: 3, waiting_seconds: 5 * 3600 },
          }),
        })}
      />,
    );

    expect(screen.getByText('SOP 卡点')).toBeTruthy();
    expect(screen.getByText('本会话第 3 次')).toBeTruthy();
    expect(screen.getByText('已等待 5 小时')).toBeTruthy();
  });

  it('SOP 单把结论区标题换成「已经走到哪一步」，并渲染已收集槽位', () => {
    renderCard(
      <HandoffCard
        {...props({
          defaultOpen: true,
          handoff: makeHandoff({
            brief: {
              ...baseBrief,
              reason: 'sop_step',
              slots: [
                { key: 'employee_id', label: '员工工号', value: '3019' },
                { key: 'environment', label: '环境', value: '生产环境' },
              ],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText('SOP 已经走到哪一步')).toBeTruthy();
    expect(screen.getByText('已收集信息 · 不必再问一遍')).toBeTruthy();
    expect(screen.getByText('员工工号')).toBeTruthy();
    expect(screen.getByText('3019')).toBeTruthy();
    expect(screen.getByText('生产环境')).toBeTruthy();
  });

  it('brief 缺失（老数据）时退回 pending_question，不出现空白待办区', () => {
    renderCard(
      <HandoffCard
        {...props({
          handoff: makeHandoff({ brief: null, pending_question: '请人工确认该审批是否符合政策' }),
        })}
      />,
    );

    expect(screen.getByText('请人工确认该审批是否符合政策')).toBeTruthy();
    // 没有 brief 就不该凭空造出 reason 徽标与等待时长
    expect(screen.queryByText(/已等待/)).toBeNull();
    expect(screen.queryByText('用户主动转人工')).toBeNull();
    // 尤其不能默认成「AI 判定转人工」——那时还没有这个判定，属于臆造
    expect(screen.queryByText('AI 判定转人工')).toBeNull();
    // 结论区走「没有明确结论」兜底
    expect(screen.getByText('AI 没有给出明确结论')).toBeTruthy();
  });

  it('brief 与 pending_question 都为空时给一句默认待办', () => {
    renderCard(<HandoffCard {...props({ handoff: makeHandoff({ brief: null, pending_question: null }) })} />);
    expect(screen.getByText('请根据当前会话补充人工回复。')).toBeTruthy();
  });

  it('ask 优先用 brief.ask，而不是待回答卡片老字段 pending_question', () => {
    renderCard(<HandoffCard {...props({ handoff: makeHandoff({ pending_question: '转人工' }) })} />);
    expect(screen.getByText(baseBrief.ask as string)).toBeTruthy();
    expect(screen.queryByText('转人工')).toBeNull();
  });

  it('findings 为空但 transcript 有内容时，兜底区也能展开', () => {
    renderCard(
      <HandoffCard
        {...props({
          handoff: makeHandoff({ brief: { ...baseBrief, findings: [] } }),
        })}
      />,
    );

    expect(screen.getByText('AI 没有给出明确结论')).toBeTruthy();
    const more = screen.getByRole('button', { name: /展开对话经过/ });
    fireEvent.click(more);
    expect(screen.getByText(/^对话经过/)).toBeTruthy();
  });

  it('对话被截断时给出「共 N 条」而不是误导性的「显示最近 3 条」', () => {
    renderCard(
      <HandoffCard
        {...props({
          defaultOpen: true,
          handoff: makeHandoff({
            brief: { ...baseBrief, total_messages: 42, transcript_truncated: true },
          }),
        })}
      />,
    );

    expect(screen.getByText('共 42 条，显示最近 5 条')).toBeTruthy();
    expect(screen.getByRole('button', { name: /打开原会话查看全部/ })).toBeTruthy();
  });

  it('区块编号按实际渲染顺序连续，没有 slots 时不跳号', () => {
    renderCard(<HandoffCard {...props({ defaultOpen: true })} />);

    // 没有 slots：结论 01 → 用户在问什么 02 → 对话经过 03 → 引用 04
    const card = screen.getByTestId('handoff-card-h1');
    const numbers = Array.from(card.querySelectorAll('span'))
      .map((node) => node.textContent?.trim())
      .filter((text): text is string => Boolean(text && /^\d{2}$/.test(text)));
    expect(numbers).toEqual(['01', '02', '03', '04']);
  });

  it('有 slots 时编号顺延，不留空档', () => {
    renderCard(
      <HandoffCard
        {...props({
          defaultOpen: true,
          handoff: makeHandoff({
            brief: { ...baseBrief, slots: [{ key: 'k', label: '员工工号', value: '3019' }] },
          }),
        })}
      />,
    );

    const card = screen.getByTestId('handoff-card-h1');
    const numbers = Array.from(card.querySelectorAll('span'))
      .map((node) => node.textContent?.trim())
      .filter((text): text is string => Boolean(text && /^\d{2}$/.test(text)));
    expect(numbers).toEqual(['01', '02', '03', '04', '05']);
  });

  it('展开后不再写「显示最近 3 / 5 条」这种自相矛盾的文案', () => {
    renderCard(<HandoffCard {...props({ defaultOpen: true })} />);
    expect(screen.queryByText(/显示最近 3 \/ 5 条/)).toBeNull();
    expect(screen.getByText('共 5 条，已全部列出')).toBeTruthy();
  });

  it('收起按钮把展开态收回折叠态', () => {
    renderCard(<HandoffCard {...props({ defaultOpen: true })} />);
    expect(screen.getByText(/^对话经过/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '收起详情' }));
    expect(screen.queryByText(/^对话经过/)).toBeNull();
  });

  it('回复框、附件与三个动作共存，粘贴图片会走 onPasteFiles', () => {
    const onPasteFiles = vi.fn();
    const onPickFiles = vi.fn();
    const onSubmit = vi.fn();
    const onOpenSession = vi.fn();

    renderCard(
      <HandoffCard
        {...props({
          reply: '已为您重置密码',
          onPasteFiles,
          onPickFiles,
          onSubmit,
          onOpenSession,
          attachments: [
            {
              id: 'att1',
              uploadKey: 'k1',
              filename: 'error.png',
              content_type: 'image/png',
              size: 1024,
              kind: 'image',
              data_url: 'data:image/png;base64,AAA',
              uploadStatus: 'ready',
            } satisfies ComposerAttachment,
          ],
        })}
      />,
    );

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('已为您重置密码');

    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { files: [file] } });
    expect(onPasteFiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '回复并恢复' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '打开原会话' }));
    expect(onOpenSession).toHaveBeenCalledTimes(1);

    // 默认托盘里能看到已选的图片，并且能点「+」触发选文件
    const tray = screen.getByTitle('error.png');
    expect(tray).toBeTruthy();
    fireEvent.click(within(tray).getByRole('button', { name: /移除 error.png/ }));
  });

  it('注入的托盘优先于内置简版（进度条 / 错误态不会丢）', () => {
    const renderAttachmentTray = vi.fn(() => <div data-testid="injected-tray" />);
    renderCard(<HandoffCard {...props({ renderAttachmentTray })} />);

    expect(screen.getByTestId('injected-tray')).toBeTruthy();
    expect(renderAttachmentTray).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [],
        onPick: expect.any(Function),
        onRemove: expect.any(Function),
      }),
    );
  });

  it('SOP 单的回复框提示语与普通单不同', () => {
    const { unmount } = renderCard(
      <HandoffCard {...props({ handoff: makeHandoff({ trigger_step_id: 'n6_handoff' }) })} />,
    );
    expect(
      screen.getByPlaceholderText(/原会话会继续推进 SOP 流程/),
    ).toBeTruthy();
    unmount();

    renderCard(<HandoffCard {...props()} />);
    expect(screen.getByPlaceholderText(/用户会直接在会话中看到这条答复/)).toBeTruthy();
  });
});