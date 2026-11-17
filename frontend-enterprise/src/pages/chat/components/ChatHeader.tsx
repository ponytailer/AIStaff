import { staffdeckDisplayText } from '@/employee';

import { Badge } from '@/components/ui';
import IconEdit from '@/assets/icons/edit.svg?react';

import {
  CHAT_HEADER_CLASS,
  CHAT_HEADER_TITLE_NAME_CLASS,
  CHAT_HEADER_TITLE_STACK_CLASS,
} from '../chatPageStyles';
import type { UseChatSession } from '../useChatSession';

/**
 * 会话标题栏：只有标题（+ 发起人/群聊徽标 + 重命名）。
 *
 * 右上角原来放着「分享员工 / 语言切换 / 账户菜单」，用户明确要求移除 ——
 * 那组图标悬在右栏卡片正上方，让右侧看上去是「工具栏 + 一张被压住的卡」；
 * 拿掉之后右栏卡片成为页面最右侧元素，与左侧会话窗口对齐。
 * 功能没有丢：账户菜单与语言切换在「管理端」顶栏（AppHeader）仍是完整入口，
 * 「分享数字员工」在广场与员工档案页（EmployeeProfileEditor）也有。
 */
export default function ChatHeader({ chat }: { chat: UseChatSession }) {
  const { auth, currentSession, openRename } = chat;
  const teamId = currentSession?.team_id || null;
  const rawName = currentSession?.title
    ? staffdeckDisplayText(currentSession.title)
    : currentSession?.id || '新对话';
  // 发起人非当前用户时展示其名字（管理员/处理人查看他人会话的场景）
  const sessionOwnerName = currentSession?.user_display_name
    && currentSession.user_id
    && currentSession.user_id !== auth?.user?.id
    ? currentSession.user_display_name
    : null;
  // 历史团队会话的标题带「团队 xxx · TL 对话」前缀；Team 模块已移除，
  // 但旧会话仍要能打开，这里只做标题清理，不再查团队列表。
  const name = teamId
    ? rawName.replace(/^团队\s*/, '').replace(/\s*·\s*TL 对话$/, '')
    : rawName;

  return (
    <div className={CHAT_HEADER_CLASS}>
      <div className="flex min-w-0 items-center gap-[8px]">
        <div className={CHAT_HEADER_TITLE_STACK_CLASS}>
          <span className="flex min-w-0 items-center gap-[4px]">
            <span className={CHAT_HEADER_TITLE_NAME_CLASS}>{name}</span>
            {sessionOwnerName && (
              <Badge
                variant="secondary"
                className="shrink-0 rounded-full bg-[#f2f1ee] text-[11px] font-normal text-[#6d6d72]"
              >
                {sessionOwnerName} 发起
              </Badge>
            )}
            {teamId && (
              <Badge
                variant="secondary"
                className="shrink-0 rounded-full bg-[#e8f0ff] text-[12px] font-normal text-[#1a71ff]"
              >
                群聊
              </Badge>
            )}
            {currentSession && !teamId && (
              <button
                type="button"
                aria-label="重命名会话"
                onClick={() => openRename(currentSession)}
                className="inline-grid size-[14px] shrink-0 place-items-center text-[#6d6d72] transition-colors hover:text-[#18181a]"
              >
                <IconEdit className="size-[14px]!" />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
