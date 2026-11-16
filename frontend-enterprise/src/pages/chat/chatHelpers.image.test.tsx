// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownMessage } from './chatHelpers';

afterEach(() => {
  cleanup();
});

/**
 * 知识库文档的图注兜底词是「原文档配图」。图片 404 时若把 alt 直接当文本吐出来，
 * 一条九步的操作手册会变成九句「…点击左上角“文件” 原文档配图」，正文被污染且
 * 完全看不出是图片加载失败。
 */
describe('MarkdownMessage 配图失败态', () => {
  it('图片 onError 后显示「配图缺失」占位，不再把 alt 漏进正文', () => {
    const { container } = render(
      createElement(MarkdownMessage, {
        content: '1. 点击左上角“文件” ![原文档配图](/api/knowledge/assets/kasset_ab12?sig=deadbeef)',
      }),
    );

    const image = container.querySelector('img');
    expect(image).toBeTruthy();

    fireEvent.error(image as HTMLImageElement);

    expect(container.textContent).toContain('配图缺失');
    expect(container.textContent).not.toContain('原文档配图');
    // 失败后不再留一个空 <img> 占位
    expect(container.querySelector('img')).toBeNull();
  });
});
