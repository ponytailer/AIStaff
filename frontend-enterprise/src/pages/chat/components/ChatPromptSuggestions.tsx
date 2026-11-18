import { SolutionOutlined } from '@/icons';

import {
  CHAT_EMPTY_PROMPT_CARD_CLASS,
  CHAT_EMPTY_PROMPT_GRID_CLASS,
  CHAT_EMPTY_PROMPT_ICON_CLASS,
  CHAT_EMPTY_PROMPT_TEXT_CLASS,
} from '../chatPageStyles';

/**
 * 聊天空态下方的「快捷提问」点选卡。
 *
 * 形态参考 tuffui PromptSuggestions 的 `cards` 变体（空聊天用：图标 + 一句话，
 * 点了直接把这句话发出去），但只取「可点的一张卡」这一点，不复刻它的刷新 /
 * heading / chips —— 这些内容由员工配置写死 1-3 条，不是模型现生成的追问，
 * 没有「换一批」的语义。
 *
 * 为什么整块由外部判空而不是自己判：空态里它要跟着 `CHAT_EMPTY_CLASS` 的
 * 16px 栅格走，渲染一个空 div 会多撑出一段空白，把垂直居中的整块往下推。
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
    <div className={CHAT_EMPTY_PROMPT_GRID_CLASS}>
      {prompts.map((prompt, index) => (
        <button
          key={`${index}-${prompt}`}
          type="button"
          disabled={disabled}
          // aria-label 带上序号与全文：卡片正文是 line-clamp-2，长句在无障碍树里
          // 只剩截断前的文本，读屏用户听不出两句的区别。
          aria-label={`快捷提问 ${index + 1}：${prompt}`}
          title={prompt}
          onClick={() => onSelect(prompt)}
          className={CHAT_EMPTY_PROMPT_CARD_CLASS}
        >
          <span className={CHAT_EMPTY_PROMPT_ICON_CLASS} aria-hidden="true">
            {/* 走 `size` 而不是 className：StaffdeckIcon 把尺寸写在 width/height
                属性上，单靠 size-[11px] 类压不下去（属性优先级高于 class）。 */}
            <SolutionOutlined size={11} />
          </span>
          <span className={CHAT_EMPTY_PROMPT_TEXT_CLASS}>{prompt}</span>
        </button>
      ))}
    </div>
  );
}