import { SolutionOutlined } from '@/icons';

import {
  CHAT_PROMPT_CHIP_CLASS,
  CHAT_PROMPT_ICON_CLASS,
  CHAT_PROMPT_ROW_CLASS,
  CHAT_PROMPT_TEXT_CLASS,
} from '../chatPageStyles';

/**
 * 输入框正上方的「快捷提问」胶囊行（员工配置里的 1-3 条 suggested_prompts）。
 *
 * 原本画在空态问候卡下方，2026-11-25 挪到输入框上方：位置跟着「输入」走，
 * 用户读完问候语视线下移就能看到能点的话术，不用在空态和输入框之间来回扫。
 *
 * 为什么是扁胶囊而不是卡片：它们和输入框是同一组（"这句话可以这么问"），
 * 卡片形态会把三句话读成三块独立内容；26px 单行 + 圆角全开之后，与输入卡
 * 里的「互联网检索」胶囊同构，一眼就知道是工具条的一部分。
 *
 * 为什么整块由外部判空而不是自己判：空数组时返回 null 不占高度；外部还会
 * 按「会话是否已有消息」决定要不要挂载它，避免有历史消息的会话里再冒出来。
 */
export default function ChatPromptSuggestions({
  prompts,
  disabled = false,
  onSelect,
}: {
  prompts: string[];
  /** 会话正在跑 / 分享只读时置灰：此时点下去发不出去，可点样式就是骗人。 */
  disabled?: boolean;
  onSelect: (prompt: string) => void;
}) {
  if (prompts.length === 0) return null;

  return (
    <div className={CHAT_PROMPT_ROW_CLASS}>
      {prompts.map((prompt, index) => (
        <button
          key={`${index}-${prompt}`}
          type="button"
          disabled={disabled}
          // aria-label 带上序号与全文：正文是单行省略号，长句在无障碍树里
          // 只剩截断前的文本，读屏用户听不出两句的区别。
          aria-label={`快捷提问 ${index + 1}：${prompt}`}
          title={prompt}
          onClick={() => onSelect(prompt)}
          className={CHAT_PROMPT_CHIP_CLASS}
        >
          <span className={CHAT_PROMPT_ICON_CLASS} aria-hidden="true">
            {/* 走 `size` 而不是 className：StaffdeckIcon 把尺寸写在 width/height
                属性上，单靠 size-[11px] 类压不下去（属性优先级高于 class）。 */}
            <SolutionOutlined size={10} />
          </span>
          <span className={CHAT_PROMPT_TEXT_CLASS}>{prompt}</span>
        </button>
      ))}
    </div>
  );
}