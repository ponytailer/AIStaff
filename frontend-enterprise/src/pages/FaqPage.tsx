import { useCallback, useEffect, useMemo, useState } from 'react';
import IconRefresh from '../assets/icons/refresh.svg?react';
import IconTrash from '../assets/icons/trash.svg?react';
import { api, TENANT_ID } from '../api/client';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../auth';
import { canManageEmployeeAgent } from '../employee';
import { readEmployeeScope } from '../lib/agent-scope-storage';
import { notify } from '@/components/ui/app-toast';
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
  suggested_keywords: string[];
}

interface HandoffCandidate {
  id: string;
  query: string;
  pending_question: string | null;
  human_reply: string | null;
  suggested_keywords: string[];
}

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

const SOURCE_LABEL: Record<string, string> = {
  unanswered: '自动收集',
  handoff: '人工兜底',
  manual: '手动新建',
  edit: '编辑',
};

function faqSectionLabel(source: string) {
  return SOURCE_LABEL[source] ?? source;
}

function SectionHead({ no, title, desc, action }: { no: string; title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-[rgba(24,24,26,0.14)] pb-3">
      <span className="font-serif text-[13px] font-medium text-[#0f766e]">{no}</span>
      <h2 className="font-serif text-[21px] font-semibold tracking-[0.01em] text-[#18181a]">{title}</h2>
      {desc && <span className="ml-auto text-[12px] text-[rgba(24,24,26,0.4)]">{desc}</span>}
      {action}
    </div>
  );
}

