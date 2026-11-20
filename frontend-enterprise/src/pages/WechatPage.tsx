import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { api, TENANT_ID } from '../api/client';
import type { EnterpriseAuthUser } from '../auth';
import { notify } from '@/components/ui/app-toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { AgentProfileRead } from '../types';

/** 与后端 app/api/wechat.py 的响应模型一一对应。 */
interface MountedAgent {
  agent_id: string;
  name: string;
  is_default: boolean;
  sort_order: number;
}

interface WechatBindingRead {
  id: string;
  status: string;
  display_name: string;
  ilink_bot_id: string;
  agents: MountedAgent[];
  last_error: string;
  last_seen_at: string | null;
  created_at: string | null;
  /** 这条绑定是不是我自己扫的：管理员能看到别人的，但不该能替人断开。 */
  owned_by_me?: boolean;
}

interface QrcodeResponse {
  qrcode: string;
  qrcode_url: string;
  expires_in: number;
}

interface QrcodeStatusResponse {
  status: string;
  binding_id: string | null;
  display_name: string;
  message: string;
}

type Props = {
  currentUser: EnterpriseAuthUser | null;
  onLogout?: () => void;
};

const Q = `tenant_id=${encodeURIComponent(TENANT_ID)}`;

/**
 * 员工的模型规则，决定「挂到微信后还能不能真的问」。
 *
 * 为什么要在勾选列表里显式标注：微信渠道没有模型选择器，用户在站内习惯了
 * 「点进对话再选模型」，切到微信后就完全看不到这一层。等发消息收到
 * 「需要先配置模型」才知道，体验上像坏了。所以在这里提前把账算清。
 *
 * 三态与后端 app/agents/model_policy.py 的判定一一对应：
 *   free        —— 免费员工：无自有模型也能用，但受每日次数限制
 *   exhausted   —— 免费员工但今日额度已用完（扣到 0），要提示明天或自配模型
 *   byo         —— 非免费员工：必须自己配模型，否则发消息会被拒绝
 */
type ModelRule = { kind: 'free' | 'exhausted' | 'byo'; remaining: number | null };

function modelRuleOf(agent: AgentProfileRead): ModelRule {
  // free_model_remaining 只在「免费员工」且已计算时才有值（后端 agent_read 里
  // 非免费一律置 None），所以「有值 ⇒ 免费」这个推断是可靠的。
  const remaining = typeof agent.free_model_remaining === 'number' ? agent.free_model_remaining : null;
  if (agent.free_model_enabled === true) {
    return { kind: remaining === 0 ? 'exhausted' : 'free', remaining };
  }
  return { kind: 'byo', remaining: null };
}

