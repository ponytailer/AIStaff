import { useCallback, useEffect, useMemo, useState } from 'react';
import IconEdit from '../assets/icons/edit.svg?react';
import IconMore from '../assets/icons/more.svg?react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';
import { api, TENANT_ID } from '../api/client';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../auth';
import { canManageEmployeeAgent } from '../employee';
import { readEmployeeScope } from '../lib/agent-scope-storage';
import { notify } from '@/components/ui/app-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from './scheduled-tasks/StatusBadge';
import type { AgentProfileRead } from '../types';

interface FaqItem {
  id: string;
  question: string;
  answer_markdown: string;
  keywords: string[];
  source: string;
  status: string;
  usage_count: number;
}

interface UnansweredQuery {
  id: string;
  query: string;
  hit_count: number;
  source: string;
  updated_at: string;
  suggested_keywords: string[];
}

interface HandoffCandidate {
  id: string;
  query: string;
  pending_question: string | null;
  human_reply: string | null;
  answered_at: string | null;
  suggested_keywords: string[];
}

/** 待沉淀行：两个来源合并成一张表，用 badge 区分。 */
type CandidateRow =
  | { key: string; kind: 'unanswered'; row: UnansweredQuery }
  | { key: string; kind: 'handoff'; row: HandoffCandidate };

type DrawerSource = 'unanswered' | 'handoff' | 'manual' | 'edit';

interface DrawerState {
  source: DrawerSource;
  sourceId: string | null;
  editItemId: string | null;
  question: string;
  answer: string;
  keywords: string[];
  suggested: string[];
}

const MENU_CONTENT_CLASS = 'min-w-[140px] rounded-[12px] p-1';
const MENU_ITEM_CLASS = 'gap-[8px] rounded-[8px] px-[10px] py-[7px] text-[13px]';

const SOURCE_META: Record<string, { label: string; tone: 'blue' | 'orange' | 'gray' }> = {
  unanswered: { label: '自动收集', tone: 'blue' },
  handoff: { label: '人工兜底', tone: 'orange' },
  manual: { label: '手动新建', tone: 'gray' },
};

function sourceBadge(source: string) {
  const meta = SOURCE_META[source] ?? { label: source, tone: 'gray' as const };
  return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
}

