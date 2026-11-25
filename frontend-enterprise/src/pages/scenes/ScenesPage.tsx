import { useCallback, useEffect, useMemo, useState } from 'react';
import IconRefresh from '../../assets/icons/refresh.svg?react';
import IconMore from '../../assets/icons/more.svg?react';
import IconTrash from '../../assets/icons/trash.svg?react';
import IconEdit from '../../assets/icons/edit.svg?react';
import { isEnterpriseAdmin, type EnterpriseAuthUser } from '../../auth';
import { api, TENANT_ID } from '@/api/client';
import type { AgentProfileRead } from '@/types';
import { notify } from '@/components/ui/app-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';
import SceneEditor from './SceneEditor';
import {
  deleteScene,
  listScenes,
  listSceneTables,
  type SceneRead,
  type SceneTableRead,
} from '../../api/scenes';
import { bindingText, statusMeta } from './sceneUtils';

/**
 * 场景列表页。
 *
 * 两层用途共用一份数据：
 * - 独立页（`/enterprise/scenes`）：管理租户下所有场景；
 * - 员工档案页的「场景」tab（`embedded` + `agentId`）：只看这个员工的。
 *
 * 刻意不做成两套组件 —— 只是查询条件不同，UI 结构完全一样，
 * 拆开写必然漂（一个页面的操作列有了新按钮，另一个还停在旧样子）。
 */
