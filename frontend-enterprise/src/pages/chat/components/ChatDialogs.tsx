import { ConfirmDialog } from '@/components/ConfirmDialog';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useRef } from 'react';

import {
  CHAT_CITATION_DETAIL_CLASS,
  CHAT_CITATION_DETAIL_EYEBROW_CLASS,
  CHAT_CITATION_DETAIL_GRID_CLASS,
  CHAT_CITATION_DETAIL_INDEX_CLASS,
  CHAT_CITATION_DETAIL_MARKDOWN_CLASS,
  CHAT_CITATION_DETAIL_MERGE_CLASS,
  CHAT_CITATION_DETAIL_MERGE_HEAD_CLASS,
  CHAT_CITATION_DETAIL_MERGE_META_CLASS,
  CHAT_CITATION_DETAIL_NOTE_CLASS,
  CHAT_CITATION_DETAIL_SECTION_CLASS,
  CHAT_CITATION_DETAIL_TITLE_CLASS,
  CHAT_HANDOFF_EMPTY_CLASS,
  CHAT_HANDOFF_LIST_CLASS,
  CHAT_COMPOSER_ATTACHMENT_LABEL_CLASS,
  CHAT_COMPOSER_ATTACHMENT_PROGRESS_CLASS,
  CHAT_COMPOSER_ATTACHMENT_REMOVE_CLASS,
  CHAT_HANDOFF_ATTACHMENT_TILE_CLASS,
  CHAT_COMPOSER_ATTACHMENT_TILE_ERROR_CLASS,
  CHAT_COMPOSER_ATTACHMENT_TILE_IMG_CLASS,
  CHAT_COMPOSER_ATTACHMENT_WRAP_CLASS,
  CHAT_HANDOFF_ATTACHMENTS_CLASS,
  CHAT_FILE_CHIP_BODY_CLASS,
  CHAT_FILE_CHIP_CLASS,
  CHAT_FILE_CHIP_ERROR_CLASS,
  CHAT_FILE_CHIP_ICON_CLASS,
  CHAT_FILE_CHIP_META_CLASS,
  CHAT_FILE_CHIP_NAME_CLASS,
} from '../chatPageStyles';
import {
  citationDisplayTitle,
  citationKindLabel,
  citationSectionLabel,
  citationSourceLabel,
  MarkdownMessage,
} from '../chatHelpers';
import type { ComposerAttachment } from '../chatTypes';
import type { UseChatSession } from '../useChatSession';
import HandoffCard from './HandoffCard';
import ModelSetupDialog from './ModelSetupDialog';

