import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gift, Globe } from 'lucide-react';

import StaffdeckIcon from '@/components/StaffdeckIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { loadSceneModuleMeta } from '@/scenes/registry';
import type { SceneChip } from '@/scenes/types';
import type { ChatSlashCommand } from '@/types';

import type { ComposerAttachment } from '../chatTypes';
import {
  CHAT_COMMAND_KIND_TONE_CLASS,
  CHAT_COMPOSER_ACTIONS_ROW_CLASS,
  CHAT_COMPOSER_ATTACHMENT_LABEL_CLASS,
  CHAT_COMPOSER_ATTACHMENT_MORE_CLASS,
  CHAT_COMPOSER_ATTACHMENT_PROGRESS_CLASS,
  CHAT_COMPOSER_ATTACHMENT_REMOVE_CLASS,
  CHAT_COMPOSER_ATTACHMENT_TILE_CLASS,
  CHAT_COMPOSER_ATTACHMENT_TILE_ERROR_CLASS,
  CHAT_COMPOSER_ATTACHMENT_TILE_IMG_CLASS,
  CHAT_COMPOSER_ATTACHMENT_WRAP_CLASS,
  CHAT_COMPOSER_ATTACHMENTS_CLASS,
  CHAT_COMPOSER_COMMAND_KIND_CLASS,
  CHAT_COMPOSER_CONTEXT_ROW_CLASS,
  CHAT_COMPOSER_DROP_HINT_CLASS,
  CHAT_COMPOSER_FORM_CLASS,
  CHAT_COMPOSER_FORM_DRAG_CLASS,
  CHAT_COMPOSER_HINT_CLASS,
  CHAT_COMPOSER_INTENT_CHIP_CLASS,
  CHAT_COMPOSER_INPUT_ROW_CLASS,
  CHAT_COMPOSER_MODEL_BTN_CLASS,
  CHAT_COMPOSER_PLUS_BTN_CLASS,
  CHAT_COMPOSER_SEND_BTN_CLASS,
  CHAT_COMPOSER_STAGE_CLASS,
  CHAT_COMPOSER_STOP_BTN_CLASS,
  CHAT_COMPOSER_TEXTAREA_CLASS,
  CHAT_COMPOSER_TEXTAREA_WITH_COMMAND_CLASS,
  CHAT_COMPOSER_WEB_SEARCH_CLASS,
  CHAT_INPUT_SHELL_CLASS,
  CHAT_MENU_CONTENT_CLASS,
  CHAT_MENU_ITEM_CLASS,
  CHAT_MODEL_MENU_COPY_CLASS,
  CHAT_MODEL_MENU_DETAIL_CLASS,
  CHAT_MODEL_MENU_ITEM_CLASS,
  CHAT_MODEL_MENU_NAME_CLASS,
} from '../chatPageStyles';
import { attachmentTypeLabel, modelDetailText, modelDisplayName } from '../chatHelpers';
import {
  matchingSlashCommands,
  selectedSlashCommandText,
  slashCommandComposerText,
  slashCommandInput,
  slashCommandKindLabel,
  slashCommandQuery,
  slashMenuScrollTop,
} from '../slashCommands';
import type { UseChatSession } from '../useChatSession';
import ChatPromptSuggestions from './ChatPromptSuggestions';
import SceneChips from './SceneChips';
import SlashCommandChip from './SlashCommandChip';

/** 附件的第二行信息：上传中是进度，成功后是「PDF · 1.2 MB」，失败是错误原因。 */
function composerAttachmentStatus(attachment: ComposerAttachment): string {
  if (attachment.uploadStatus === 'uploading') {
    return attachment.parse_job_id
      ? `云端解析中 ${Math.round(attachment.parse_progress ?? 0)}%`
      : '上传中';
  }
  if (attachment.uploadStatus === 'error') return attachment.error || '上传失败';
  return attachmentTypeLabel(attachment);
}

