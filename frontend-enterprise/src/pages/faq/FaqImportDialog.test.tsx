// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '@/i18n';
import { FaqImportDialog, type FaqImportJob } from './FaqImportDialog';

const uploadWithProgress = vi.fn();
const get = vi.fn();
const post = vi.fn();

vi.mock('@/api/client', () => ({
  TENANT_ID: 'tenant_demo',
  api: {
    uploadWithProgress: (...args: unknown[]) => uploadWithProgress(...args),
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

vi.mock('@/components/ui/app-toast', () => ({
  notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/**
 * 导入是两段式的：上传返回 job_id → 轮询拿预览 → 勾选后提交。
 * 这里桩掉 api，验证「默认只勾可用条目」「关键词不足的条目不进默认勾选」
 * 「保存只提交勾选的条目」这三个会直接影响入库结果的判断。
 */

function makeItem(overrides: Partial<FaqImportJob['items'][number]> = {}) {
  return {
    question: '发票丢了怎么办',
    answer: '提交发票遗失说明并附付款凭证。',
    keywords: ['发票', '遗失'],
    rows: [2],
    note: '',
    warning: '',
    ...overrides,
  };
}

function makeJob(overrides: Partial<FaqImportJob> = {}): FaqImportJob {
  return {
    job_id: 'faqimp_1',
    filename: 'faq.xlsx',
    status: 'succeeded',
    stage: 'done',
    stage_text: '解析完成',
    progress: 100,
    error: null,
    warnings: [],
    items: [makeItem()],
    sheet_name: 'FAQ',
    rows_total: 1,
    rows_used: 1,
    truncated: false,
    model_name: 'deepseek-v4',
    ...overrides,
  };
}

function renderDialog(props: Partial<Parameters<typeof FaqImportDialog>[0]> = {}) {
  return render(
    <I18nProvider>
      <FaqImportDialog
        open
        agentId="agent1"
        onClose={() => {}}
        onSaved={() => {}}
        {...props}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  uploadWithProgress.mockReset();
  get.mockReset();
  post.mockReset();
});

afterEach(cleanup);

describe('FaqImportDialog · 上传与预览', () => {
  it('解析完成后默认只勾选「可用」条目，关键词不足的留给用户判断', async () => {
    uploadWithProgress.mockResolvedValue({ job_id: 'faqimp_1' });
    get.mockResolvedValue(
      makeJob({
        items: [
          makeItem(),
          makeItem({
            question: '发票丢了怎么补',
            keywords: ['发票'],
            warning: '关键词不足 2 个，请手工补充',
          }),
        ],
      }),
    );

    renderDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'faq.xlsx')],
      configurable: true,
    });
    fireEvent.change(input);

    await waitFor(() => expect(screen.getByText(/已选/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /保存 1 条/ })).toBeTruthy();
    // 需核对的条目仍然展示，只是不在默认勾选里
    expect(screen.getByText('发票丢了怎么补')).toBeTruthy();
    expect(screen.getByText(/关键词不足 2 个/)).toBeTruthy();
  });

  it('保存时只提交勾选的条目', async () => {
    uploadWithProgress.mockResolvedValue({ job_id: 'faqimp_1' });
    get.mockResolvedValue(makeJob());
    post.mockResolvedValue({ created: 1, skipped: 0 });
    const onSaved = vi.fn();

    renderDialog({ onSaved });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'faq.xlsx')],
      configurable: true,
    });
    fireEvent.change(input);

    const saveButton = await screen.findByRole('button', { name: /保存 1 条/ });
    fireEvent.click(saveButton);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0] as [string, { items: unknown[] }];
    expect(path).toContain('/faq/import:items');
    expect(body.items).toHaveLength(1);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(1));
  });

  it('筛选「需核对」后可以一键全选，再保存', async () => {
    uploadWithProgress.mockResolvedValue({ job_id: 'faqimp_1' });
    get.mockResolvedValue(
      makeJob({
        items: [
          makeItem(),
          makeItem({ question: '发票丢了怎么补', keywords: ['发票'], warning: '关键词不足 2 个，请手工补充' }),
        ],
      }),
    );
    post.mockResolvedValue({ created: 1, skipped: 0 });

    renderDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'faq.xlsx')],
      configurable: true,
    });
    fireEvent.change(input);

    fireEvent.click(await screen.findByRole('button', { name: /需核对/ }));
    // 筛选后的视图只剩 1 行，全选把这一行也勾上
    fireEvent.click(screen.getByLabelText('全选当前筛选结果'));
    await waitFor(() => expect(screen.getByRole('button', { name: /保存 2 条/ })).toBeTruthy());
  });

  it('上传格式不对时直接拦下，不发请求', async () => {
    renderDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'faq.xls')],
      configurable: true,
    });
    fireEvent.change(input);

    await waitFor(() => {
      expect(screen.getByText(/支持 \.xlsx/)).toBeTruthy();
    });
    expect(uploadWithProgress).not.toHaveBeenCalled();
  });

  it('解析失败时展示后端给出的原因', async () => {
    uploadWithProgress.mockResolvedValue({ job_id: 'faqimp_1' });
    get.mockResolvedValue(
      makeJob({ status: 'failed', stage: 'failed', error: '表格是空的，没有可导入的内容', items: [] }),
    );

    renderDialog();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'faq.xlsx')],
      configurable: true,
    });
    fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('表格是空的，没有可导入的内容')).toBeTruthy());
  });
});