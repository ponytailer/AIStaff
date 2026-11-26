import type { ChatAttachmentRead } from '@/types';

import type { ComposerInteractionMode } from './chatTypes';

const CHAT_QUEUE_STORAGE_PREFIX = 'skill_agent_chat_queue';
const INTERACTION_MODES = new Set<ComposerInteractionMode>(['normal', 'scheduled_task']);

type ChatQueueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type PreparedChatTurn = {
  queueId: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  text: string;
  attachments: ChatAttachmentRead[];
  interactionMode: ComposerInteractionMode;
  modelConfigId?: string;
  createdAt: string;
  /** A2UI 表单提交的结构化取值（普通输入消息不带）。 */
  slotSubmission?: Record<string, unknown>;
  /**
   * 指定的场景实例 id（胶囊点开表单提交轮必带）。
   *
   * 表单提交的文本是「人数：4；天数：5；预算：3000」，**一个关键词都没有**，
   * 后端靠 `trigger_json.keywords` 匹配必然落空。所以这一轮必须由前端显式
   * 指定场景，后端才会跳过意图识别直接进该场景（见
   * `backend/app/session/session_schema.py` 的 `forced_scene_id` 注释）。
   *
   * 后端仍会校验它在该员工当前生效的绑定集内：解绑后的旧请求、伪造的
   * scene_id 都会被静默回落成普通对话，不会越权。
   */
  forcedSceneId?: string;
  /** 本轮「互联网检索」开关（默认 false：只在用户打开时随请求携带 true）。 */
  webSearch?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isQueuedAttachment(value: unknown): value is ChatAttachmentRead {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.filename === 'string'
    && typeof value.content_type === 'string'
    && typeof value.size === 'number'
    && ['text', 'pdf', 'image', 'binary'].includes(String(value.kind || ''))
  );
}

function isPreparedChatTurn(value: unknown): value is PreparedChatTurn {
  if (!isRecord(value)) return false;
  return (
    typeof value.queueId === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.agentId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.text === 'string'
    && Array.isArray(value.attachments)
    && value.attachments.every(isQueuedAttachment)
    && typeof value.interactionMode === 'string'
    && INTERACTION_MODES.has(value.interactionMode as ComposerInteractionMode)
    && (value.modelConfigId === undefined || typeof value.modelConfigId === 'string')
    && (value.slotSubmission === undefined || isRecord(value.slotSubmission))
    && (value.forcedSceneId === undefined || typeof value.forcedSceneId === 'string')
    && (value.webSearch === undefined || typeof value.webSearch === 'boolean')
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
  );
}

export function chatQueueStorageKey(tenantId: string, userId: string): string {
  return `${CHAT_QUEUE_STORAGE_PREFIX}:${tenantId || 'default'}:${userId || 'anonymous'}`;
}

export function readQueuedChatTurns(storage: ChatQueueStorage, key: string): PreparedChatTurn[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Invalid chat queue payload');

    const seen = new Set<string>();
    const turns = parsed.filter((value): value is PreparedChatTurn => {
      if (!isPreparedChatTurn(value)) return false;
      const identity = `${value.queueId}:${value.turnId}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    if (turns.length !== parsed.length) {
      writeQueuedChatTurns(storage, key, turns);
    }
    return turns;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage access can be blocked by the browser privacy policy.
    }
    return [];
  }
}

export function writeQueuedChatTurns(
  storage: ChatQueueStorage,
  key: string,
  turns: PreparedChatTurn[],
): boolean {
  try {
    if (turns.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(turns));
    }
    return true;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage cleanup is best-effort when the browser quota is unavailable.
    }
    return false;
  }
}