function Tag({ label, tone }: { label: string; tone: 'teal' | 'amber' | 'muted' }) {
  const cls =
    tone === 'teal'
      ? 'bg-[rgba(15,118,110,0.08)] text-[#0f766e]'
      : tone === 'amber'
        ? 'bg-[rgba(133,79,11,0.09)] text-[#854f0b]'
        : 'bg-[rgba(24,24,26,0.04)] text-[rgba(24,24,26,0.4)]';
  return <span className={`rounded-full px-2.5 py-[1px] text-[11.5px] tracking-[0.03em] ${cls}`}>{label}</span>;
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
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newKw, setNewKw] = useState('');

  const canManage = useMemo(() => {
    if (!currentUser) return false;
    if (isEnterpriseAdmin(currentUser)) return true;
    if (agentProp) return canManageEmployeeAgent(agentProp, currentUser);
    return true;
  }, [agentProp, currentUser]);

  const load = useCallback(async () => {
    if (!agentId) return;
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
  }, [agentId]);

  useEffect(() => {
    if (!agentProp) setAgentId(readEmployeeScope());
  }, [agentProp]);
  useEffect(() => {
    void load();
  }, [load]);

  const openDrawerForUnanswered = (row: UnansweredQuery) => {
    setDrawer({
      source: 'unanswered',
      sourceId: row.id,
      editItemId: null,
      question: row.query,
      answer: '',
      keywords: row.suggested_keywords.slice(0, 6),
      suggested: row.suggested_keywords,
    });
  };
  const openDrawerForHandoff = (row: HandoffCandidate) => {
    setDrawer({
      source: 'handoff',
      sourceId: row.id,
      editItemId: null,
      question: row.query,
      answer: row.human_reply || '',
      keywords: row.suggested_keywords.slice(0, 6),
      suggested: row.suggested_keywords,
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
    if (drawer.keywords.length < 2) {
      notify.error('至少配置 2 个触发关键词，避免误命中');
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

  const dismiss = async (row: UnansweredQuery) => {
    if (!agentId) return;
    try {
      await api.post(
        `/api/enterprise/agents/${encodeURIComponent(agentId)}/unanswered/${row.id}:dismiss?tenant_id=${TENANT_ID}`,
        {},
      );
      setUnanswered((prev) => prev.filter((r) => r.id !== row.id));
      notify.success('已忽略，同类问题被反复问起时会重新出现');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '操作失败');
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
      setConfirmDeleteId(null);
      notify.success('FAQ 已删除');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  const emptyRow = (text: string) => (
    <div className="border-b border-[rgba(24,24,26,0.08)] py-11 text-center text-[13px] text-[rgba(24,24,26,0.4)]">{text}</div>
  );

  return (
    <div
      className={embedded ? 'min-h-0' : 'min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]'}
      aria-busy={loading}
    >
      <div className="flex items-center justify-between pb-5">
        <div className="text-[13px] text-[rgba(24,24,26,0.6)]">
          答不上来的问题自动收集，人工兜过的问答可以复盘，确认后的问答沉淀为 FAQ——下次同样的问题员工直接回答。
        </div>
        <button onClick={() => void load()} className="flex items-center gap-1.5 rounded-[10px] border border-[rgba(24,24,26,0.14)] bg-white px-3 py-1.5 text-[12.5px] text-[rgba(24,24,26,0.8)] transition hover:border-[rgba(24,24,26,0.4)]">
          <IconRefresh className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      <section className="mb-14">
        <SectionHead no="01" title="无法回答" desc="检索不足或模型拒答时自动收集 · 同问合并计数" />
        <div>
          {unanswered.length === 0
            ? emptyRow('暂无待处理的问题，员工这阵子状态不错。')
            : unanswered.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1.5 border-b border-[rgba(24,24,26,0.08)] px-1 py-4 transition hover:bg-[rgba(24,24,26,0.03)]">
                  <div>
                    <div className="text-[14px] font-medium tracking-[0.01em] text-[#18181a]">{row.query}</div>
                    <div className="mt-1.5 flex items-center gap-2 text-[12px] text-[rgba(24,24,26,0.4)]">
                      <Tag label="自动收集" tone="teal" />
                      <span>
                        被问 <b className="font-medium text-[rgba(24,24,26,0.6)]">{row.hit_count}</b> 次 · 来源 {row.source === 'knowledge_refusal' ? '知识拒答' : row.source}
                      </span>
                    </div>
                  </div>
                  <div className="row-span-2 flex items-center gap-2">
                    <button onClick={() => openDrawerForUnanswered(row)} className="rounded-[10px] border border-[#18181a] bg-[#18181a] px-3.5 py-[7px] text-[12.5px] text-white transition hover:bg-black">
                      写答案 → FAQ
                    </button>
                    <button onClick={() => void dismiss(row)} className="rounded-[10px] px-2 py-[7px] text-[12.5px] text-[rgba(24,24,26,0.4)] transition hover:text-[#a32d2d]">
                      忽略
                    </button>
                  </div>
                </div>
              ))}
        </div>
      </section>

      <section className="mb-14">
        <SectionHead no="02" title="转人工记录" desc="人工已回复的会话 · 复盘后可沉淀为标准答案" />
        <div>
          {handoffs.length === 0
            ? emptyRow('暂无转人工记录。')
            : handoffs.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1.5 border-b border-[rgba(24,24,26,0.08)] px-1 py-4 transition hover:bg-[rgba(24,24,26,0.03)]">
                  <div>
                    <div className="text-[14px] font-medium tracking-[0.01em] text-[#18181a]">{row.query}</div>
                    <div className="mt-1.5 flex items-center gap-2 text-[12px] text-[rgba(24,24,26,0.4)]">
                      <Tag label="人工兜底" tone="amber" />
                    </div>
                    {row.human_reply && (
                      <div className="mt-2 rounded-r-xl border-l-2 border-[#854f0b] bg-[rgba(133,79,11,0.07)] px-4 py-3 text-[13px] text-[rgba(24,24,26,0.8)]">
                        <div className="mb-1 text-[11.5px] tracking-[0.05em] text-[#854f0b]">人工当时的回复</div>
                        {row.human_reply}
                      </div>
                    )}
                  </div>
                  <div className="row-span-2 flex items-center gap-2">
                    <button onClick={() => openDrawerForHandoff(row)} className="rounded-[10px] border border-[#18181a] bg-[#18181a] px-3.5 py-[7px] text-[12.5px] text-white transition hover:bg-black">
                      改答案 → FAQ
                    </button>
                  </div>
                </div>
              ))}
        </div>
      </section>

      <section>
        <SectionHead
          no="03"
          title="FAQ 库"
          desc="命中规则：≥2 个关键词同时命中才短路回答"
          action={
            <button onClick={openDrawerForNew} className="rounded-[10px] border border-[rgba(24,24,26,0.14)] bg-white px-3 py-1.5 text-[12.5px] text-[rgba(24,24,26,0.8)] transition hover:border-[rgba(24,24,26,0.4)]">
              ＋ 手动新建
            </button>
          }
        />
        <div className="mt-4 overflow-hidden rounded-[20px] border border-[rgba(24,24,26,0.14)] bg-white">
          {items.length === 0 ? (
            <div className="py-11 text-center text-[13px] text-[rgba(24,24,26,0.4)]">还没有 FAQ，从上面的待沉淀列表采纳第一条吧。</div>
          ) : (
            items.map((item) => (
              <div key={item.id} className="border-b border-[rgba(24,24,26,0.08)] last:border-b-0">
                <button
                  onClick={() => setOpenItemId(openItemId === item.id ? null : item.id)}
                  className="flex w-full items-center gap-3.5 px-6 py-[18px] text-left transition hover:bg-[rgba(24,24,26,0.03)]"
                >
                  <span className="flex-1 text-[14px] font-medium text-[#18181a]">{item.question}</span>
                  <Tag label={faqSectionLabel(item.source)} tone={item.source === 'handoff' ? 'amber' : 'teal'} />
                  <span className="text-[12px] text-[rgba(24,24,26,0.4)]">命中 {item.usage_count} 次</span>
                  <span
                    role="switch"
                    aria-checked={item.status === 'active'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleItem(item);
                    }}
                    className={`relative h-5 w-[34px] flex-none rounded-full transition ${item.status === 'active' ? 'bg-[#0f766e]' : 'bg-[rgba(24,24,26,0.14)]'}`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_0_0_0.5px_rgba(24,24,26,0.14)] transition-all ${item.status === 'active' ? 'left-4' : 'left-0.5'}`}
                    />
                  </span>
                  <span className={`text-[12px] text-[rgba(24,24,26,0.4)] transition-transform ${openItemId === item.id ? 'rotate-90 text-[#0f766e]' : ''}`}>▶</span>
                </button>
                {openItemId === item.id && (
                  <div className="px-6 pb-5">
                    <div className="rounded-r-xl border-l-2 border-[#0f766e] bg-[rgba(15,118,110,0.06)] px-4 py-3 text-[13.5px] text-[rgba(24,24,26,0.8)]">{item.answer_markdown}</div>
                    <div className="mt-3.5 flex flex-wrap gap-2">
                      {item.keywords.map((kw) => (
                        <span key={kw} className="rounded-full border border-[rgba(24,24,26,0.08)] bg-[rgba(24,24,26,0.04)] px-3 py-[3px] text-[12px] text-[rgba(24,24,26,0.6)]">
                          {kw}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 text-[12px] text-[rgba(24,24,26,0.4)]">
                      命中 <b className="font-medium text-[rgba(24,24,26,0.6)]">{item.usage_count}</b> 次 · 每次短路回答省去约 12s 规划开销
                    </div>
                    <div className="mt-4 flex gap-2">
                      <button onClick={() => openDrawerForEdit(item)} className="rounded-[10px] border border-[rgba(24,24,26,0.14)] bg-white px-3 py-1.5 text-[12.5px] text-[rgba(24,24,26,0.8)] transition hover:border-[rgba(24,24,26,0.4)]">
                        编辑
                      </button>
                      {confirmDeleteId === item.id ? (
                        <span className="flex items-center gap-2 text-[12.5px] text-[rgba(24,24,26,0.6)]">
                          确认删除该条 FAQ？
                          <button onClick={() => void deleteItem(item)} className="rounded-[8px] bg-[#a32d2d] px-2.5 py-1 text-white">
                            确认
                          </button>
                          <button onClick={() => setConfirmDeleteId(null)} className="text-[rgba(24,24,26,0.4)]">
                            取消
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(item.id)} className="flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[12.5px] text-[rgba(24,24,26,0.4)] transition hover:text-[#a32d2d]">
                          <IconTrash className="h-3.5 w-3.5" />
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {drawer && (
        <>
          <div className="fixed inset-0 z-40 bg-[rgba(24,24,26,0.28)] transition-opacity" onClick={closeDrawer} />
          <aside className="fixed right-0 top-0 bottom-0 z-50 flex w-[480px] max-w-[92vw] flex-col border-l border-[rgba(24,24,26,0.14)] bg-[#fbfbfa]">
            <div className="flex items-baseline justify-between border-b border-[rgba(24,24,26,0.14)] px-8 pb-4 pt-6">
              <h3 className="font-serif text-[20px] font-semibold text-[#18181a]">{drawer.editItemId ? '编辑 FAQ' : '沉淀为 FAQ'}</h3>
              <span className="text-[12px] text-[rgba(24,24,26,0.4)]">来源 · {faqSectionLabel(drawer.source)}</span>
            </div>
            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="mb-6">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[rgba(24,24,26,0.4)]">用户问法</label>
                <input
                  value={drawer.question}
                  onChange={(e) => setDrawer({ ...drawer, question: e.target.value })}
                  className="w-full rounded-xl border border-[rgba(24,24,26,0.14)] bg-white px-3.5 py-2.5 text-[13.5px] outline-none transition focus:border-[#0f766e]"
                  placeholder="对话按这里的问题匹配，可改写成更常见的说法"
                />
              </div>
              <div className="mb-6">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[rgba(24,24,26,0.4)]">标准答案</label>
                <textarea
                  value={drawer.answer}
                  onChange={(e) => setDrawer({ ...drawer, answer: e.target.value })}
                  className="min-h-[150px] w-full resize-y rounded-xl border border-[rgba(24,24,26,0.14)] bg-white px-3.5 py-2.5 text-[13.5px] leading-relaxed outline-none transition focus:border-[#0f766e]"
                  placeholder="写下希望员工直接引用的答案……"
                />
              </div>
              <div className="mb-6">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[rgba(24,24,26,0.4)]">
                  触发关键词 <span className="tracking-normal text-[#0f766e]">· ≥2 个同时命中才回答</span>
                </label>
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[rgba(24,24,26,0.14)] bg-white p-2.5">
                  {drawer.keywords.map((kw) => (
                    <span key={kw} className="flex items-center gap-1.5 rounded-full bg-[rgba(24,24,26,0.04)] px-3 py-1 text-[12px] text-[rgba(24,24,26,0.6)]">
                      {kw}
                      <button onClick={() => removeKeyword(kw)} className="text-[13px] leading-none text-[rgba(24,24,26,0.4)] hover:text-[#a32d2d]">
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
                  <div className="mt-2 text-[12px] leading-relaxed text-[rgba(24,24,26,0.4)]">
                    建议词：{drawer.suggested.filter((k) => !drawer.keywords.includes(k)).slice(0, 8).join('、') || '已全部加入'}
                  </div>
                )}
              </div>
              <div className="mb-2">
                <label className="mb-2 block text-[12px] tracking-[0.08em] text-[rgba(24,24,26,0.4)]">回答预览</label>
                <div className="rounded-xl border border-[rgba(24,24,26,0.08)] bg-white px-4 py-3.5 text-[13px] text-[rgba(24,24,26,0.8)]">
                  {drawer.answer
                    ? drawer.answer.split('\n').map((line, idx) => <p key={idx} className="min-h-[1.4em]">{line}</p>)
                    : '（答案为空）'}
                  <div className="mt-2.5 rounded-lg border border-[rgba(24,24,26,0.14)] px-3 py-2 text-[12px] text-[rgba(24,24,26,0.4)]">
                    回答末尾将自动附加「来自员工 FAQ」提示
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 border-t border-[rgba(24,24,26,0.14)] px-8 py-5">
              <span className="mr-auto text-[12px] text-[rgba(24,24,26,0.4)]">{drawer.editItemId ? '保存后立即生效' : '采纳后立即对用户生效'}</span>
              <button onClick={closeDrawer} className="rounded-[10px] border border-[rgba(24,24,26,0.14)] bg-white px-4 py-2 text-[12.5px] text-[rgba(24,24,26,0.8)]">
                取消
              </button>
              <button onClick={() => void adopt()} disabled={saving} className="rounded-[10px] border border-[#18181a] bg-[#18181a] px-4 py-2 text-[12.5px] text-white transition hover:bg-black disabled:opacity-60">
                {saving ? '保存中…' : drawer.editItemId ? '保存修改' : '确认采纳'}
              </button>
            </div>
          </aside>
        </>
      )}

      {!canManage && (
        <div className="mt-8 rounded-xl border border-[rgba(24,24,26,0.14)] bg-white px-5 py-4 text-[13px] text-[rgba(24,24,26,0.6)]">
          当前账号对该员工没有管理权限（仅员工创建人或租户管理员可以编辑 FAQ）。
        </div>
      )}
    </div>
  );
}
