import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AccountRoleBadge } from './AccountsPanel';

describe('AccountRoleBadge', () => {
  it('uses the blue status treatment for administrators', () => {
    const rendered = renderToStaticMarkup(createElement(AccountRoleBadge, { role: 'admin' }));

    expect(rendered).toContain('管理员');
    expect(rendered).toContain('bg-[#e8f0ff]');
    expect(rendered).toContain('text-[#1a71ff]');
    expect(rendered).not.toContain('bg-[#f2f1ee]');
  });

  it('uses the neutral status treatment for members', () => {
    const rendered = renderToStaticMarkup(createElement(AccountRoleBadge, { role: 'member' }));

    expect(rendered).toContain('普通成员');
    expect(rendered).toContain('bg-[#f2f1ee]');
    expect(rendered).toContain('text-[#6d6d72]');
    expect(rendered).not.toContain('bg-[#e8f0ff]');
  });
});