export default function ScenesPage({
  currentUser,
  agentId,
  embedded = false,
  onLogout,
}: {
  currentUser?: EnterpriseAuthUser;
  /** 给定时只看这个员工的场景；不给则看租户全部 */
  agentId?: string;
  embedded?: boolean;
  onLogout?: () => void;
} = {}) {
  const [scenes, setScenes] = useState<SceneRead[]>([]);
  const [tables, setTables] = useState<SceneTableRead[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SceneRead | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isAdmin = Boolean(currentUser && isEnterpriseAdmin(currentUser));
  // 绑定到我的员工的场景，创建人也能改；管理员全放行。这里只做**入口显隐**，
  // 真正的判权在后端 —— 前端藏起来只是为了不让用户点了才 403。
  const canManage = isAdmin || Boolean(agentId);

  // id → 名字。「绑定员工」列和后端一样只存 id，直接用 id 渲染的话
  // 用户看到的是一串 agent_xxx，既认不出是谁也点不进去。
  // 拉失败就退化成空映射（列里显示 id），不能因此让整页报错。
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    api
      .get<AgentProfileRead[]>(`/api/enterprise/agents?tenant_id=${TENANT_ID}`)
      .then((rows) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        (Array.isArray(rows) ? rows : []).forEach((agent) => {
          if (agent?.id) map[agent.id] = agent.name || agent.id;
        });
        setAgentNames(map);
      })
      .catch(() => {
        // 静默：只影响这一列的可读性
        if (alive) setAgentNames({});
      });
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sceneRows, tableRows] = await Promise.all([
        listScenes(agentId ? { agent_id: agentId } : {}),
        listSceneTables(),
      ]);
      setScenes(sceneRows);
      setTables(tableRows);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '加载场景失败');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tableNames = useMemo(
    () => Object.fromEntries(tables.map((table) => [table.id, table.name])),
    [tables],
  );

  const openCreate = () => {
    if (tables.length === 0) {
      notify.error('先导入一张数据表，场景需要挂在表上');
      return;
    }
    setCreating(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteScene(deleteTarget.id);
      notify.success('场景已删除');
      setDeleteTarget(null);
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  const columns: DataTableColumn<SceneRead>[] = [
    {
      key: 'name',
      title: '场景',
      className: 'whitespace-normal',
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-[3px] py-[6px]">
          <span className="flex items-center gap-[6px] font-medium leading-[20px] text-[#18181a]">
            {row.icon ? <span aria-hidden>{row.icon}</span> : null}
            <span className="line-clamp-1" title={row.name}>
              {row.name}
            </span>
          </span>
          <span className="line-clamp-1 text-[12px] text-[#6d6d72]" title={row.description}>
            {row.description || '未填写场景描述'}
          </span>
        </div>
      ),
    },
    {
      key: 'table',
      title: '数据表',
      width: 180,
      render: (row) => (
        <span className="line-clamp-1 text-[12.5px] text-[#6d6d72]">
          {tableNames[row.table_id] ?? '表已删除'}
        </span>
      ),
    },
    {
      key: 'slots',
      title: '槽位',
      width: 150,
      render: (row) => (
        <span className="text-[12px] text-[#6d6d72]">
          {row.slots.length > 0 ? row.slots.map((s) => s.label || s.key).join(' / ') : '未配置'}
        </span>
      ),
    },
    {
      key: 'binding',
      title: '绑定员工',
      width: 200,
      render: (row) => (
<span
            className="line-clamp-1 text-[12px] text-[#6d6d72]"
            title={row.agent_ids.map((id) => agentNames[id] ?? id).join('、')}
          >
            {bindingText(row.agent_ids, agentNames)}
          </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 92,
      render: (row) => {
        const meta = statusMeta(row.status);
        return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>;
      },
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            title: '操作',
            width: 96,
            align: 'right' as const,
            render: (row: SceneRead) => (
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="场景操作"
                  className="ml-auto grid size-7 place-items-center rounded-[8px] text-[#6d6d72] transition-colors outline-none hover:bg-black/5 hover:text-[#18181a]"
                >
                  <IconMore className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[140px] rounded-[12px] p-1">
                  <DropdownMenuItem
                    className="gap-[8px] rounded-[8px] px-[10px] py-[7px] text-[13px]"
                    onSelect={() => setEditorId(row.id)}
                  >
                    <IconEdit />
                    编辑
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="gap-[8px] rounded-[8px] px-[10px] py-[7px] text-[13px]"
                    onSelect={() => setDeleteTarget(row)}
                  >
                    <IconTrash />
                    删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]
      : []),
  ];

  const body = (
    <>
      <section>
        <div className="mb-[14px] flex flex-wrap items-center gap-[12px] text-[#6d6d72]">
          <span className="text-[14px] leading-none">场景</span>
          <span className="text-[12px] text-[#9a9a9f]">
            绑一张数据表，配好「问用户什么」→「命中后怎么答」，员工对话里就能按条件查表推荐
          </span>
          <div className="ml-auto flex items-center gap-[8px]">
            <button
              onClick={() => void load()}
              className="flex items-center gap-[5px] rounded-[8px] px-[8px] py-[5px] text-[12.5px] text-[#6d6d72] transition-colors hover:bg-black/5 hover:text-[#18181a]"
            >
              <IconRefresh className="size-3.5" />
              刷新
            </button>
            {canManage && (
              <button
                onClick={openCreate}
                className="flex items-center gap-[5px] rounded-[8px] border border-[rgba(24,24,26,0.14)] bg-white px-[10px] py-[5px] text-[12.5px] text-[#18181a] transition-colors hover:border-[rgba(24,24,26,0.3)]"
              >
                ＋ 新建场景
              </button>
            )}
          </div>
        </div>
        <DataTable
          aria-label="场景列表"
          columns={columns}
          data={scenes}
          rowKey={(row) => row.id}
          loading={loading}
          emptyText={
            tables.length === 0
              ? '还没有可用的数据表。场景要挂在 excel/csv 上，先导入一张表。'
              : canManage
                ? '还没有场景，点右上角「新建场景」开始配置。'
                : '这个员工还没有配置场景。'
          }
        />
      </section>

      {(creating || editorId) && (
        <SceneEditor
          sceneId={editorId}
          defaultAgentId={agentId}
          tables={tables}
          onClose={() => {
            setCreating(false);
            setEditorId(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditorId(null);
            await load();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={<>删除场景「{deleteTarget?.name}」？</>}
        description="场景删除后会同时从所有员工身上解绑，历史对话日志保留。此操作不可撤销。"
        confirmText="删除"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );

  if (embedded) {
    return (
      <div className="min-h-0" aria-busy={loading}>
        {body}
      </div>
    );
  }

  return (
    <div
      className="min-h-full box-border px-[48px] pt-[32px] pb-[43px] max-[900px]:px-[16px]"
      aria-busy={loading}
    >
      <header className="mb-[28px] flex items-center justify-between gap-[16px]">
        <div>
          <h1 className="m-0 text-[22px] leading-none font-semibold text-[#18181a]">场景</h1>
          <p className="mt-[8px] mb-0 text-[13px] leading-[20px] text-[#6d6d72]">
            用 excel/csv 做条件筛选式的问答与推荐。场景建好后绑定到员工，员工对话里即可触发。
          </p>
        </div>
      </header>
      {body}
    </div>
  );
}

export { ScenesPage };