export default function ChatDialogs({ chat }: { chat: UseChatSession }) {
  const {
    showHandoffInbox,
    setShowHandoffInbox,
    handoffs,
    handoffsLoading,
    handoffReplies,
    setHandoffReplies,
    handoffAttachments,
    uploadHandoffFiles,
    removeHandoffAttachment,
    submitHandoffReply,
    dismissHandoff,
    agents,
    displayedAgent,
    displayedProfile,
    openSession,
    activeCitation,
    setActiveCitation,
    renameSession,
    setRenameSession,
    renameTitle,
    setRenameTitle,
    saveRename,
    savingRename,
    pendingDelete,
    setPendingDelete,
    confirmDeleteSession,
    deletingSession,
    tenantId,
    canConfigureModels,
    modelSetupOpen,
    setModelSetupOpen,
    completeModelSetup,
  } = chat;

  return (
    <>
      <ModelSetupDialog
        open={modelSetupOpen}
        tenantId={tenantId}
        canConfigure={canConfigureModels}
        onOpenChange={setModelSetupOpen}
        onConfigured={completeModelSetup}
      />

      <Dialog open={showHandoffInbox} onOpenChange={(open) => !open && setShowHandoffInbox(false)}>
        <DialogContent className="max-w-[min(920px,calc(100vw-40px))] sm:max-w-[920px]">
          <DialogHeader>
            <DialogTitle>待回答</DialogTitle>
          </DialogHeader>
          {handoffs.length === 0 ? (
            <div className={CHAT_HANDOFF_EMPTY_CLASS}>
              {handoffsLoading ? '正在加载待回答消息' : '暂无待回答消息'}
            </div>
          ) : (
            <div className={CHAT_HANDOFF_LIST_CLASS}>
              {handoffs.map((handoff, index) => {
                const handoffAgent = handoff.agent_id
                  ? agents.find((item) => item.id === handoff.agent_id) || null
                  : displayedAgent;
                return (
                  <HandoffCard
                    key={handoff.id}
                    handoff={handoff}
                    agent={handoffAgent}
                    fallbackProfile={displayedProfile}
                    // 首条展开、其余折叠：一次弹窗里可能十几条，全展开要滚三屏。
                    defaultOpen={index === 0}
                    reply={handoffReplies[handoff.id] || ''}
                    attachments={handoffAttachments[handoff.id] || []}
                    onReplyChange={(value) => setHandoffReplies((prev) => ({
                      ...prev,
                      [handoff.id]: value,
                    }))}
                    onPasteFiles={(files) => uploadHandoffFiles(handoff.id, files)}
                    onPickFiles={(files) => uploadHandoffFiles(handoff.id, files)}
                    onRemoveAttachment={(uploadKey) => removeHandoffAttachment(handoff.id, uploadKey)}
                    onOpenSession={() => {
                      setShowHandoffInbox(false);
                      openSession(handoff.session_id);
                    }}
                    onDismiss={() => void dismissHandoff(handoff)}
                    onSubmit={() => submitHandoffReply(handoff)}
                    // 复用本文件里带上传进度/错误态的托盘，避免两套实现走偏。
                    renderAttachmentTray={(props) => (
                      <HandoffAttachmentTray handoffId={handoff.id} {...props} />
                    )}
                  />
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(activeCitation)} onOpenChange={(open) => !open && setActiveCitation(null)}>
        <DialogContent className="max-w-[min(1160px,calc(100vw-40px))] sm:max-w-[1160px] max-h-[calc(100vh-40px)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>引用详情</DialogTitle>
          </DialogHeader>
          {activeCitation && (
            <div className={CHAT_CITATION_DETAIL_CLASS}>
              <div className={CHAT_CITATION_DETAIL_EYEBROW_CLASS}>
                {`${citationKindLabel(activeCitation)} · ${
                  (activeCitation.labels?.length ? activeCitation.labels : [activeCitation.label])
                    .filter(Boolean)
                    .join('')
                }`}
              </div>
              <h3 className={CHAT_CITATION_DETAIL_TITLE_CLASS}>{citationDisplayTitle(activeCitation)}</h3>
              {activeCitation.mergedChunks && activeCitation.mergedChunks.length > 1 ? (
                <div className={CHAT_CITATION_DETAIL_SECTION_CLASS}>
                  <span>
                    引用片段（共 {activeCitation.mergedChunks.length} 段）
                  </span>
                  {activeCitation.mergedChunks.map((chunk, index) => (
                    <div key={`${chunk.label}-${index}`} className={CHAT_CITATION_DETAIL_MERGE_CLASS}>
                      <div className={CHAT_CITATION_DETAIL_MERGE_HEAD_CLASS}>
                        <span className={CHAT_CITATION_DETAIL_INDEX_CLASS}>片段 {index + 1}</span>
                        {chunk.section_path || chunk.source_path ? (
                          <span className={CHAT_CITATION_DETAIL_MERGE_META_CLASS}>
                            {chunk.section_path || chunk.source_path}
                          </span>
                        ) : null}
                      </div>
                      {chunk.excerpt ? (
                        <CitationMarkdown content={chunk.excerpt} />
                      ) : null}
                      {chunk.summary && chunk.summary !== (chunk.excerpt || '') ? (
                        <CitationMarkdown content={chunk.summary} />
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {citationDetailExcerpt(activeCitation) && (
                    <div className={CHAT_CITATION_DETAIL_SECTION_CLASS}>
                      <span>引用片段</span>
                      <CitationMarkdown content={citationDetailExcerpt(activeCitation)} />
                    </div>
                  )}
                  {citationDetailSummary(activeCitation) && (
                    <div className={CHAT_CITATION_DETAIL_SECTION_CLASS}>
                      <span>片段摘要</span>
                      <CitationMarkdown content={citationDetailSummary(activeCitation)} />
                    </div>
                  )}
                </>
              )}
              {(activeCitation.source_path || activeCitation.section_path || activeCitation.concept_id) && (
                <div className={CHAT_CITATION_DETAIL_GRID_CLASS}>
                  {activeCitation.source_path && (
                    <div>
                      <span>来源</span>
                      {activeCitation.source_type === 'web' && activeCitation.url ? (
                        <a
                          href={activeCitation.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#0f766e] underline decoration-[#0f766e]/35 underline-offset-2 hover:decoration-[#0f766e]"
                        >
                          {activeCitation.site || citationSourceLabel(activeCitation)}
                        </a>
                      ) : (
                        <strong>{citationSourceLabel(activeCitation)}</strong>
                      )}
                    </div>
                  )}
                  {activeCitation.section_path && (
                    <div>
                      <span>章节</span>
                      <strong>{citationSectionLabel(activeCitation)}</strong>
                    </div>
                  )}
                  {activeCitation.concept_id && (
                    <div>
                      <span>知识图谱</span>
                      <strong>{activeCitation.concept_id}</strong>
                    </div>
                  )}
                </div>
              )}
              {activeCitation.confidence_reason && (
                <div className={CHAT_CITATION_DETAIL_NOTE_CLASS}>{activeCitation.confidence_reason}</div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameSession)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameSession(null);
            setRenameTitle('');
          }
        }}
      >
        <DialogContent className="gap-0 overflow-hidden rounded-[16px] p-0">
          <DialogHeader className="px-[16px] pt-[16px] pb-[12px]">
            <DialogTitle className="text-[14px] leading-[normal] font-medium text-[#18181a]">
              重命名
            </DialogTitle>
          </DialogHeader>
          <div className="px-[16px] pb-[4px]">
            <Input
              autoFocus
              maxLength={80}
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveRename();
                }
              }}
              placeholder="输入会话名称"
            />
          </div>
          <div className="flex items-center justify-end gap-[8px] pt-[12px] pr-[16px] pb-[16px] pl-[12px]">
            <Button
              variant="outline"
              className="h-[32px] w-[80px] rounded-[10px] border-[rgba(24,24,26,0.08)] bg-white px-[12px] py-[8px] text-[14px] font-normal text-[rgba(24,24,26,0.8)] hover:border-[rgba(24,24,26,0.08)] hover:bg-[#e5e4e0] hover:text-[#18181a]"
              onClick={() => {
                setRenameSession(null);
                setRenameTitle('');
              }}
            >
              取消
            </Button>
            <Button
              className="h-[32px] w-[80px] rounded-[10px] bg-[#18181a] px-[12px] py-[8px] text-[14px] font-normal text-white hover:bg-[#303030] disabled:opacity-60"
              disabled={savingRename}
              onClick={() => void saveRename()}
            >
              {savingRename ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="删除会话"
        description="删除后无法恢复该会话及其消息记录，确定继续吗？"
        loading={deletingSession}
        onConfirm={() => void confirmDeleteSession()}
      />
    </>
  );
}

function CitationMarkdown({ content }: { content: string }) {
  return (
    <div className={CHAT_CITATION_DETAIL_MARKDOWN_CLASS}>
      <MarkdownMessage content={content} preserveLineBreaks={false} />
    </div>
  );
}

/**
 * 待回答卡片里的附件托盘：图片给瓷砖（缩略图可辨），其他文件给胶囊。
 *
 * 与对话输入框共用 CHAT_COMPOSER_ATTACHMENT_* 那套 token，视觉完全一致；
 * 区别只在于这里没有 26px 浮层托盘宽度的问题，可以直接展开成一行。
 */
function HandoffAttachmentTray({
  handoffId,
  attachments,
  onPick,
  onRemove,
}: {
  handoffId: string;
  attachments: ComposerAttachment[];
  onPick: (files: File[]) => void;
  onRemove: (uploadKey: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const images = attachments.filter(
    (item) => item.kind === 'image' && item.data_url,
  );
  const files = attachments.filter(
    (item) => !(item.kind === 'image' && item.data_url),
  );
  const uploading = attachments.some((item) => item.uploadStatus === 'uploading');
  return (
    <div className="grid gap-[8px]">
      {attachments.length > 0 && (
        <div className={CHAT_HANDOFF_ATTACHMENTS_CLASS} role="group" aria-label="已添加的附件">
          {images.map((attachment) => (
            <span className={CHAT_COMPOSER_ATTACHMENT_WRAP_CLASS} key={attachment.uploadKey}>
              <span
                className={cn(
                  CHAT_HANDOFF_ATTACHMENT_TILE_CLASS,
                  attachment.uploadStatus === 'error' && CHAT_COMPOSER_ATTACHMENT_TILE_ERROR_CLASS,
                )}
                role="img"
                aria-label={attachment.filename}
              >
                <img
                  className={CHAT_COMPOSER_ATTACHMENT_TILE_IMG_CLASS}
                  src={attachment.data_url || ''}
                  alt=""
                />
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
              <button
                type="button"
                className={CHAT_COMPOSER_ATTACHMENT_REMOVE_CLASS}
                onClick={() => onRemove(attachment.uploadKey)}
                aria-label={`移除附件 ${attachment.filename}`}
              >
                <StaffdeckIcon name="close" size={9} />
              </button>
              <span className={CHAT_COMPOSER_ATTACHMENT_LABEL_CLASS}>
                {attachment.filename}
                {attachment.uploadStatus === 'error' ? ` · ${attachment.error || '上传失败'}` : ''}
              </span>
            </span>
          ))}
          {files.map((attachment) => (
            <span
              className={cn(
                CHAT_FILE_CHIP_CLASS,
                attachment.uploadStatus === 'error' && CHAT_FILE_CHIP_ERROR_CLASS,
              )}
              key={attachment.uploadKey}
              title={attachment.filename}
            >
              <span className={CHAT_FILE_CHIP_BODY_CLASS}>
                <span className={CHAT_FILE_CHIP_ICON_CLASS}>
                  <StaffdeckIcon name={attachment.kind === 'pdf' ? 'file' : 'folder'} size={14} />
                </span>
                <span className={CHAT_FILE_CHIP_NAME_CLASS} data-i18n-ignore>
                  {attachment.filename}
                </span>
                <span className={CHAT_FILE_CHIP_META_CLASS} data-i18n-ignore>
                  {attachment.uploadStatus === 'uploading'
                    ? attachment.parse_job_id
                      ? `解析中 ${Math.round(attachment.parse_progress ?? 0)}%`
                      : '上传中'
                    : attachment.uploadStatus === 'error'
                      ? attachment.error || '上传失败'
                      : formatFileSize(attachment.size)}
                </span>
              </span>
              <button
                type="button"
                className={cn(CHAT_COMPOSER_ATTACHMENT_REMOVE_CLASS, 'mr-[6px] static')}
                onClick={() => onRemove(attachment.uploadKey)}
                aria-label={`移除附件 ${attachment.filename}`}
              >
                <StaffdeckIcon name="close" size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-[8px]">
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          multiple
          aria-label={`为待回答 ${handoffId} 添加图片或附件`}
          onChange={(event) => {
            const picked = Array.from(event.target.files || []);
            event.target.value = '';
            if (picked.length) onPick(picked);
          }}
        />
        <Button
          variant="outline"
          className="h-[30px] rounded-[9px] border-[rgba(24,24,26,0.10)] bg-white px-[10px] text-[12px] font-normal text-[#4b4b50] hover:bg-[#e5e4e0] hover:text-[#18181a]"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          <StaffdeckIcon name="upload" size={13} />
          <span className="ml-[6px]">{uploading ? '上传中' : '添加图片 / 附件'}</span>
        </Button>
        <span className="text-[11px] text-[#9a9a9f]">
          支持图片、PDF、文档；只发附件也可以
        </span>
      </div>
    </div>
  );
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function citationDetailExcerpt(citation: NonNullable<UseChatSession['activeCitation']>): string {
  return String(citation.content || citation.excerpt || citation.summary || '').trim();
}

function citationDetailSummary(citation: NonNullable<UseChatSession['activeCitation']>): string {
  const summary = String(citation.summary || '').trim();
  const content = String(citation.content || citation.excerpt || '').trim();
  return summary && summary !== content ? summary : '';
}