/**
 * 入口胶囊的行容器（视觉契约 §6「位置铁律」的落地点）。
 *
 * ## 为什么必须有这一层，不能直接把 `SceneChips` 丢进 JSX
 *
 * `SceneChips` 按契约**只输出若干 `<button>`**，行、间距、虚线全归父级。
 * 而它需要「没有任何胶囊时整个容器消失」这个能力 —— 所以这里用一个本地
 * state 接住 `onLoaded`，`0` 个时返回 `null`。不这么做的话，未配场景的
 * 员工也会在快捷提问和输入框之间多出一道虚线和 9px 空白。
 *
 * ## 数值全部来自契约，逐值照抄不要改
 *
 * `flex gap-[7px] flex-wrap` + `pb-[9px] border-b border-dashed border-[#e7dfd3] mb-[9px]`
 * + 左侧 `pl-[20px]`（与输入框文字左缘对齐，同 `CHAT_PROMPT_ROW_CLASS` 的推导）。
 */
function SceneChipRow({
  agentId,
  disabled,
  onSelect,
}: {
  agentId: string;
  disabled: boolean;
  onSelect: (chip: SceneChip) => void;
}) {
  const [hasChips, setHasChips] = useState(false);
  // `SceneChips` 的 effect 依赖里**故意没有** `onLoaded`（父级每次都传新箭头
  // 函数会导重拉），所以这里的回调必须稳定，否则它每次渲染都重发一次请求。
  const handleLoaded = useCallback((chips: SceneChip[]) => {
    setHasChips(chips.length > 0);
  }, []);
  if (!hasChips) {
    // 仍然挂载 `SceneChips`：它要在 `agentId` 变化后取到数据，`onLoaded` 才
    // 会把 `hasChips` 翻成 true。只渲染它、不渲染外面那层虚线容器。
    return (
      <div className="hidden">
        <SceneChips agentId={agentId} disabled={disabled} onSelect={onSelect} onLoaded={handleLoaded} />
      </div>
    );
  }
  return (
    <div className="mx-auto mb-[9px] flex w-full flex-wrap items-center justify-start gap-[7px] border-b border-dashed border-[#e7dfd3] pb-[9px] pl-[20px]">
      <SceneChips
        agentId={agentId}
        disabled={disabled}
        onSelect={onSelect}
        onLoaded={handleLoaded}
      />
    </div>
  );
}

