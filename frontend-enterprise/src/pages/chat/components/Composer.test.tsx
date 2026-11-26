// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * 分享页的入口胶囊 / 快捷提问**必须可点**。
 *
 * ## 回归的场景
 *
 * `sceneChipDisabled` 原先是 `Boolean(shareMode) || Boolean(currentSessionRunning)`，
 * 于是员工分享出去的链接里，场景胶囊渲染出来了、点下去毫无反应 ——
 * 用户原话「虽然有场景快捷按钮，但是无法点击」。
 *
 * 关键在于**分享页不是只读的**：访客能打字、能发送，
 * `ensureModelAvailable()` 在 shareMode 下直接放行，后端 `/api/chat/`
 * 也在访客路径白名单里。前端这道 `disabled` 是整条链路上唯一的拦截点，
 * 而且拦错了 —— 显示出来却点不动，比不显示更糟（看起来像坏了）。
 *
 * 所以这里锁两件事：
 * 1. shareMode 下按钮 `disabled === false`，且真的能触发回调；
 * 2. 分享模式不再从 `chat` 上解构（否则下一个人会以为它还在起作用）。
 *
 * 只锁「可点」不够 —— 必须同时断言 `currentSessionRunning` 仍然会置灰，
 * 否则把 `sceneChipDisabled` 直接改成 `false` 也能让上面那条通过，
 * 而那时「跑一轮时点胶囊被静默推进队列」的坑又回来了。
 */
describe('Composer · 分享页的场景入口不能被误禁', () => {
  const PROMPTS = ['电脑端如何设置 outlook'];

  function renderShare(extra: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
    const chat = buildChat();
    Object.assign(chat, {
      composerPlusOpen: false,
      displayedProfile: { suggestedPrompts: PROMPTS },
      shareMode: true,
      ...extra,
    });
    return render(
      <I18nProvider>
        <Composer chat={chat} {...props} />
      </I18nProvider>,
    );
  }

  it('分享访客点得动快捷提问（原来被 shareMode 置灰）', () => {
    const sendQuickText = vi.fn();
    renderShare({ sendQuickText }, { hideModelSelector: true, hideScheduledTask: true });

    const chip = screen.getByRole('button', { name: `快捷提问 1：${PROMPTS[0]}` });
    expect(chip).toHaveProperty('disabled', false);
    fireEvent.click(chip);
    expect(sendQuickText).toHaveBeenCalledWith(PROMPTS[0]);
  });

  it('正在跑一轮时仍然置灰（这条不能被上面的修复顺手去掉）', () => {
    const sendQuickText = vi.fn();
    renderShare({ sendQuickText, currentSessionRunning: true });

    const chip = screen.getByRole('button', { name: `快捷提问 1：${PROMPTS[0]}` });
    expect(chip).toHaveProperty('disabled', true);
    fireEvent.click(chip);
    // 置灰时点下去不该有任何动作 —— 否则会被静默推进队列，用户看不到反应。
    expect(sendQuickText).not.toHaveBeenCalled();
  });

  /**
   * 场景胶囊是用户**真正**报的那一处（「虽然有场景快捷按钮，但是无法点击」）。
   * 上面两条只覆盖快捷提问 —— 两者共用 `sceneChipDisabled`，但共用一个变量的
   * 事实不该成为「测一条就够」的理由：将来若有人给胶囊单独传 `disabled`
   * （比如加个 `disabled={shareMode}`），只有直接断言胶囊才能发现。
   *
   * 胶囊要发请求才渲染，所以这里 stub 掉 `fetch`，走真实的取数链路
   * （而不是给组件塞注入口 —— 注入口绕过了请求，测不到「分享页真的能拉到胶囊」）。
   */
  it('分享访客点得动场景胶囊，且点下去发出场景那句话', async () => {
    const sceneChips = [
      {
        scene_id: 'scene_ski',
        module_key: 'travel.itinerary',
        module_version: 1,
        label: '滑雪行程推荐',
        icon: '🎿',
        send_text: '滑雪行程推荐',
        scene_name: '滑雪行程推荐',
        scene_type: 'table_match',
      },
      {
        scene_id: 'scene_room',
        module_key: 'generic.tool_submit',
        module_version: 1,
        label: '客房送物',
        icon: '🛎️',
        send_text: '客房送物',
        scene_name: '客房送物',
        scene_type: 'tool_submit',
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/chat/scenes')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify(sceneChips),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify([]),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const sendQuickText = vi.fn();
    renderShare({ sendQuickText, effectiveAgentId: 'agent-share-1' });

    // 胶囊是异步取数后渲染的，同步查询必然查不到。
    const chip = await screen.findByRole('button', { name: /客房送物/ });
    expect(chip).toHaveProperty('disabled', false);

    fireEvent.click(chip);

    // `handleSceneChipSelect` 会先 await module meta（懒加载 chunk），
    // 所以断言要等。
    await waitFor(() => expect(sendQuickText).toHaveBeenCalled());
    expect(sendQuickText.mock.calls[0][0]).toBeTruthy();
    vi.unstubAllGlobals();
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
