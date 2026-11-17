import { useEffect, useState } from 'react';

import { api, TENANT_ID } from '../api/client';

/**
 * 员工 FAQ 概览计数（员工档案头部指标 / 对话右栏「员工能力」）。
 *
 * 单独一个接口而不是塞进 AgentProfileRead：列表页拉几十个员工时按 agent 逐条
 * 数 FAQ 就是 N+1；只有真正打开某个员工时才需要这个数，按需问一次最省。
 * 非 owner/管理员会拿到 403（FAQ 模块对他们不可见）——此时返回 null，调用方
 * 整行不渲染，别显示成「未配置」误导。
 */
export type AgentFaqCount = {
  faq_items: number;
  faq_active: number;
  unanswered: number;
};

export function useAgentFaqCount(agentId?: string | null): AgentFaqCount | null {
  const [count, setCount] = useState<AgentFaqCount | null>(null);

  useEffect(() => {
    setCount(null);
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.get<AgentFaqCount>(
          `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/count?tenant_id=${TENANT_ID}`,
        );
        if (!cancelled) setCount(next);
      } catch {
        // 无权限 / 接口不可用：不显示 FAQ 这一行，不能当成 0。
        if (!cancelled) setCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return count;
}