function formatTime(value?: string | null) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function FaqPage({
  currentUser,
  embedded = false,
  agent: agentProp,
}: {
  currentUser?: EnterpriseAuthUser;
  embedded?: boolean;
  agent?: AgentProfileRead;
} = {}) {
  const [agentId, setAgentId] = useState(agentProp?.id || readEmployeeScope());
  const [loading, setLoading] = useState(false);
  const [unanswered, setUnanswered] = useState<UnansweredQuery[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffCandidate[]>([]);
  const [items, setItems] = useState<FaqItem[]>([]);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<CandidateRow | FaqItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [newKw, setNewKw] = useState('');

  const canManage = useMemo(() => {
    if (!currentUser) return false;
    if (isEnterpriseAdmin(currentUser)) return true;
    // 只认传进来的 agent：拿不到就按「无权限」处理。
    // 这里曾经 `return true` 兜底，等于「没传 agent 就谁都能改 FAQ」——
    // 而档案页的 FAQ tab 恰恰可能不带 agent 进来。
    if (agentProp) return canManageEmployeeAgent(agentProp, currentUser);
    return false;
  }, [agentProp, currentUser]);

  const load = useCallback(async () => {
    if (!agentId) return;
    // 后端三个读接口（items/unanswered/handoffs）都要求「创建人或管理员」，
    // 非 owner 进来会连吃 3 个 403：页面既空又弹三条错误，等于坏页。
    // 没有管理权限就不发请求，由下面的只读说明卡交代原因。
    if (!canManage) {
      setUnanswered([]);
      setHandoffs([]);
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const base = `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq`;
      const tenant = `?tenant_id=${TENANT_ID}`;
      const [u, h, i] = await Promise.all([
        api.get<UnansweredQuery[]>(`${base}/unanswered${tenant}`),
        api.get<HandoffCandidate[]>(`${base}/handoffs${tenant}`),
        api.get<FaqItem[]>(`${base}/items${tenant}`),
      ]);
      setUnanswered(u);
      setHandoffs(h);
      setItems(i);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [agentId, canManage]);

  useEffect(() => {
    if (!agentProp) setAgentId(readEmployeeScope());
  }, [agentProp]);
  useEffect(() => {
    void load();
  }, [load]);

  const candidates: CandidateRow[] = useMemo(
    () => [
      ...unanswered.map((row) => ({ key: `u:${row.id}`, kind: 'unanswered' as const, row })),
      ...handoffs.map((row) => ({ key: `h:${row.id}`, kind: 'handoff' as const, row })),
    ],
    [handoffs, unanswered],
  );

  const openDrawer = (candidate: CandidateRow) => {
    if (candidate.kind === 'unanswered') {
      setDrawer({
        source: 'unanswered',
        sourceId: candidate.row.id,
        editItemId: null,
        question: candidate.row.query,
        answer: '',
        keywords: candidate.row.suggested_keywords.slice(0, 6),
        suggested: candidate.row.suggested_keywords,
      });
      return;
    }
    setDrawer({
      source: 'handoff',
      sourceId: candidate.row.id,
      editItemId: null,
      question: candidate.row.query,
      answer: candidate.row.human_reply || '',
      keywords: candidate.row.suggested_keywords.slice(0, 6),
      suggested: candidate.row.suggested_keywords,
    });
  };

  const openDrawerForEdit = (item: FaqItem) => {
    setDrawer({
      source: 'edit',
      sourceId: null,
      editItemId: item.id,
      question: item.question,
      answer: item.answer_markdown,
      keywords: item.keywords.slice(),
      suggested: [],
    });
  };
  const openDrawerForNew = () => {
    setDrawer({ source: 'manual', sourceId: null, editItemId: null, question: '', answer: '', keywords: [], suggested: [] });
  };
  const closeDrawer = () => setDrawer(null);

  const addKeyword = () => {
    if (!drawer || !newKw.trim()) return;
    const kw = newKw.trim().replace(/\s+/g, '');
    if (!kw || drawer.keywords.includes(kw)) {
      setNewKw('');
      return;
    }
    setDrawer({ ...drawer, keywords: [...drawer.keywords, kw] });
    setNewKw('');
  };
  const removeKeyword = (kw: string) => {
    if (!drawer) return;
    setDrawer({ ...drawer, keywords: drawer.keywords.filter((k) => k !== kw) });
  };

  const adopt = async () => {
    if (!drawer || !agentId) return;
    if (!drawer.question.trim()) {
      notify.error('问题不能为空');
      return;
    }
    if (!drawer.answer.trim()) {
      notify.error('答案不能为空');
      return;
    }
    if (drawer.keywords.length < 1) {
      notify.error('至少配置 1 个触发关键词，命中即直接回答');
      return;
    }
    setSaving(true);
    try {
      const base = `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq`;
      const q = `?tenant_id=${TENANT_ID}`;
      if (drawer.editItemId) {
        await api.put<FaqItem>(`${base}/items/${drawer.editItemId}${q}`, {
          tenant_id: TENANT_ID,
          question: drawer.question,
          answer_markdown: drawer.answer,
          keywords: drawer.keywords,
        });
        notify.success('FAQ 已更新，立即生效');
      } else {
        await api.post<FaqItem>(`${base}/items${q}`, {
          tenant_id: TENANT_ID,
          question: drawer.question,
          answer_markdown: drawer.answer,
          keywords: drawer.keywords,
          source: drawer.source === 'handoff' ? 'handoff' : drawer.source === 'unanswered' ? 'unanswered' : 'manual',
          source_id: drawer.sourceId,
        });
        notify.success('已采纳进 FAQ，下次直接回答');
      }
      closeDrawer();
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteCandidate = async (candidate: CandidateRow) => {
    if (!agentId) return;
    try {
      if (candidate.kind === 'unanswered') {
        await api.post(
          `/api/enterprise/agents/${encodeURIComponent(agentId)}/unanswered/${candidate.row.id}:dismiss?tenant_id=${TENANT_ID}`,
          {},
        );
        setUnanswered((prev) => prev.filter((r) => r.id !== candidate.row.id));
      } else {
        await api.post(
          `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/handoffs/${candidate.row.id}:dismiss?tenant_id=${TENANT_ID}`,
          {},
        );
        setHandoffs((prev) => prev.filter((r) => r.id !== candidate.row.id));
      }
      setConfirmTarget(null);
      notify.success('已从待沉淀列表删除');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const toggleItem = async (item: FaqItem) => {
    if (!agentId) return;
    const next = item.status === 'active' ? 'disabled' : 'active';
    try {
      await api.put<FaqItem>(
        `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/items/${item.id}?tenant_id=${TENANT_ID}`,
        { tenant_id: TENANT_ID, status: next },
      );
      setItems((prev) => prev.map((r) => (r.id === item.id ? { ...r, status: next } : r)));
      notify.success(next === 'active' ? '已启用' : '已停用，恢复知识检索');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '操作失败');
    }
  };

  const deleteItem = async (item: FaqItem) => {
    if (!agentId) return;
    try {
      await api.delete(`/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/items/${item.id}?tenant_id=${TENANT_ID}`);
      setItems((prev) => prev.filter((r) => r.id !== item.id));
      setConfirmTarget(null);
      notify.success('FAQ 已删除');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const candidateColumns: DataTableColumn<CandidateRow>[] = [
    {
      key: 'query',
      title: '用户问法',
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[3px] py-[6px]">
          <span className="line-clamp-2 leading-[20px] text-[#18181a]" title={row.row.query}>
            {row.row.query}
          </span>
          {row.kind === 'handoff' && row.row.human_reply && (
            <span className="line-clamp-1 text-[12px] text-[#6d6d72]" title={row.row.human_reply}>
              人工回复：{row.row.human_reply}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'source',
      title: '来源',
      width: 108,
      render: (row) => sourceBadge(row.kind),
    },
    {
      key: 'count',
      title: '被问次数',
      width: 96,
      render: (row) => (row.kind === 'unanswered' ? `${row.row.hit_count} 次` : '-'),
    },
    {
      key: 'time',
      title: '时间',
      width: 150,
      render: (row) => (row.kind === 'unanswered' ? formatTime(row.row.updated_at) : formatTime(row.row.answered_at)),
    },
    {
      key: 'actions',
      title: '操作',
      width: 132,
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-[4px]">
          <button
            onClick={() => openDrawer(row)}
            className="rounded-[8px] px-[10px] py-[6px] text-[12.5px] font-medium text-[#1a71ff] transition-colors hover:bg-black/5 hover:text-[#4a8dff]"
          >
            采纳
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="更多操作"
              className="grid size-7 place-items-center rounded-[8px] text-[#6d6d72] transition-colors outline-none hover:bg-black/5 hover:text-[#18181a]"
            >
              <IconMore className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
              <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => setConfirmTarget(row)}>
                <IconTrash />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  const itemColumns: DataTableColumn<FaqItem>[] = [
    {
      key: 'question',
      title: '问题',
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[3px] py-[6px]">
          <span className="line-clamp-1 font-medium leading-[20px] text-[#18181a]" title={row.question}>
            {row.question}
          </span>
          <span className="line-clamp-1 text-[12px] text-[#6d6d72]" title={row.answer_markdown}>
            {row.answer_markdown}
          </span>
        </div>
      ),
    },
    { key: 'source', title: '来源', width: 108, render: (row) => sourceBadge(row.source) },
    {
      key: 'keywords',
      title: '关键词',
      width: 190,
      render: (row) => (
        <span className="line-clamp-1 text-[12px] text-[#6d6d72]" title={row.keywords.join('、')}>
          {row.keywords.join('、') || '-'}
        </span>
      ),
    },
    { key: 'usage', title: '命中', width: 76, render: (row) => `${row.usage_count} 次` },
    {
      key: 'status',
      title: '状态',
      width: 84,
      render: (row) => (
        <button onClick={() => void toggleItem(row)} className="outline-none">
          <StatusBadge tone={row.status === 'active' ? 'green' : 'gray'}>
            {row.status === 'active' ? '已启用' : '已停用'}
          </StatusBadge>
        </button>
      ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 96,
      align: 'right',
      render: (row) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="FAQ 操作"
            className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#6d6d72] transition-colors outline-none hover:bg-black/5 hover:text-[#18181a]"
          >
            <IconMore className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openDrawerForEdit(row)}>
              <IconEdit />
              编辑
            </DropdownMenuItem>
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => setConfirmTarget(row)}>
              <IconTrash />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div
      className={embedded ? 'min-h-0' : 'min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]'}
      aria-busy={loading}
    >
      {/* 无管理权限时整页降为只读说明：后端连读接口都要求「创建人或管理员」，
          给表格也只会是三个 403。之前是在页尾补一行小字，用户已经看到空表了，
          所以必须把说明放到最前面。 */}
      {!canManage && (
        <section className="mb-[24px] rounded-[14px] border border-[rgba(24,24,26,0.14)] bg-[#f2f1ee] px-[18px] py-[16px]">
          <h3 className="m-0 text-[14px] font-semibold text-[#18181a]">FAQ 仅对员工创建人或管理员开放</h3>
          <p className="m-0 mt-[6px] text-[12.5px] leading-[1.7] text-[#6d6d72]">
            你在查看其他同事的数字员工，FAQ 的查看与维护属于管理动作。需要修改请联系该员工的创建人或租户管理员。
          </p>
        </section>
      )}

      {canManage && (
      <>
      <section className="mb-[36px]">
        <div className="mb-[14px] flex items-center gap-[12px] text-[#6d6d72]">
          <span className="text-[14px] leading-none">待沉淀</span>
          <span className="text-[12px] text-[#9a9a9f]">
            答不上来或人工兜底过的问答 —— 确认答案后采纳为 FAQ，下次同样的问题员工直接回答
          </span>
          <button
            onClick={() => void load()}
            className="ml-auto flex items-center gap-[5px] rounded-[8px] px-[8px] py-[5px] text-[12.5px] text-[#6d6d72] transition-colors hover:bg-black/5 hover:text-[#18181a]"
          >
            <IconRefresh className="size-3.5" />
            刷新
          </button>
        </div>
        <DataTable
          aria-label="待沉淀问答列表"
          columns={candidateColumns}
          data={candidates}
          rowKey={(row) => row.key}
          loading={loading}
          emptyText="暂无待沉淀的问答，员工这阵子状态不错。"
        />
      </section>

      <section>
        <div className="mb-[14px] flex items-center gap-[12px] text-[#6d6d72]">
          <span className="text-[14px] leading-none">FAQ 库</span>
          <span className="text-[12px] text-[#9a9a9f]">命中规则：命中任意 1 个关键词即短路回答</span>
          <button
            onClick={openDrawerForNew}
            className="ml-auto flex items-center gap-[5px] rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[10px] py-[5px] text-[12.5px] text-[#18181a] transition-colors hover:border-[rgba(24,24,26,0.3)]"
          >
            ＋ 手动新建
          </button>
        </div>
        <DataTable
          aria-label="员工 FAQ 列表"
          columns={itemColumns}
          data={items}
          rowKey={(row) => row.id}
          loading={loading}
          emptyText="还没有 FAQ，从上面的待沉淀列表采纳第一条吧。"
        />
      </section>
      </>
      )}

      {drawer && (
        <>
          <div className="fixed inset-0 z-40 bg-[rgba(24,24,26,0.28)]" onClick={closeDrawer} />
          <aside className="fixed right-0 top-0 bottom-0 z-50 flex w-[480px] max-w-[92vw] flex-col border-l border-[rgba(24,24,26,0.14)] bg-[#fbfbfa]">
            <div className="flex items-baseline justify-between border-b border-[rgba(24,24,26,0.14)] px-8 pb-4 pt-6">
              <h3 className="font-serif text-[20px] font-semibold text-[#18181a]">{drawer.editItemId ? '编辑 FAQ' : '采纳为 FAQ'}</h3>
              <span className="text-[12px] text-[#9a9a9f]">
                {drawer.editItemId ? '修改后立即生效' : `来源 · ${SOURCE_META[drawer.source]?.label ?? '手动新建'}`}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="mb-6">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[#9a9a9f]">用户问法</label>
                <input
                  value={drawer.question}
                  onChange={(e) => setDrawer({ ...drawer, question: e.target.value })}
                  className="w-full rounded-xl border border-[rgba(24,24,26,0.14)] bg-white px-3.5 py-2.5 text-[13.5px] outline-none transition focus:border-[#0f766e]"
                  placeholder="对话按这里的问题匹配，可改写成更常见的说法"
                />
              </div>
              <div className="mb-6">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[#9a9a9f]">标准答案</label>
                <textarea
                  value={drawer.answer}
                  onChange={(e) => setDrawer({ ...drawer, answer: e.target.value })}
                  className="min-h-[150px] w-full resize-y rounded-xl border border-[rgba(24,24,26,0.14)] bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed outline-none transition focus:border-[#0f766e]"
                  placeholder="写下希望员工直接引用的答案……"
                />
              </div>
              <div className="mb-6">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[#9a9a9f]">
                  触发关键词 <span className="tracking-normal text-[#0f766e]">· 命中任意 1 个即回答</span>
                </label>
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[rgba(24,24,26,0.14)] bg-white p-2.5">
                  {drawer.keywords.map((kw) => (
                    <span
                      key={kw}
                      className="flex items-center gap-1.5 rounded-full bg-[rgba(24,24,26,0.04)] px-3 py-1 text-[12px] text-[#6d6d72]"
                    >
                      {kw}
                      <button onClick={() => removeKeyword(kw)} className="text-[13px] leading-none text-[#9a9a9f] hover:text-[#a32d2d]">
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    value={newKw}
                    onChange={(e) => setNewKw(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addKeyword();
                      }
                    }}
                    className="min-w-[120px] flex-1 border-none bg-none px-1 py-0.5 text-[13px] outline-none"
                    placeholder="回车添加，如「密码」「重置」"
                  />
                </div>
                {drawer.suggested.length > 0 && (
                  <div className="mt-2 text-[12px] leading-relaxed text-[#9a9a9f]">
                    建议词：{drawer.suggested.filter((k) => !drawer.keywords.includes(k)).slice(0, 8).join('、') || '已全部加入'}
                  </div>
                )}
              </div>
              <div className="mb-2">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[#9a9a9f]">回答预览</label>
                <div className="rounded-xl border border-[rgba(24,24,26,0.08)] bg-white px-4 py-3.5 text-[13px] text-[#3d3d3f]">
                  {drawer.answer
                    ? drawer.answer.split('\n').map((line, idx) => (
                        <p key={idx} className="min-h-[1.4em]">
                          {line}
                        </p>
                      ))
                    : '（答案为空）'}
                  <div className="mt-2.5 rounded-lg border border-[rgba(24,24,26,0.14)] px-3 py-2 text-[12px] text-[#9a9a9f]">
                    回答末尾将自动附加「来自员工 FAQ」提示
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 border-t border-[rgba(24,24,26,0.14)] px-8 py-5">
              <span className="mr-auto text-[12px] text-[#9a9a9f]">
                {drawer.editItemId ? '保存后立即生效' : '采纳后立即对用户生效'}
              </span>
              <button onClick={closeDrawer} className="rounded-[10px] border border-[rgba(24,24,26,0.14)] bg-white px-4 py-2 text-[12.5px] text-[#18181a]">
                取消
              </button>
              <button
                onClick={() => void adopt()}
                disabled={saving}
                className="rounded-[10px] border border-[#18181a] bg-[#18181a] px-4 py-2 text-[12.5px] text-white transition hover:bg-black disabled:opacity-60"
              >
                {saving ? '保存中…' : drawer.editItemId ? '保存修改' : '确认采纳'}
              </button>
            </div>
          </aside>
        </>
      )}

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget && 'kind' in confirmTarget ? '从待沉淀删除' : '删除 FAQ'}
        description={
          confirmTarget && 'kind' in confirmTarget
            ? '删除后该条记录不再出现在待沉淀列表；同类问题被再次问起时会重新收集。'
            : '删除后员工将不再用这条标准答案回答，恢复走知识检索。'
        }
        confirmText="确认删除"
        onConfirm={() => {
          if (!confirmTarget) return;
          if ('kind' in confirmTarget) void deleteCandidate(confirmTarget);
          else void deleteItem(confirmTarget);
        }}
      />
    </div>
  );
}