export default function Composer({
  chat,
  hideModelSelector = false,
  hideScheduledTask = false,
}: {
  chat: UseChatSession;
  /** 分享访客场景：模型在创建分享时已锁定，隐藏选择器 */
  hideModelSelector?: boolean;
  /** 分享访客场景：不允许通过分享链接创建定时任务 */
  hideScheduledTask?: boolean;
}) {
  const { t } = useI18n();
  const {
    input,
    setInput,
    slashCommands,
    composerAttachments,
    composerDragActive,
    composerPlusOpen,
    setComposerPlusOpen,
    composerIntent,
    setComposerIntent,
    readyComposerAttachments,
    uploadingComposerAttachment,
    currentSessionRunning,
    composerActive,
    webSearchEnabled,
    setWebSearchEnabled,
    enabledModelConfigs,
    selectedModelConfig,
    changeModelConfig,
    showModelSetupNotice,
    modelSetupNoticeText,
    freeModelNoticeText,
    canConfigureModels,
    setModelSetupOpen,
    isComposing,
    setIsComposing,
    fileInputRef,
    send,
    abortStream,
    handleComposerPaste,
    handleComposerFileChange,
    handleComposerDragEnter,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    removeComposerAttachment,
    handleComposerPlusAction,
    displayedProfile,
    handleChatMessagesScroll,
    sendQuickText,
    effectiveAgentId,
    // `shareMode` 曾经在这里，用来禁掉场景胶囊 / 快捷提问。现已不用：
    // 分享访客能正常对话，那两处不该被禁（详见 `sceneChipDisabled` 的注释）。
    // 保留一个「解构了但没人用」的变量，会让下一个人以为它还在起作用。
  } = chat;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const [scheduleIntentHovered, setScheduleIntentHovered] = useState(false);
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [activeSlashCommand, setActiveSlashCommand] = useState<ChatSlashCommand | null>(null);
  const slashMatches = useMemo(
    () => matchingSlashCommands(input, slashCommands),
    [input, slashCommands],
  );
  const slashMenuOpen = Boolean(
    !slashMenuDismissed && slashCommandQuery(input) && slashMatches.length,
  );
  const composerText = slashCommandComposerText(input, activeSlashCommand);

  // 附件托盘只占「浮层」：最多露 3 颗 26px 瓷砖，多出来的收成 +N。
  // 文字区按托盘实际宽度让出右侧内边距，正文永远不会钻到瓷砖底下。
  const MAX_TRAY_TILES = 3;
  const TRAY_TILE = 26;
  const TRAY_GAP = 8;
  const visibleComposerAttachments = composerAttachments.slice(0, MAX_TRAY_TILES);
  const extraComposerAttachmentCount = composerAttachments.length - visibleComposerAttachments.length;
  const composerAttachmentTrayWidth = composerAttachments.length === 0
    ? 0
    : visibleComposerAttachments.length * TRAY_TILE
      + Math.max(0, visibleComposerAttachments.length - 1) * TRAY_GAP
      + (extraComposerAttachmentCount > 0 ? TRAY_TILE + TRAY_GAP : 0);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    if (composerIntent !== 'scheduled_task') {
      setScheduleIntentHovered(false);
    }
  }, [composerIntent]);

  useEffect(() => {
    setSlashSelectionIndex(0);
    setSlashMenuDismissed(false);
  }, [input]);

  useEffect(() => {
    if (!activeSlashCommand) return;
    if (!input.startsWith(selectedSlashCommandText(activeSlashCommand))) {
      setActiveSlashCommand(null);
    }
  }, [activeSlashCommand, input]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    const menu = slashMenuRef.current;
    const selected = menu?.querySelector<HTMLElement>(
      `[data-slash-command-index="${slashSelectionIndex}"]`,
    );
    if (!menu || !selected) return;
    menu.scrollTop = slashMenuScrollTop(
      menu.scrollTop,
      menu.clientHeight,
      selected.offsetTop,
      selected.offsetHeight,
    );
  }, [slashMatches.length, slashMenuOpen, slashSelectionIndex]);

  const selectSlashCommand = (index: number) => {
    const command = slashMatches[index];
    if (!command) return;
    setActiveSlashCommand(command);
    setInput(slashCommandInput(command, ''));
    setSlashMenuDismissed(true);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const removeActiveSlashCommand = () => {
    if (!activeSlashCommand) return;
    setActiveSlashCommand(null);
    setInput(composerText);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const hasSendContent = Boolean(input.trim() || readyComposerAttachments.length > 0);
  const sendDisabled = !hasSendContent || uploadingComposerAttachment;

  // 快捷提问**常驻**在输入框上方（2026-11-25 用户确认）：不是空态专属，首轮问答
  // 之后也不消失 —— 它跟着输入框走，用户在任意一轮都能一键追问。没配置时组件
  // 自己返回 null，不占高度。
  const suggestedPrompts = displayedProfile?.suggestedPrompts || [];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  /**
   * 早期版本在输入区上方浮一张 `SceneChipFormPanel` 表单，「点开了哪一条」
   * 用一个 `openSceneId` state 记着，只为在胶囊行显示一句
   * 「已展开表单，填完点提交」。那段文案已按用户要求移除，
   * 而这个 state 从来就**没有**被 `SceneChips` 用过（组件里没有
   * `aria-pressed`，原先注释说它给按钮画选中态，实际上一直没实现）。
   * 删文案后它彻底没有消费者了，所以连 state 一起删掉，
   * 不要留一个「看着像有用」的死变量。
   */

  /**
   * 胶囊 / 快捷提问什么时候置灰 —— **只有「正在跑一轮」这一条**。
   *
   * ## 为什么不能把 `shareMode` 也算进来（曾经算过，是 bug）
   *
   * 原先写的是 `Boolean(shareMode) || Boolean(currentSessionRunning)`，理由是
   * 「分享页只读」。但分享页**不是只读的**：访客能打字、能发送，链路每一层都
   * 为此开好了口子 ——
   *
   * | 环节 | 分享访客的待遇 |
   * |---|---|
   * | `send()` | 正常放行（`ensureModelAvailable()` 在 shareMode 下直接 return true） |
   * | `api/chat/scenes` | 正常返回（`chips.py` 注释明写「这个接口会被分享页调用」） |
   * | 后端路径白名单 | `/api/chat/` 前缀放行（`main.py::_SHARE_SCOPE_ALLOWED_PREFIXES`） |
   *
   * 所以前端这一道 `disabled` 是**整条链路上唯一的拦截点**，而且拦错了：胶囊
   * 显示出来、点下去毫无反应，也没有 tooltip 说明为什么。用户看到的就是
   * 「有按钮但点不动」—— 比不显示更糟，因为它看起来像坏了。
   *
   * 真正的只读意图（分享链接不允许创建定时任务、不显示知识来源、不弹模型
   * 配置框）各有各自的落点，不该顺手套在场景入口上。
   *
   * 置灰的唯一正当理由仍然是「这一轮还没跑完」：此时点下去会被推进队列，
   * 点了没反馈等于失灵。
   */
  const sceneChipDisabled = Boolean(currentSessionRunning);

  /**
   * 点胶囊：**一律落一条用户消息**，让表单进消息流（对齐
   * `docs/scenes/scene-demo.html` 的交互，用户明确指定「以这个为准」）。
   *
   * demo 的链路是三步：
   * 1. 落一条用户气泡（「行程规划」）—— 用户看得见自己点了什么，
   *    也留在会话历史里，回看时能对上「这条结果是怎么来的」；
   * 2. 助手回一句反问（prose），说明「先确认三个条件」；
   * 3. 同一轮里把表单画进消息流。
   *
   * 我们这边 2、3 由后端 `_slot_form_block()` 产出（text 块 + form 块），
   * 前端只要做对第 1 步。这也顺带解决了一个真问题：表单浮在输入区时，
   * 提交出去的文本没有任何关键词，后端必然落回普通对话 —— 用户填完表去查了
   * 一遍知识库。改成走一轮真实对话后，`scene_id` 会随助手消息回到前端，
   * 提交时作为 `forced_scene_id` 带回，场景才真正续得上。
   *
   * 仍然读 `entry_behavior` 而不是无条件发消息：`send_text` 型入口的胶囊
   * 文案本身就是一句话，直接发；`open_form` 型发 `send_text`（后端
   * `_chip_send_text()` 三级回落的第一级），保证「点下去有东西发出去」。
   */
  const handleSceneChipSelect = async (chip: SceneChip) => {
    const meta = await loadSceneModuleMeta(chip.module_key);
    const behavior = meta?.entry_behavior ?? 'open_form';
    // 两类的最终动作一致（发一句话），差别只在文案来源：
    // `send_text` 型优先用场景配的那句话；`open_form` 型用胶囊标题，
    // 让用户气泡显示「滑雪行程推荐」而不是一句拗口的配置文案。
    const text = behavior === 'send_text'
      ? (chip.send_text || chip.label || chip.scene_name)
      : (chip.label || chip.send_text || chip.scene_name);
    if (text) {
      sendQuickText(text);
    }
  };

  return (
    <div className={CHAT_INPUT_SHELL_CLASS}>
      <div className={CHAT_COMPOSER_STAGE_CLASS}>
        {showModelSetupNotice && (
          <div className="mb-[10px] flex flex-col items-start justify-between gap-[10px] rounded-[12px] border border-[#f3d28b] bg-[#fff8e8] px-[14px] py-[10px] text-[#6f4500] shadow-[0_8px_24px_rgba(92,62,0,0.08)] sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-center gap-[9px]">
              <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[8px] bg-[#ffe7ad] text-[#8a4b00]">
                <StaffdeckIcon name="model" size={14} />
              </span>
              <span className="min-w-0 text-[12px] leading-[18px]">{modelSetupNoticeText}</span>
            </div>
            {canConfigureModels && (
              <button
                type="button"
                onClick={() => setModelSetupOpen(true)}
                className="h-[30px] shrink-0 rounded-[8px] bg-[#18181a] px-[12px] text-[12px] text-white transition-colors hover:bg-[#303030]"
              >
                {t('配置模型')}
              </button>
            )}
          </div>
        )}
        {!showModelSetupNotice && freeModelNoticeText && (
          <div className="mb-[10px] flex items-center gap-[9px] rounded-[12px] border border-[#bfe8d9] bg-[#eafaf3] px-[14px] py-[10px] text-[#0f8a5f]">
            <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[8px] bg-[#d3f2e4]">
              <Gift className="size-[14px]" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 text-[12px] leading-[18px]">{freeModelNoticeText}</span>
          </div>
        )}
        {/*
          场景入口胶囊：管理员把场景绑到该员工之后，这里就长出按钮
          （`GET /api/chat/scenes`，绑定即生效、解绑即消失，都不发版）。

          **位置在快捷提问之上、同在输入框上方那一栏**（视觉契约 §6「位置铁律」）。
          `SceneChips` 自己只输出 `<button>`，flex 行与虚线都由这里提供 ——
          两边都不自己起行，才可能真正同栏；各自带 `w-full` 容器会各占一整行，
          那就是契约明令禁止的「另起一行」（1280×800 上会顶到消息区）。

          放在快捷提问**之前**而不是之后，是为了保住 `Composer.test.tsx` 锁定的
          另一条位置契约：快捷提问行必须是 `form` 的前一个兄弟节点。夹在中间会
          让那条断言失效。

          没配场景时它返回 `null`，虚线容器也不渲染，不留空档。
        */}
        <SceneChipRow
          agentId={effectiveAgentId}
          disabled={sceneChipDisabled}
          onSelect={(chip) => void handleSceneChipSelect(chip)}
        />
        {/*
          快捷提问：**常驻**在输入框上方的扁胶囊行（员工在「编辑数字员工档案 →
          快捷提问」里配的 1-3 句话）。点一下直接把整句发出去。
          不随轮次消失：用户在任意一轮都能一键追问，位置永远贴着输入框。
          员工没配时组件内部返回 null，不留空档。
        */}
        <ChatPromptSuggestions
          prompts={suggestedPrompts}
          // 正在跑的一轮里再发会被推进队列，点了没反馈等于失灵；分享页只读。
          disabled={sceneChipDisabled}
          onSelect={(prompt) => sendQuickText(prompt)}
        />
        <form
          className={cn(CHAT_COMPOSER_FORM_CLASS, composerDragActive && CHAT_COMPOSER_FORM_DRAG_CLASS)}
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
          onSubmit={handleSubmit}
        >
          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            multiple
            onChange={handleComposerFileChange}
          />
          {composerDragActive && <div className={CHAT_COMPOSER_DROP_HINT_CLASS}>松开上传文件</div>}

          {slashMenuOpen && (
            <div
              ref={slashMenuRef}
              className="absolute bottom-[calc(100%+8px)] left-0 z-30 grid max-h-[320px] w-full overflow-y-auto rounded-[14px] border border-[rgba(24,24,26,0.08)] bg-white p-[6px] shadow-[0_18px_42px_rgba(24,24,26,0.16)]"
              role="listbox"
              aria-label={t('可用斜杠指令')}
            >
              {slashMatches.map((command, index) => (
                <button
                  key={`${command.kind}:${command.target}`}
                  type="button"
                  role="option"
                  data-slash-command-index={index}
                  aria-selected={index === slashSelectionIndex}
                  className={cn(
                    'flex min-w-0 items-center gap-[10px] rounded-[10px] px-[10px] py-[9px] text-left transition-colors',
                    index === slashSelectionIndex ? 'bg-[#f0efec]' : 'hover:bg-[#f2f1ee]',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setSlashSelectionIndex(index)}
                  onClick={() => selectSlashCommand(index)}
                >
                  <span className="inline-grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-[#eef1f5] text-[#4b4b50]">
                    <StaffdeckIcon
                      name={command.kind === 'sop' ? 'branch' : command.kind === 'skill' ? 'spark' : 'tool'}
                      size={15}
                    />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-[2px]">
                    <span className="flex min-w-0 items-center gap-[7px]">
                      <strong className="truncate text-[13px] font-medium text-[#18181a]">{command.label}</strong>
                      <span
                        className={cn(
                          CHAT_COMPOSER_COMMAND_KIND_CLASS,
                          // 菜单里比已选命令条窄一档，字号也略大（9px 在列表里偏小）
                          'px-[7px] py-[2px] text-[10px]',
                          CHAT_COMMAND_KIND_TONE_CLASS[command.kind],
                        )}
                      >
                        {slashCommandKindLabel(command.kind)}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-[#6d6d72]">
                      {command.description || command.command}
                    </span>
                  </span>
                  <code className="shrink-0 text-[11px] text-[#6d6d72]">{command.command}</code>
                </button>
              ))}
            </div>
          )}

          <div className={CHAT_COMPOSER_INPUT_ROW_CLASS}>
            {composerAttachments.length > 0 && (
              <div
                className={CHAT_COMPOSER_ATTACHMENTS_CLASS}
                aria-label={t('待发送的附件')}
                role="group"
              >
                {visibleComposerAttachments.map((attachment) => {
                  const statusText = composerAttachmentStatus(attachment);
                  return (
                    <span className={CHAT_COMPOSER_ATTACHMENT_WRAP_CLASS} key={attachment.uploadKey}>
                      <span
                        className={cn(
                          CHAT_COMPOSER_ATTACHMENT_TILE_CLASS,
                          attachment.uploadStatus === 'error' && CHAT_COMPOSER_ATTACHMENT_TILE_ERROR_CLASS,
                        )}
                        role="img"
                        aria-label={`${attachment.filename} · ${statusText}`}
                      >
                        {attachment.kind === 'image' && attachment.data_url ? (
                          <img
                            className={CHAT_COMPOSER_ATTACHMENT_TILE_IMG_CLASS}
                            src={attachment.data_url}
                            alt=""
                          />
                        ) : (
                          <StaffdeckIcon name={attachment.kind === 'pdf' ? 'file' : 'folder'} size={14} />
                        )}
                        {attachment.uploadStatus === 'uploading' && (
                          <span
                            className={CHAT_COMPOSER_ATTACHMENT_PROGRESS_CLASS}
                            style={{
                              width: attachment.parse_job_id
                                ? `${Math.max(4, Math.min(100, Math.round(attachment.parse_progress ?? 0)))}%`
                                : '100%',
                            }}
                          />
                        )}
                      </span>
                      {/* 26px 里放不下文件名：hover 才展开一条黑标签，顺带带上体积/进度。 */}
                      <span className={CHAT_COMPOSER_ATTACHMENT_LABEL_CLASS}>
                        {attachment.filename} · {statusText}
                      </span>
                      <button
                        type="button"
                        className={CHAT_COMPOSER_ATTACHMENT_REMOVE_CLASS}
                        onClick={() => removeComposerAttachment(attachment.uploadKey)}
                        aria-label={`移除附件 ${attachment.filename}`}
                      >
                        <StaffdeckIcon name="close" size={9} />
                      </button>
                    </span>
                  );
                })}
                {extraComposerAttachmentCount > 0 && (
                  <span
                    className={CHAT_COMPOSER_ATTACHMENT_MORE_CLASS}
                    title={composerAttachments
                      .slice(MAX_TRAY_TILES)
                      .map((attachment) => attachment.filename)
                      .join('、')}
                  >
                    +{extraComposerAttachmentCount}
                  </span>
                )}
              </div>
            )}
            {activeSlashCommand && (
              <SlashCommandChip
                command={activeSlashCommand}
                onRemove={removeActiveSlashCommand}
                removeLabel={`${t('移除命令')} ${activeSlashCommand.label}`}
              />
            )}
            <textarea
              ref={textareaRef}
              className={cn(
                CHAT_COMPOSER_TEXTAREA_CLASS,
                activeSlashCommand && CHAT_COMPOSER_TEXTAREA_WITH_COMMAND_CLASS,
              )}
              // 附件托盘是浮层，文字按它的实际宽度让出右侧（只改 padding，
              // 不动布局高度）；没有附件时不写 style，交给 class 里的 px。
              style={composerAttachmentTrayWidth
                ? { paddingRight: composerAttachmentTrayWidth + 16 }
                : undefined}
              value={composerText}
              rows={activeSlashCommand ? 1 : 2}
              placeholder={t('输入消息，按 Enter 发送...')}
              onChange={(event) => {
                setInput(activeSlashCommand
                  ? slashCommandInput(activeSlashCommand, event.target.value)
                  : event.target.value);
              }}
              onPaste={handleComposerPaste}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => window.setTimeout(() => setIsComposing(false), 0)}
              onKeyDown={(event) => {
                if (
                  activeSlashCommand
                  && event.key === 'Backspace'
                  && event.currentTarget.selectionStart === 0
                  && event.currentTarget.selectionEnd === 0
                ) {
                  event.preventDefault();
                  removeActiveSlashCommand();
                  return;
                }
                if (slashMenuOpen && event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSlashSelectionIndex((current) => (current + 1) % slashMatches.length);
                  return;
                }
                if (slashMenuOpen && event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSlashSelectionIndex((current) => (
                    (current - 1 + slashMatches.length) % slashMatches.length
                  ));
                  return;
                }
                if (slashMenuOpen && event.key === 'Escape') {
                  event.preventDefault();
                  setSlashMenuDismissed(true);
                  return;
                }
                if (slashMenuOpen && event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  selectSlashCommand(slashSelectionIndex);
                  return;
                }
                const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
                if (
                  event.key === 'Enter'
                  && !event.shiftKey
                  && !isComposing
                  && !nativeEvent.isComposing
                  && nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>

          <div className={cn('flex items-center justify-between gap-[10px]', !composerActive && 'opacity-95')}>
            <div className={CHAT_COMPOSER_CONTEXT_ROW_CLASS}>
              <DropdownMenu open={composerPlusOpen} onOpenChange={setComposerPlusOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={CHAT_COMPOSER_PLUS_BTN_CLASS}
                    aria-label="添加"
                    title="添加"
                  >
                    <StaffdeckIcon name="plus" size={16} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className={cn(CHAT_MENU_CONTENT_CLASS, 'min-w-[160px]')}>
                  <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onSelect={() => handleComposerPlusAction('upload')}>
                    <StaffdeckIcon name="upload" size={16} />
                    <span>上传文件</span>
                  </DropdownMenuItem>
                  {!hideScheduledTask && (
                    <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} onSelect={() => handleComposerPlusAction('scheduled_task')}>
                      <StaffdeckIcon name="clock" size={16} />
                      <span>定时任务</span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 「互联网检索」开关：每轮对话的选择，关闭时请求体不带 web_search，
                  后端能力根本不进冻结清单。原来浮在输入卡上方（原员工头像位），
                  会话窗口上线后那个位置正好压在窗口的分隔线上，改到工具行内。 */}
              <button
                type="button"
                role="switch"
                aria-checked={webSearchEnabled}
                aria-label={t('互联网检索')}
                title={webSearchEnabled
                  ? t('已开启：员工会先查企业知识库，证据不足或涉及时效性问题时自动联网检索')
                  : t('已关闭：仅使用企业知识库回答。开启后知识库证据不足时会联网检索')}
                onClick={() => setWebSearchEnabled((current) => !current)}
                className={cn(
                  CHAT_COMPOSER_WEB_SEARCH_CLASS,
                  webSearchEnabled
                    ? 'border-transparent bg-[rgba(15,118,110,0.12)] text-[#0b5a55] shadow-[inset_0_0_0_1px_rgba(15,118,110,0.14)]'
                    : 'border-transparent bg-[rgba(24,24,26,0.05)] text-[#6d6d72] hover:bg-[rgba(24,24,26,0.08)] hover:text-[#18181a]',
                )}
              >
                <Globe className="size-[14px] shrink-0" strokeWidth={1.8} />
                <span className="shrink-0">{t('互联网检索')}</span>
                <span
                  className={cn(
                    'relative inline-block h-[12px] w-[20px] shrink-0 rounded-full transition-colors',
                    webSearchEnabled ? 'bg-[#0f766e]' : 'bg-[rgba(24,24,26,0.14)]',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-[2px] size-[8px] rounded-full bg-white transition-all',
                      webSearchEnabled
                        ? 'left-[10px]'
                        : 'left-[2px] shadow-[0_0_0_0.5px_rgba(24,24,26,0.12)]',
                    )}
                  />
                </span>
              </button>
              {composerIntent === 'scheduled_task' && (
                <button
                  type="button"
                  className={CHAT_COMPOSER_INTENT_CHIP_CLASS}
                  onMouseEnter={() => setScheduleIntentHovered(true)}
                  onMouseLeave={() => setScheduleIntentHovered(false)}
                  onFocus={() => setScheduleIntentHovered(true)}
                  onBlur={() => setScheduleIntentHovered(false)}
                  onClick={() => setComposerIntent(null)}
                  aria-label="取消定时任务"
                  title="取消定时任务"
                >
                  <span className={cn(
                    'relative inline-grid size-[16px] shrink-0 place-items-center rounded-full transition-colors',
                    scheduleIntentHovered ? 'text-[#18181a]' : 'text-[#6d6d72]',
                  )}
                  >
                    <StaffdeckIcon
                      name="clock"
                      size={14}
                      className={cn('transition-opacity', scheduleIntentHovered ? 'opacity-0' : 'opacity-100')}
                    />
                    <StaffdeckIcon
                      name="close"
                      size={9}
                      className={cn('absolute transition-opacity', scheduleIntentHovered ? 'opacity-100' : 'opacity-0')}
                      style={{ width: 9, height: 9 }}
                    />
                  </span>
                  <span>定时任务</span>
                </button>
              )}
              <div className={CHAT_COMPOSER_HINT_CLASS}>Enter 发送 / Shift+Enter 换行</div>
            </div>
            <div className={CHAT_COMPOSER_ACTIONS_ROW_CLASS}>
              {!hideModelSelector && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={CHAT_COMPOSER_MODEL_BTN_CLASS}
                    disabled={!enabledModelConfigs.length}
                  >
                    <span>{selectedModelConfig ? modelDisplayName(selectedModelConfig) : '默认模型'}</span>
                    <StaffdeckIcon name="arrow" size={14} style={{ transform: 'rotate(90deg)' }} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className={cn(CHAT_MENU_CONTENT_CLASS, 'max-h-[360px] min-w-[240px] overflow-y-auto')}>
                  {enabledModelConfigs.length === 0 ? (
                    <DropdownMenuItem className={CHAT_MENU_ITEM_CLASS} disabled>暂无可用模型</DropdownMenuItem>
                  ) : (
                    enabledModelConfigs.map((model) => (
                      <DropdownMenuItem
                        key={model.id}
                        className={CHAT_MODEL_MENU_ITEM_CLASS}
                        onSelect={() => changeModelConfig(model.id)}
                      >
                        <span className={CHAT_MODEL_MENU_COPY_CLASS}>
                          <span className={CHAT_MODEL_MENU_NAME_CLASS}>{modelDisplayName(model)}</span>
                          <span className={CHAT_MODEL_MENU_DETAIL_CLASS}>{modelDetailText(model)}</span>
                        </span>
                        {selectedModelConfig?.id === model.id && <StaffdeckIcon name="check" size={15} />}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              )}
              {currentSessionRunning && (
                <button
                  type="button"
                  className={cn(CHAT_COMPOSER_SEND_BTN_CLASS, CHAT_COMPOSER_STOP_BTN_CLASS)}
                  onClick={abortStream}
                  aria-label="停止生成"
                  title="停止生成"
                >
                  <StaffdeckIcon name="stop" size={18} />
                </button>
              )}
              <button
                type="submit"
                className={CHAT_COMPOSER_SEND_BTN_CLASS}
                disabled={sendDisabled}
                aria-label={currentSessionRunning ? '加入发送队列' : '发送'}
                title={currentSessionRunning ? '加入发送队列' : '发送'}
              >
                <StaffdeckIcon name="send" size={18} />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
