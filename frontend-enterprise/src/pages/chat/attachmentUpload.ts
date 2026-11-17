import {
  ApiError,
  fetchChatAttachmentParseJob,
  uploadChatAttachments,
  type ChatAttachmentParseJob,
} from '@/api/client';
import type { ChatAttachmentRead } from '@/types';

import type { ComposerAttachment } from './chatTypes';

/** PDF 云端解析（MinerU）轮询上限：服务端 rq job 900s 超时 + 轮询余量。 */
const PARSE_POLL_TIMEOUT_MS = 12 * 60 * 1000;
const PARSE_POLL_INTERVAL_MS = 2000;

/** 上传前的乐观占位项：文件名/体积立刻可见，不等网络。 */
export function pendingComposerAttachment(
  uploadKey: string,
  file: File,
): ComposerAttachment {
  return {
    id: uploadKey,
    uploadKey,
    filename: file.name || '剪贴板文件',
    content_type: file.type || 'application/octet-stream',
    size: file.size,
    kind: file.type.startsWith('image/') ? 'image' : 'binary',
    uploadStatus: 'uploading',
  };
}

/** PDF 附件需要等云端解析完成才能发送；这里把轮询收敛成一个 await。 */
async function pollAttachmentParse(
  parsed: ChatAttachmentRead,
  tenantId: string,
  signal: AbortSignal,
  onProgress: (job: ChatAttachmentParseJob) => void,
): Promise<void> {
  const jobId = parsed.parse_job_id;
  if (!jobId) return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < PARSE_POLL_TIMEOUT_MS) {
    if (signal.aborted) return;
    try {
      const job = await fetchChatAttachmentParseJob(tenantId, jobId, signal);
      onProgress(job);
      if (job.status === 'succeeded' || job.status === 'failed') return;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.status === 404) {
        // 任务已不存在（网关重启清库等）：放行为普通附件，不再阻塞发送
        onProgress({
          id: jobId,
          attachment_id: parsed.id,
          filename: parsed.filename,
          status: 'succeeded',
          stage: 'parsed',
          progress: 100,
          error: null,
          created_at: null,
          finished_at: null,
        });
        return;
      }
      // 网络抖动不终止轮询，继续下一轮
    }
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, PARSE_POLL_INTERVAL_MS);
      if (signal.aborted) {
        window.clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  throw new Error('云端解析超时，请移除后重新上传');
}

export type UploadAttachmentOptions = {
  tenantId: string;
  file: File;
  uploadKey: string;
  signal: AbortSignal;
  /** 上传成功但解析仍在进行 / 已完成 / 失败时回调，调用方据此更新状态。 */
  onAttachment: (attachment: ComposerAttachment) => void;
  onError: (message: string) => void;
};

/**
 * 上传单个附件并等待可发送（PDF 含云端解析）。
 *
 * 对话输入框与「待回答」人工回复共用这一条路径：上限、解析拦截、错误文案
 * 都只有一处实现，不会两个入口漂移。
 */
export async function uploadAttachment({
  tenantId,
  file,
  uploadKey,
  signal,
  onAttachment,
  onError,
}: UploadAttachmentOptions): Promise<void> {
  try {
    const items = await uploadChatAttachments<ChatAttachmentRead[]>(
      tenantId,
      [file],
      signal,
    );
    const parsed = items[0];
    if (!parsed) throw new Error('文件解析结果为空');
    if (!parsed.parse_job_id) {
      onAttachment({ ...parsed, uploadKey, uploadStatus: 'ready' });
      return;
    }
    onAttachment({ ...parsed, uploadKey, uploadStatus: 'uploading' });
    await pollAttachmentParse(parsed, tenantId, signal, (job) => {
      onAttachment({
        ...parsed,
        uploadKey,
        parse_status: job.status,
        parse_progress: job.progress,
        uploadStatus:
          job.status === 'succeeded' ? 'ready' : job.status === 'failed' ? 'error' : 'uploading',
        error: job.status === 'failed' ? job.error || '云端解析失败，请重试' : null,
      });
    });
  } catch (error) {
    if (signal.aborted) return;
    onError(error instanceof Error ? error.message : '上传失败');
  }
}

export function readyAttachmentsOf(attachments: ComposerAttachment[]): ChatAttachmentRead[] {
  return attachments
    .filter((item) => item.uploadStatus === 'ready')
    .map(({ uploadStatus: _status, uploadKey: _key, ...rest }) => rest);
}

export function hasUploadingAttachment(attachments: ComposerAttachment[]): boolean {
  return attachments.some((item) => item.uploadStatus === 'uploading');
}