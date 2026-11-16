import { type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';

import AppSidebar from '@/components/AppSidebar';
import { SidebarProvider } from '@/components/ui/sidebar';
import { EnterpriseRoute } from '@/enums/routes';
import { cn } from '@/lib/utils';

import { CHAT_BODY_CLASS, CHAT_COLUMN_CLASS, CHAT_MAIN_CLASS, CHAT_MESSAGE_SHELL_CLASS } from './chatPageStyles';
import { sessionHasUnreadReply } from './chatHelpers';
import { useChatSession } from './useChatSession';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import Composer from './components/Composer';
import ChatContextRail from './components/ChatContextRail';
import ChatDialogs from './components/ChatDialogs';

export default function ChatPage() {
  const chat = useChatSession();
  const navigate = useNavigate();

  return (
    <SidebarProvider
      open={!chat.sidebarCollapsed}
      onOpenChange={(open) => {
        if (open === chat.sidebarCollapsed) chat.toggleSidebar();
      }}
      style={
        {
          '--sidebar-width': '272px',
          '--sidebar-width-icon': '72px',
        } as CSSProperties
      }
      className="h-screen min-h-0 sd1-canvas text-[#18181a]"
    >
      <AppSidebar
        variant="chat"
        sessions={chat.visibleSidebarSessions}
        sessionsLoading={chat.sessionsLoading}
        agents={chat.agents}
        currentAgent={chat.displayedAgent}
        currentRoleName={chat.displayedProfile?.roleName ?? ''}
        running={chat.currentSessionRunning}
        switchAgents={chat.agents}
        switchDispatchers={chat.dispatcherAgents}
        onSwitchAgent={(agentId) => {
          // 切换员工 = 对他开一个新草稿：当前会话属于上一位员工，就地续写会串味。
          chat.setSessionAgentFilter(agentId);
          chat.openDraftForAgent(agentId);
        }}
        activeSessionId={chat.sessionId}
        sessionFilter={chat.sessionAgentFilter}
        onSessionFilterChange={chat.setSessionAgentFilter}
        sessionFilterOptions={chat.sessionFilterOptions}
        isSessionUnread={(session) => sessionHasUnreadReply(session, chat.sessionReadTimes, chat.sessionId)}
        onOpenSession={chat.openSession}
        onNewConversation={() => {
          const selectedAgent = chat.sessionAgentFilter === 'all'
            ? chat.displayedAgent
            : chat.agents.find((agent) => agent.id === chat.sessionAgentFilter);
          if (selectedAgent) chat.openDraftForAgent(selectedAgent.id);
          else chat.openGallery();
        }}
        onOpenHome={() => navigate(EnterpriseRoute.Platform)}
        onOpenGallery={chat.openGallery}
        handoffCount={chat.handoffs.length}
        onOpenHandoffs={chat.openHandoffInbox}
        onRenameSession={chat.openRename}
        onDeleteSession={chat.requestDelete}
        onOpenAdmin={chat.openAdmin}
      />
      <main className={cn(CHAT_MAIN_CLASS, 'flex-1')}>
        <ChatHeader chat={chat} />
        <div className={CHAT_BODY_CLASS}>
          <div className={CHAT_COLUMN_CLASS}>
            <div className={CHAT_MESSAGE_SHELL_CLASS}>
              <MessageList chat={chat} />
            </div>
            <Composer chat={chat} />
          </div>
          <ChatContextRail chat={chat} />
        </div>
      </main>
      <ChatDialogs chat={chat} />
    </SidebarProvider>
  );
}
