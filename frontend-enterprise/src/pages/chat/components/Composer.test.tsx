// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';

import type { UseChatSession } from '../useChatSession';
import Composer from './Composer';

function buildChat(): UseChatSession {
  return {
    input: '',
    setInput: vi.fn(),
    slashCommands: [],
    composerAttachments: [],
    composerDragActive: false,
    // 直接把加号菜单置为打开：否则 Radix 要等 pointerdown 才渲染菜单内容
    composerPlusOpen: true,
    setComposerPlusOpen: vi.fn(),
    composerIntent: null,
    setComposerIntent: vi.fn(),
    readyComposerAttachments: [],
    uploadingComposerAttachment: false,
    currentSessionRunning: false,
    composerActive: true,
    showComposerAvatar: false,
    displayedProfile: null,
    displayedAgent: null,
    displayedMessages: [],
    sendQuickText: vi.fn(),
    shareMode: false,
    emptyRoleSummary: '',
    emptyStats: [],
    enabledModelConfigs: [],
    selectedModelConfig: null,
    changeModelConfig: vi.fn(),
    showModelSetupNotice: false,
    modelSetupNoticeText: '',
    freeModelNoticeText: '',
    canConfigureModels: false,
    setModelSetupOpen: vi.fn(),
    isComposing: false,
    setIsComposing: vi.fn(),
    fileInputRef: { current: null },
    send: vi.fn(),
    abortStream: vi.fn(),
    handleComposerPaste: vi.fn(),
    handleComposerFileChange: vi.fn(),
    handleComposerDragEnter: vi.fn(),
    handleComposerDragOver: vi.fn(),
    handleComposerDragLeave: vi.fn(),
    handleComposerDrop: vi.fn(),
    removeComposerAttachment: vi.fn(),
    handleComposerPlusAction: vi.fn(),
    t: (key: string) => key,
  } as unknown as UseChatSession;
}

function renderComposer(props: { hideModelSelector?: boolean; hideScheduledTask?: boolean } = {}) {
  return render(
    <I18nProvider>
      <Composer chat={buildChat()} {...props} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('Composer prompt suggestions', () => {
  const PROMPTS = ['电脑端如何设置 outlook', 'Outlook频繁弹M365验证框的处理办法'];

  function renderWithPrompts(extra: Record<string, unknown> = {}) {
    const chat = buildChat();
    Object.assign(chat, {
      // 加号菜单开着时 Radix 会给页面其它节点打 aria-hidden，role 查询全部失效。
      composerPlusOpen: false,
      displayedProfile: { suggestedPrompts: PROMPTS },
      ...extra,
    });
    return render(
      <I18nProvider>
        <Composer chat={chat} />
      </I18nProvider>,
    );
  }

  it('把快捷提问挂在输入框上方的扁胶囊行里', () => {
    const { container } = renderWithPrompts();

    const chip = screen.getByRole('button', { name: `快捷提问 1：${PROMPTS[0]}` });
    const row = chip.parentElement as HTMLElement;
    // 左对齐 + 与输入框文字左缘同一 20px 起点（form p-10 + textarea px-10）
    expect(row.className).toContain('justify-start');
    expect(row.className).toContain('pl-[20px]');
    expect(chip.className).toContain('h-[26px]');
    expect(chip.className).toContain('rounded-full');

    // 位置契约：胶囊行是 form 的前一个兄弟节点，即「输入框正上方」。
    const form = container.querySelector('form') as HTMLElement;
    expect(row.nextElementSibling).toBe(form);
  });

  it('常驻在输入框上方，有历史消息时也不消失', () => {
    renderWithPrompts({ displayedMessages: [{ id: 'm-1' }, { id: 'm-2' }] });

    expect(screen.getByRole('button', { name: `快捷提问 1：${PROMPTS[0]}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `快捷提问 2：${PROMPTS[1]}` })).toBeTruthy();
  });

  it('员工没配快捷提问时不占高度', () => {
    renderWithPrompts({ displayedProfile: { suggestedPrompts: [] } });

    expect(screen.queryByRole('button', { name: /快捷提问/ })).toBeNull();
  });

  it('点击后把整句交给 sendQuickText', () => {
    const sendQuickText = vi.fn();
    renderWithPrompts({ sendQuickText });

    fireEvent.click(screen.getByRole('button', { name: `快捷提问 2：${PROMPTS[1]}` }));

    expect(sendQuickText).toHaveBeenCalledWith(PROMPTS[1]);
  });
});

describe('Composer plus menu', () => {
  it('站内对话展示「定时任务」入口', () => {
    renderComposer();

    expect(screen.getByText('上传文件')).toBeTruthy();
    expect(screen.getByText('定时任务')).toBeTruthy();
  });

  it('分享访客的加号菜单里没有「定时任务」', () => {
    renderComposer({ hideModelSelector: true, hideScheduledTask: true });

    expect(screen.getByText('上传文件')).toBeTruthy();
    expect(screen.queryByText('定时任务')).toBeNull();
  });
});

describe('Composer attachment tray', () => {
  function attachment(index: number) {
    return {
      id: `att-${index}`,
      uploadKey: `key-${index}`,
      filename: `门店巡检-${index}.pdf`,
      content_type: 'application/pdf',
      size: 862_000,
      kind: 'pdf',
      uploadStatus: 'ready',
    };
  }

  it('附件浮在文字右上角，最多露 3 颗，其余收成 +N', () => {
    const chat = buildChat();
    chat.composerAttachments = [1, 2, 3, 4, 5].map(attachment) as never;
    const { container } = render(
      <I18nProvider>
        <Composer chat={chat} />
      </I18nProvider>,
    );

    // aria-label 走 i18n，会随语言变；这里只认角色与结构
    const tray = container.querySelector('[role="group"]') as HTMLElement;
    expect(tray).toBeTruthy();
    // 托盘是浮层：absolute + pointer-events-none，不参与布局高度
    expect(tray.className).toContain('absolute');
    expect(tray.querySelectorAll('[role="img"]').length).toBe(3);
    expect(screen.getByText('+2')).toBeTruthy();

    // 文字区让出托盘宽度（3×26 + 2×8 + 26 + 8 + 16 = 144），正文不会钻到瓷砖下面
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.style.paddingRight).toBe('144px');
  });
});
