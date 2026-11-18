import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderInlineMarkdown } from './chatHelpers';

const r = (s: string) =>
  renderToStaticMarkup(createElement('div', null, ...renderInlineMarkdown(s, 'e')));

describe('edge', () => {
  it('dump', () => {
    const cases: Array<[string, string]> = [
      ['A trailing period', '`https://example.com/a.`'],
      ['B www', '`www.example.com`'],
      ['C brackets', '`https://x.com/p[1]`'],
      ['D relative', '`/api/knowledge/x`'],
      ['E spaces', '`https://x.com/a b`'],
      ['F mailto', '`mailto:a@b.com`'],
      ['G empty', '``'],
    ];
    const out = cases.map(([n, s]) => `${n} => ${r(s)}`).join('\n');
    expect(out).toBe('SHOW:\n' + out);
  });
});