function ModelPolicyBadge({ agent }: { agent: AgentProfileRead }) {
  const rule = modelRuleOf(agent);
  if (rule.kind === 'byo') {
    return (
      <span className="shrink-0 rounded-full bg-[#f2f1ee] px-[8px] py-[1px] text-[11px] text-[#6b6b6f]">
        需自配模型
      </span>
    );
  }
  if (rule.kind === 'exhausted') {
    return (
      <span className="shrink-0 rounded-full bg-[#fdecea] px-[8px] py-[1px] text-[11px] text-[#b4483c]">
        今日已用完
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-[#e6f4ef] px-[8px] py-[1px] text-[11px] text-[#0f766e]">
      免费{rule.remaining !== null ? ` · 剩 ${rule.remaining} 问` : ''}
    </span>
  );
}

function ModelPolicyHint({ agent }: { agent: AgentProfileRead }) {
  const rule = modelRuleOf(agent);
  if (rule.kind === 'free') return null;
  const text =
    rule.kind === 'exhausted'
      ? '今日免费次数已用完，明天恢复；或先在「模型配置」里添加自己的模型。'
      : '该员工不提供免费模型，需要你先在「模型配置」里添加自己的模型，才能在微信里对话。';
  return <span className="mt-[2px] block text-[11px] leading-[1.4] text-[#8a8a8f]">{text}</span>;
}

const STATUS_LABEL: Record<string, string> = {
  active: '已接入',
  pending: '待确认',
  disconnected: '已断开',
};

/**
 * 微信接入管理页。
 *
 * 信息层级按「每个人接自己的微信、各自选员工」来组织：先看接入状态，再配这个
 * 微信能对话哪些员工（挂载集 = 微信里 /员工 列表的来源）。
 *
 * 身份绑定只有扫码一个入口：iLink 扫码返回的 ilink_user_id 就是扫码人本人，
 * 而这个 bot 只有他自己的微信能登录，所以扫码即完成，页面不需要额外步骤。
 */
export default function WechatPage({ currentUser }: Props) {

  const [bindings, setBindings] = useState<WechatBindingRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentProfileRead[]>([]);

  // 扫码弹窗状态
  const [qrOpen, setQrOpen] = useState(false);
  const [qrData, setQrData] = useState<QrcodeResponse | null>(null);
  const [qrImage, setQrImage] = useState('');
  const [qrStatus, setQrStatus] = useState('');
  const [qrError, setQrError] = useState('');
  const pollTimer = useRef<number | null>(null);

  // 员工挂载编辑
  const [editingBinding, setEditingBinding] = useState<WechatBindingRead | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [defaultAgent, setDefaultAgent] = useState('');
  const [savingAgents, setSavingAgents] = useState(false);

  // 断开确认
  const [disconnectTarget, setDisconnectTarget] = useState<WechatBindingRead | null>(null);
  // 删除确认（只对已断开的记录开放）
  const [deleteTarget, setDeleteTarget] = useState<WechatBindingRead | null>(null);

  const load = useCallback(async () => {
    try {
      const [rows, agentRows] = await Promise.all([
        api.get<WechatBindingRead[]>(`/api/enterprise/wechat/bindings?${Q}`),
        api.get<AgentProfileRead[]>(`/api/enterprise/agents?${Q}`).catch(() => []),
      ]);
      setBindings(rows);
      setAgents(agentRows);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载微信接入失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- 扫码接入 ----------------------------------------------------

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startQrcode = useCallback(async () => {
    setQrError('');
    setQrStatus('正在获取二维码…');
    setQrImage('');
    try {
      const data = await api.post<QrcodeResponse>(`/api/enterprise/wechat/qrcode?${Q}`);
      setQrData(data);
      // 二维码内容是 qrcode_url，用 qrcode 库在前端渲染，不依赖后端出图
      const dataUrl = await QRCode.toDataURL(data.qrcode_url || data.qrcode, {
        width: 260,
        margin: 1,
        color: { dark: '#1a1a1a', light: '#ffffff' },
      });
      setQrImage(dataUrl);
      setQrStatus('请使用微信扫描二维码完成接入');
    } catch (error) {
      setQrError(error instanceof Error ? error.message : '获取二维码失败');
      setQrStatus('');
    }
  }, []);

  useEffect(() => {
    if (!qrOpen) {
      stopPolling();
      return;
    }
    void startQrcode();
    return () => stopPolling();
  }, [qrOpen, startQrcode, stopPolling]);

  useEffect(() => {
    if (!qrOpen || !qrData?.qrcode) return;
    stopPolling();

    // 两个闸门解决「N 个成功提醒」：setInterval 不会等待 async 回调完成，
    // 一旦某次请求超过 2.5s 就会叠加多个并发轮询，每个都拿到 confirmed 各弹一次 toast。
    //   inFlight  —— 同一时间只允许一个在途请求
    //   settled   —— 一旦确认接入就永久停手（含组件已卸载的情况）
    let inFlight = false;
    let settled = false;

    const tick = async () => {
      if (inFlight || settled) return;
      inFlight = true;
      try {
        const res = await api.get<QrcodeStatusResponse>(
          `/api/enterprise/wechat/qrcode/status?${Q}&qrcode=${encodeURIComponent(qrData.qrcode)}`,
        );
        if (settled) return;
        if (res.status === 'scaned') {
          setQrStatus('已扫码，请在微信中确认');
        } else if (res.status === 'expired') {
          settled = true;
          stopPolling();
          setQrStatus('二维码已过期，请重新获取');
        } else if (res.status === 'confirmed') {
          settled = true;
          stopPolling();
          setQrStatus(res.message || '微信接入成功');
          notify.success(res.message || '微信接入成功');
          setQrOpen(false);
          void load();
        }
      } catch {
        // 单次轮询失败不打断整体流程，等下一次
      } finally {
        inFlight = false;
      }
    };

    void tick();
    pollTimer.current = window.setInterval(() => void tick(), 2500);
    return () => {
      settled = true;
      stopPolling();
    };
  }, [qrOpen, qrData, load, stopPolling]);

  // ---- 员工挂载 ----------------------------------------------------

  const openAgentEditor = (binding: WechatBindingRead) => {
    setEditingBinding(binding);
    setSelectedAgents(binding.agents.map((a) => a.agent_id));
    setDefaultAgent(binding.agents.find((a) => a.is_default)?.agent_id ?? '');
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) => {
      if (prev.includes(agentId)) {
        const next = prev.filter((id) => id !== agentId);
        // 取消默认员工时要顺手清空默认，避免提交非法组合
        if (defaultAgent === agentId) setDefaultAgent(next[0] ?? '');
        return next;
      }
      return [...prev, agentId];
    });
  };

  const saveAgents = async () => {
    if (!editingBinding) return;
    setSavingAgents(true);
    try {
      await api.put(`/api/enterprise/wechat/bindings/${editingBinding.id}/agents?${Q}`, {
        agent_ids: selectedAgents,
        default_agent_id: defaultAgent || selectedAgents[0] || null,
      });
      notify.success('员工配置已保存');
      setEditingBinding(null);
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSavingAgents(false);
    }
  };

  // ---- 断开 --------------------------------------------------------

  const confirmDisconnect = async () => {
    if (!disconnectTarget) return;
    try {
      await api.post(
        `/api/enterprise/wechat/bindings/${disconnectTarget.id}/disconnect?${Q}`,
      );
      notify.success('已断开微信接入');
      setDisconnectTarget(null);
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '断开失败');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/api/enterprise/wechat/bindings/${deleteTarget.id}?${Q}`);
      notify.success('已删除这条接入记录');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  // ---- 渲染 --------------------------------------------------------

  // 「整体智能体」是租户级兜底入口（is_overall），不是一个具体员工：
  // 它没有独立人设，挂到微信里只会让 /员工 列表出现一个语义不明的选项，
  // 所以候选集里排除掉。
  const selectableAgents = agents.filter((agent) => !agent.is_overall);

  // 一次只允许接入一个微信：只要已有生效中的绑定，「扫码接入」就灰掉。
  // 后端 /qrcode 有同样的拦截（409），这里置灰是为了让规则在点击之前可见。
  const activeBinding = bindings.find((row) => row.status === 'active');
  const scanLocked = activeBinding !== undefined;

  const card =
    'rounded-[20px] border border-[#e8e6e1] bg-white p-[24px] shadow-[0_1px_2px_rgba(26,26,26,0.04)]';

  return (
    <div className="mx-auto w-full max-w-[1040px] px-[32px] py-[28px]">
      <header className="mb-[24px]">
        <h1 className="text-[26px] font-semibold tracking-tight text-[#1a1a1a]">微信接入</h1>
        <p className="mt-[6px] text-[14px] text-[#6b6b6f]">
          扫码把你的微信接成数字员工入口，再选定你想在微信里对话的员工。
        </p>
      </header>

      {/* 接入状态 */}
      <section className={card}>
        <div className="flex items-start justify-between gap-[16px]">
          <div>
            <h2 className="text-[16px] font-medium text-[#1a1a1a]">我的微信</h2>
            <p className="mt-[4px] text-[13px] text-[#6b6b6f]">
              每个微信只管自己的对话：你在微信里 /员工 看到的就是你名下有权限的员工。
            </p>
            {scanLocked && (
              <p className="mt-[4px] text-[12px] text-[#8a8a8f]">
                一个账号只能接入一个微信。要换绑请先断开当前接入。
              </p>
            )}
          </div>
          <Button
            onClick={() => setQrOpen(true)}
            disabled={scanLocked}
            title={scanLocked ? '已接入微信，请先断开后再换绑' : undefined}
            className="shrink-0"
          >
            扫码接入
          </Button>
        </div>

        <div className="mt-[20px] flex flex-col gap-[12px]">
          {loading && <div className="text-[13px] text-[#8a8a8f]">加载中…</div>}
          {!loading && bindings.length === 0 && (
            <div className="rounded-[14px] border border-dashed border-[#e0ded9] px-[20px] py-[28px] text-center text-[13px] text-[#8a8a8f]">
              还没有接入微信。扫码后就能在微信里和你的数字员工对话。
            </div>
          )}
          {bindings.map((binding) => (
            <div
              key={binding.id}
              className="rounded-[14px] border border-[#eeece7] bg-[#fcfcfb] px-[18px] py-[16px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-[12px]">
                <div className="flex items-center gap-[10px]">
                  <span
                    className={`inline-flex items-center rounded-full px-[10px] py-[3px] text-[12px] font-medium ${
                      binding.status === 'active'
                        ? 'bg-[#e6f4ef] text-[#0f766e]'
                        : binding.status === 'pending'
                          ? 'bg-[#fdf3e0] text-[#a06a1a]'
                          : 'bg-[#f2f1ee] text-[#6b6b6f]'
                    }`}
                  >
                    {STATUS_LABEL[binding.status] ?? binding.status}
                  </span>
                  <span className="text-[14px] font-medium text-[#1a1a1a]">
                    {binding.display_name || binding.ilink_bot_id || '微信 bot'}
                  </span>
                </div>
                <div className="flex items-center gap-[8px]">
                    <Button variant="outline" size="sm" onClick={() => openAgentEditor(binding)}>
                      配置员工
                    </Button>
                    {/* 断开：只在生效中显示；不是自己的绑定不给操作 */}
                    {binding.status === 'active' && binding.owned_by_me !== false && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDisconnectTarget(binding)}
                      >
                        断开
                      </Button>
                    )}
                    {/* 删除：只有断开之后才允许，避免「删了但还在跑」的悬空 bot */}
                    {binding.status === 'disconnected' && binding.owned_by_me !== false && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-[#b4483c]"
                        onClick={() => setDeleteTarget(binding)}
                      >
                        删除
                      </Button>
                    )}
                  </div>
              </div>

              <div className="mt-[12px] flex flex-wrap items-center gap-[6px]">
                <span className="text-[12px] text-[#8a8a8f]">可对话员工：</span>
                {binding.agents.length === 0 && (
                  <span className="text-[12px] text-[#b0aeA8]">未配置（默认使用你有权限的全部员工）</span>
                )}
                {binding.agents.map((agent) => (
                  <span
                    key={agent.agent_id}
                    className={`rounded-full px-[10px] py-[2px] text-[12px] ${
                      agent.is_default
                        ? 'bg-[#0f766e] text-white'
                        : 'bg-[#f2f1ee] text-[#4a4a4d]'
                    }`}
                  >
                    {agent.name}
                    {agent.is_default ? ' · 默认' : ''}
                  </span>
                ))}
              </div>

              {binding.last_error && (
                <div className="mt-[10px] text-[12px] text-[#b4483c]">
                  最近错误：{binding.last_error}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 微信侧指令说明 */}
      <section className={`${card} mt-[16px]`}>
        <h2 className="text-[16px] font-medium text-[#1a1a1a]">微信里的指令</h2>
        <p className="mt-[4px] text-[13px] text-[#6b6b6f]">
          切换员工后，上一条对话的内容不会带给新员工；切回原员工可继续之前的上下文。
        </p>
        <div className="mt-[16px] grid gap-[10px] sm:grid-cols-2">
          {[
            ['/员工', '查看可对话员工，回复数字直接切换'],
            ['/切换 <名字>', '切换到指定员工'],
            ['/当前', '查看当前正在对话的员工'],
            ['/转人工', '找真人同事接手，回复会回到这个微信对话'],
            ['/取消转人工', '结束人工，继续由数字员工服务'],
          ].map(([cmd, desc]) => (
            <div
              key={cmd}
              className="flex items-start gap-[10px] rounded-[12px] border border-[#eeece7] bg-[#fcfcfb] px-[14px] py-[12px]"
            >
              <code className="shrink-0 rounded-[6px] bg-[#f2f1ee] px-[8px] py-[2px] text-[12px] text-[#0f766e]">
                {cmd}
              </code>
              <span className="text-[13px] text-[#4a4a4d]">{desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 扫码弹窗 */}
      {qrOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[24px]">
          <div className="w-full max-w-[380px] rounded-[20px] bg-white p-[28px] shadow-xl">
            <h3 className="text-[17px] font-semibold text-[#1a1a1a]">微信接入</h3>
            <div className="mt-[20px] flex flex-col items-center">
              <div className="flex h-[260px] w-[260px] items-center justify-center rounded-[14px] border border-[#eeece7] bg-white">
                {qrImage ? (
                  <img src={qrImage} alt="微信接入二维码" className="h-[244px] w-[244px]" />
                ) : (
                  <span className="text-[13px] text-[#8a8a8f]">加载中…</span>
                )}
              </div>
              <p className="mt-[14px] text-center text-[13px] text-[#4a4a4d]">{qrStatus}</p>
              {qrError && (
                <p className="mt-[6px] text-center text-[13px] text-[#b4483c]">{qrError}</p>
              )}
            </div>
            <div className="mt-[20px] flex justify-end gap-[8px]">
              <Button variant="outline" onClick={() => setQrOpen(false)}>
                关闭
              </Button>
              <Button onClick={() => void startQrcode()}>重新获取二维码</Button>
            </div>
          </div>
        </div>
      )}

      {/* 员工挂载弹窗 */}
      {editingBinding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[24px]">
          <div className="w-full max-w-[460px] rounded-[20px] bg-white p-[28px] shadow-xl">
            <h3 className="text-[17px] font-semibold text-[#1a1a1a]">配置可对话员工</h3>
            <p className="mt-[6px] text-[13px] text-[#6b6b6f]">
              勾选的员工会出现在你微信的 /员工 列表里，回复数字即可切换。不勾选则默认使用你有权限的全部员工。
            </p>
            <p className="mt-[8px] rounded-[10px] bg-[#fcfcfb] px-[12px] py-[8px] text-[12px] leading-[1.5] text-[#6b6b6f]">
              微信里没有选模型的地方，所以模型规则按员工来：标「免费」的员工没有自己的模型也能问，
              但每人每天有次数上限；标「需自配模型」的员工要你先在「模型配置」里添加模型才能对话。
            </p>

            <div className="mt-[18px] max-h-[320px] overflow-y-auto">
              {selectableAgents.length === 0 && (
                <div className="text-[13px] text-[#8a8a8f]">暂无可选员工</div>
              )}
              {selectableAgents.map((agent) => {
                const checked = selectedAgents.includes(agent.id);
                return (
                  <label
                    key={agent.id}
                    className="flex cursor-pointer items-center justify-between gap-[12px] rounded-[10px] px-[12px] py-[10px] hover:bg-[#f7f6f3]"
                  >
                    <span className="flex min-w-0 items-center gap-[10px]">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleAgent(agent.id)}
                        className="size-[16px] accent-[#0f766e]"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-[8px]">
                          <span className="truncate text-[14px] text-[#1a1a1a]">{agent.name}</span>
                          <ModelPolicyBadge agent={agent} />
                        </span>
                        <ModelPolicyHint agent={agent} />
                      </span>
                    </span>
                    {checked && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          setDefaultAgent(agent.id);
                        }}
                        className={`rounded-full px-[10px] py-[2px] text-[12px] ${
                          defaultAgent === agent.id
                            ? 'bg-[#0f766e] text-white'
                            : 'bg-[#f2f1ee] text-[#6b6b6f]'
                        }`}
                      >
                        {defaultAgent === agent.id ? '默认' : '设为默认'}
                      </button>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-[20px] flex justify-end gap-[8px]">
              <Button variant="outline" onClick={() => setEditingBinding(null)}>
                取消
              </Button>
              <Button onClick={() => void saveAgents()} disabled={savingAgents}>
                {savingAgents ? '保存中…' : '保存'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
        title="断开微信接入？"
        description="断开后微信 bot 将离线，需要重新扫码才能恢复；对话记录保留。确定断开接入吗？"
        confirmText="确认断开"
        onConfirm={() => void confirmDisconnect()}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除这条接入记录？"
        description="删除后这条接入与员工配置会一并移除，历史对话保留。之后可以重新扫码接入。"
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}