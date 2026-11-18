import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderInlineMarkdown } from './chatHelpers';

/**
 * 反引号 SQL/终端代码与「反引号包的 URL」的边界。
 *
 * 回收行内代码里的裸 URL 时最容易误伤两类：真正的代码片段（含空格的多 token
 * 命令）和非 http(s) 的东西（相对路径、mailto、javascript:）。这条测试把边界
 * 钉住，避免以后为了"让链接能点"把代码块也一起改坏。
 */
const render = (source: string) =>
  renderToStaticMarkup(createElement('div', null, ...renderInlineMarkdown(source, 'edge')));

describe('inline code containing a URL', () => {
  it('strips trailing punctuation from the href but keeps it outside the link', () => {
    const rendered = render('`https://example.com/a.`');

    expect(rendered).toMatch(/<a[^>]*href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\./);
    expect(rendered).not.toContain('<code>');
  });

  it('adds an https scheme for a bare www address', () => {
    const rendered = render('`www.example.com`');

    expect(rendered).toMatch(/<a[^>]*href="https:\/\/www\.example\.com\/"[^>]*>/);
  });

  it('keeps multi-token shell code as code', () => {
    const rendered = render('`https://x.com/a b`');

    expect(rendered).toContain('<code>https://x.com/a b</code>');
    expect(rendered).not.toContain('<a');
  });

  it('keeps relative paths and non-http schemes as code', () => {
    for (const source of ['`/api/knowledge/x`', '`mailto:a@b.com`', '`javascript:alert(1)`']) {
      const rendered = render(source);
      expect(rendered).not.toContain('<a');
      expect(rendered).toContain('<code>');
    }
  });

  it('leaves an empty code span alone without crashing', () => {
    expect(() => render('``')).not.toThrow();
  });
});