import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileSpreadsheet,
  LoaderCircle,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';

import { api, TENANT_ID } from '@/api/client';
import { notify } from '@/components/ui/app-toast';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';
import { cn } from '@/lib/utils';

/** 后端 `FaqImportItem` 的响应体（预览条目 + 元信息）。 */
export type FaqImportItem = {
  question: string;
  answer: string;
  keywords: string[];
  rows: number[];
  note: string;
  warning: string;
};

export type FaqImportJob = {
  job_id: string;
  filename: string;
  status: 'queued' | 'parsing' | 'succeeded' | 'failed';
  stage: string;
  stage_text?: string;
  progress: number;
  error?: string | null;
  warnings: string[];
  items: FaqImportItem[];
  sheet_name: string;
  rows_total: number;
  rows_used: number;
  truncated: boolean;
  model_name?: string | null;
};

const POLL_INTERVAL_MS = 1200;
const MAX_FILE_MB = 10;

/** 预览行的稳定 key：同问题在去重后唯一，但允许用户改问题，所以用下标。 */
type Row = FaqImportItem & { key: string };

type Filter = 'all' | 'ready' | 'attention';

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部',
  ready: '可用',
  attention: '需核对',
};

function hasIssue(row: FaqImportItem): boolean {
  return Boolean(row.warning) || row.keywords.length < 2;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

type Props = {
  open: boolean;
  agentId: string;
  onClose: () => void;
  onSaved: (count: number) => void;
};

/**
 * FAQ 批量导入：上传 Excel → 后台模型匹配 QA 对 → 预览勾选 → 保存。
 *
 * 两段式（不是上传即入库）是刻意的：模型归并的结果一定有人要改，
 * 直接落库等于让用户事后逐条删。
 */
export function FaqImportDialog({ open, agentId, onClose, onSaved }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<FaqImportJob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    abortRef.current?.abort();
    abortRef.current = null;
    setFile(null);
    setJob(null);
    setRows([]);
    setSelected(new Set());
    setFilter('all');
    setQuery('');
    setExpanded(null);
    setUploading(false);
    setSaving(false);
  }, [stopPolling]);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    return () => stopPolling();
  }, [open, reset, stopPolling]);

  const applyJob = useCallback((payload: FaqImportJob) => {
    setJob(payload);
    if (payload.status !== 'succeeded') return;
    const next: Row[] = payload.items.map((item, index) => ({ ...item, key: `r${index}` }));
    setRows(next);
    // 默认全选「可用」条目；需核对的让用户自己决定，别替他做主。
    setSelected(new Set(next.filter((row) => !hasIssue(row)).map((row) => row.key)));
  }, []);

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const payload = await api.get<FaqImportJob>(
          `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/import:jobs/${encodeURIComponent(jobId)}?tenant_id=${TENANT_ID}`,
        );
        applyJob(payload);
        if (payload.status === 'succeeded' || payload.status === 'failed') {
          stopPolling();
          if (payload.status === 'failed') {
            notify.error(payload.error || '解析失败');
          }
        }
      } catch (error) {
        stopPolling();
        setUploading(false);
        notify.error(error instanceof Error ? error.message : '读取解析结果失败');
      }
    },
    [agentId, applyJob, stopPolling],
  );

  const startUpload = useCallback(
    async (target: File) => {
      if (!agentId) {
        notify.error('请先选择一个员工');
        return;
      }
      const lower = target.name.toLowerCase();
      if (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
        notify.error('目前只支持 .xlsx / .xlsm 表格，老的 .xls 请先另存为 .xlsx');
        return;
      }
      if (target.size > MAX_FILE_MB * 1024 * 1024) {
        notify.error(`文件超过 ${MAX_FILE_MB}MB，请拆分后再导入`);
        return;
      }
      setFile(target);
      setJob(null);
      setRows([]);
      setSelected(new Set());
      setUploading(true);
      stopPolling();
      try {
        const created = await api.uploadWithProgress<{ job_id: string }>(
          `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/import:parse`,
          target,
          `tenant_id=${encodeURIComponent(TENANT_ID)}`,
        );
        await poll(created.job_id);
        pollTimer.current = window.setInterval(() => void poll(created.job_id), POLL_INTERVAL_MS);
      } catch (error) {
        setUploading(false);
        notify.error(error instanceof Error ? error.message : '上传失败');
      }
    },
    [agentId, poll, stopPolling],
  );

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === 'ready' && hasIssue(row)) return false;
      if (filter === 'attention' && !hasIssue(row)) return false;
      if (!keyword) return true;
      return (
        row.question.toLowerCase().includes(keyword) ||
        row.answer.toLowerCase().includes(keyword) ||
        row.keywords.some((kw) => kw.toLowerCase().includes(keyword))
      );
    });
  }, [filter, query, rows]);

  const filteredKeys = filtered.map((row) => row.key);
  const allFilteredSelected = filteredKeys.length > 0 && filteredKeys.every((key) => selected.has(key));
  const someFilteredSelected = filteredKeys.some((key) => selected.has(key));
  const counts = useMemo(
    () => ({
      ready: rows.filter((row) => !hasIssue(row)).length,
      attention: rows.filter(hasIssue).length,
    }),
    [rows],
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredKeys.forEach((key) => next.delete(key));
      else filteredKeys.forEach((key) => next.add(key));
      return next;
    });
  };

  const toggleRow = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const editing = Boolean(job?.status === 'succeeded' && rows.length > 0);

  const save = async () => {
    const picked = rows.filter((row) => selected.has(row.key));
    if (picked.length === 0) {
      notify.error('请至少勾选一条');
      return;
    }
    const invalid = picked.find((row) => row.keywords.length < 2 || !row.question.trim() || !row.answer.trim());
    if (invalid) {
      setExpanded(invalid.key);
      notify.error(`「${truncate(invalid.question, 16)}」关键词不足 2 个或内容为空，请先补齐`);
      return;
    }
    setSaving(true);
    try {
      const result = await api.post<{ created: number; skipped: number }>(
        `/api/enterprise/agents/${encodeURIComponent(agentId)}/faq/import:items`,
        {
          tenant_id: TENANT_ID,
          items: picked.map((row) => ({
            question: row.question.trim(),
            answer: row.answer,
            keywords: row.keywords,
          })),
        },
      );
      const skipped = result.skipped > 0 ? `，跳过 ${result.skipped} 条重复` : '';
      notify.success(`已导入 ${result.created} 条 FAQ${skipped}`);
      onSaved(result.created);
      onClose();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const stageText =
    job?.status === 'queued'
      ? '排队中'
      : job?.status === 'parsing'
        ? job.stage_text || '模型匹配中'
        : job?.status === 'failed'
          ? '解析失败'
          : '解析完成';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent
        aria-describedby="faq-import-description"
        data-i18n-ignore
        className="flex max-h-[calc(100dvh-2.5rem)] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-[18px] border-0 bg-white p-0 shadow-[0_28px_80px_rgba(24,31,46,0.20)] sm:max-w-[960px]"
      >
        <DialogHeader className="border-b border-[#ecebe7] px-[24px] py-[18px]">
          <div className="flex items-center gap-[12px]">
            <span className="grid size-[36px] shrink-0 place-items-center rounded-[11px] bg-[#18181a] text-white">
              <FileSpreadsheet className="size-[17px]" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-[15px] font-semibold text-[#18181a]">批量导入 FAQ</DialogTitle>
              <DialogDescription id="faq-import-description" className="mt-[4px] text-[12px] text-[#6d6d72]">
                {editing
                  ? '下面是模型整理出的问答对。勾选要保存的条目，保存后可继续在列表里编辑。'
                  : '上传 Excel（含「问题」「答案」两列），模型会自动归并问答对并生成触发关键词。'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* 上传区：只在还没有结果时占位，出结果后整块收起，把空间让给列表 */}
        {!editing && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[24px] py-[22px]">
            <label
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const dropped = event.dataTransfer.files?.[0];
                if (dropped && !uploading) void startUpload(dropped);
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-[10px] rounded-[14px] border border-dashed px-[20px] py-[44px] text-center transition-colors',
                dragging
                  ? 'border-[#18181a] bg-[#f7f6f3]'
                  : 'border-[#d8d5cd] bg-[#fbfbfa] hover:border-[#18181a]/40 hover:bg-[#f7f6f3]',
                uploading && 'pointer-events-none opacity-70',
              )}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xlsm"
                className="hidden"
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  event.target.value = '';
                  if (picked) void startUpload(picked);
                }}
              />
              {uploading ? (
                <>
                  <LoaderCircle className="size-[22px] animate-spin text-[#18181a]" />
                  <span className="text-[13px] text-[#18181a]">
                    {stageText}
                    {job && job.progress > 0 ? ` · ${Math.round(job.progress)}%` : ''}
                  </span>
                  <span className="text-[11.5px] text-[#9a9a9f]">
                    {file?.name}
                    {job?.status === 'parsing' && ' · 模型正在归并问答对，请稍候'}
                  </span>
                </>
              ) : (
                <>
                  <span className="grid size-[40px] place-items-center rounded-full bg-white text-[#18181a] shadow-[0_1px_2px_rgba(24,24,26,0.08)]">
                    <Upload className="size-[18px]" />
                  </span>
                  <span className="text-[13px] text-[#18181a]">
                    {file ? '重新选择文件' : '点击选择或拖拽 Excel 到这里'}
                  </span>
                  <span className="text-[11.5px] leading-[18px] text-[#9a9a9f]">
                    支持 .xlsx / .xlsm，单个文件不超过 {MAX_FILE_MB}MB
                    <br />
                    首行作为表头，最好包含「问题」和「答案」两列
                  </span>
                </>
              )}
            </label>

            {job?.status === 'failed' && (
              <div className="mt-[14px] flex items-start gap-[8px] rounded-[12px] border border-[#f0d8d8] bg-[#fff7f7] px-[14px] py-[11px] text-[12px] leading-[19px] text-[#a32d2d]">
                <AlertTriangle className="mt-[2px] size-[14px] shrink-0" />
                <div className="min-w-0">
                  <strong className="font-medium">解析失败</strong>
                  <p className="mt-[2px] break-words">{job.error || '请检查表格后重试'}</p>
                </div>
              </div>
            )}

            <div className="mt-[16px] rounded-[12px] bg-[#fbfbfa] px-[14px] py-[12px] text-[11.5px] leading-[19px] text-[#6d6d72]">
              <span className="font-medium text-[#3d3d3f]">整理规则</span>
              <ul className="mt-[6px] list-disc space-y-[3px] pl-[16px]">
                <li>答案只取表格里已有的内容，模型不会自行补充事实。</li>
                <li>同一问题散落在多行时会合并成一条，并在预览里标注来源行号。</li>
                <li>每条至少 2 个触发关键词；关键词不足的条目会标为「需核对」。</li>
              </ul>
            </div>
          </div>
        )}

        {editing && (
          <>
            <div className="flex flex-wrap items-center gap-[10px] border-b border-[#f2f1ee] px-[24px] py-[12px]">
              <div className="flex items-center gap-[2px] rounded-[10px] bg-[#f2f1ee] p-[3px]">
                {(Object.keys(FILTER_LABEL) as Filter[]).map((item) => {
                  const count = item === 'all' ? rows.length : item === 'ready' ? counts.ready : counts.attention;
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setFilter(item)}
                      className={cn(
                        'rounded-[8px] px-[10px] py-[4px] text-[12px] transition-colors',
                        filter === item
                          ? 'bg-white text-[#18181a] shadow-[0_1px_2px_rgba(24,24,26,0.08)]'
                          : 'text-[#6d6d72] hover:text-[#18181a]',
                      )}
                    >
                      {FILTER_LABEL[item]}
                      <span className="ml-[4px] text-[11px] text-[#9a9a9f]">{count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="relative min-w-[160px] flex-1">
                <Search className="pointer-events-none absolute left-[10px] top-1/2 size-[13px] -translate-y-1/2 text-[#9a9a9f]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索问题、答案或关键词"
                  className="h-[30px] w-full rounded-[9px] border border-[#e6e4df] bg-white pl-[30px] pr-[10px] text-[12px] text-[#18181a] outline-none transition-colors placeholder:text-[#9a9a9f] focus:border-[#18181a]"
                />
              </div>

              <span className="text-[12px] text-[#6d6d72]">
                已选 <strong className="font-medium text-[#18181a]">{selected.size}</strong> / {rows.length}
              </span>
            </div>

            {(job?.warnings.length ?? 0) > 0 && (
              <div className="flex items-start gap-[8px] border-b border-[#f6e6c8] bg-[#fffaf0] px-[24px] py-[10px] text-[11.5px] leading-[18px] text-[#8a6320]">
                <AlertTriangle className="mt-[2px] size-[13px] shrink-0" />
                <ul className="min-w-0 space-y-[2px]">
                  {job?.warnings.map((warning) => (
                    <li key={warning} className="break-words">{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full table-fixed text-[12px]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-[#f7f6f3] text-left text-[11.5px] text-[#6d6d72]">
                    <th className="w-[40px] px-[8px] py-[8px] pl-[24px]">
                      <Checkbox
                        aria-label="全选当前筛选结果"
                        checked={allFilteredSelected ? true : someFilteredSelected ? 'indeterminate' : false}
                        onCheckedChange={toggleAll}
                      />
                    </th>
                    <th className="px-[8px] py-[8px] font-normal">问题 / 答案</th>
                    <th className="w-[210px] px-[8px] py-[8px] font-normal">触发关键词</th>
                    <th className="w-[92px] px-[8px] py-[8px] pr-[24px] text-right font-normal">来源行</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-[24px] py-[60px] text-center text-[12.5px] text-[#9a9a9f]">
                        {rows.length === 0
                          ? '这张表里没有识别出可用的问答对，请检查表头是否为「问题」「答案」'
                          : '当前筛选没有匹配的条目'}
                      </td>
                    </tr>
                  )}
                  {filtered.map((row) => {
                    const checked = selected.has(row.key);
                    const issue = hasIssue(row);
                    const isOpen = expanded === row.key;
                    return (
                      <tr
                        key={row.key}
                        className={cn(
                          'border-b border-[#f2f1ee] align-top transition-colors',
                          checked ? 'bg-white' : 'bg-[#fcfcfb]',
                          'hover:bg-[#fbfbfa]',
                        )}
                      >
                        <td className="px-[8px] py-[12px] pl-[24px]">
                          <Checkbox
                            aria-label={`选择 ${row.question}`}
                            checked={checked}
                            onCheckedChange={() => toggleRow(row.key)}
                          />
                        </td>
                        <td className="px-[8px] py-[12px]">
                          <div className="flex min-w-0 flex-col gap-[3px]">
                            <span className="line-clamp-2 font-medium leading-[19px] text-[#18181a]" title={row.question}>
                              {row.question}
                            </span>
                            <span
                              className={cn('leading-[18px] text-[#6d6d72]', !isOpen && 'line-clamp-2')}
                              title={isOpen ? undefined : row.answer}
                            >
                              {isOpen ? row.answer : truncate(row.answer, 160)}
                            </span>
                            <div className="mt-[2px] flex flex-wrap items-center gap-[6px]">
                              {row.note && (
                                <span className="inline-flex items-center gap-[4px] rounded-full bg-[#f2f1ee] px-[7px] py-[1px] text-[10.5px] text-[#6d6d72]">
                                  <Sparkles className="size-[10px]" />
                                  {row.note}
                                </span>
                              )}
                              {issue && (
                                <span className="inline-flex items-center gap-[4px] rounded-full bg-[#fff2e5] px-[7px] py-[1px] text-[10.5px] text-[#b45309]">
                                  <AlertTriangle className="size-[10px]" />
                                  {row.warning || '关键词不足 2 个'}
                                </span>
                              )}
                              {(row.answer.length > 160 || isOpen) && (
                                <button
                                  type="button"
                                  onClick={() => setExpanded(isOpen ? null : row.key)}
                                  className="text-[10.5px] text-[#1a71ff] hover:underline"
                                >
                                  {isOpen ? '收起' : '展开'}
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-[8px] py-[12px]">
                          <div className="flex flex-wrap gap-[4px]">
                            {row.keywords.length === 0 && <span className="text-[11px] text-[#d20b0b]">未生成</span>}
                            {row.keywords.map((kw) => (
                              <span
                                key={kw}
                                className="rounded-full bg-[#f2f1ee] px-[7px] py-[1px] text-[10.5px] text-[#3d3d3f]"
                              >
                                {kw}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-[8px] py-[12px] pr-[24px] text-right text-[11px] text-[#9a9a9f]">
                          {row.rows.length > 0 ? row.rows.map((n) => `第 ${n} 行`).join('、') : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-[10px] border-t border-[#ecebe7] px-[24px] py-[14px]">
              <span className="mr-auto text-[11.5px] leading-[18px] text-[#9a9a9f]">
                {job?.model_name ? `模型：${job.model_name}` : '未使用模型（按列推断）'}
                {job ? ` · ${job.sheet_name || 'Sheet1'} · 读取 ${job.rows_total} 行` : ''}
                {job?.truncated ? ' · 表格过长已截断' : ''}
              </span>
              <button
                type="button"
                onClick={() => {
                  reset();
                  inputRef.current?.click();
                }}
                disabled={saving}
                className="flex h-[32px] items-center gap-[5px] rounded-[10px] border border-[#e6e4df] bg-white px-[12px] text-[12.5px] text-[#3d3d3f] transition-colors hover:border-[#18181a]/30 hover:text-[#18181a] disabled:opacity-60"
              >
                <RotateCcw className="size-[13px]" />
                重新上传
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="h-[32px] rounded-[10px] border border-[#e6e4df] bg-white px-[14px] text-[12.5px] text-[#3d3d3f] transition-colors hover:bg-[#f2f1ee] disabled:opacity-60"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || selected.size === 0}
                className="flex h-[32px] items-center gap-[5px] rounded-[10px] bg-[#18181a] px-[14px] text-[12.5px] text-white transition-colors hover:bg-[#303033] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <LoaderCircle className="size-[13px] animate-spin" /> : <Check className="size-[13px]" />}
                {saving ? '保存中…' : `保存 ${selected.size} 条`}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default FaqImportDialog;