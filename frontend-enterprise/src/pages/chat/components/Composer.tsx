import type { FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
    sendQuickText,
    shareMode,
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
          快捷提问：**常驻**在输入框上方的扁胶囊行（员工在「编辑数字员工档案 →
          快捷提问」里配的 1-3 句话）。点一下直接把整句发出去。
          不随轮次消失：用户在任意一轮都能一键追问，位置永远贴着输入框。
          员工没配时组件内部返回 null，不留空档。
        */}
        <ChatPromptSuggestions
          prompts={suggestedPrompts}
          // 正在跑的一轮里再发会被推进队列，点了没反馈等于失灵；分享页只读。
          disabled={Boolean(shareMode) || Boolean(currentSessionRunning)}
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
