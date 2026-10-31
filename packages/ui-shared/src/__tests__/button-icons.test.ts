import { describe, expect, it } from 'vitest';
import { button } from '../primitives/button.js';

describe('shared action buttons', () => {
  it('keeps class text inside its attribute and never uses raw HTML as an icon-only name', () => {
    const visible = button({ label: '<strong>Refresh</strong>', htmlLabel: true, icon: 'refresh', iconOnly: true,
      extraClass: 'icon" data-unexpected="yes' });
    expect(visible).toContain('<span><strong>Refresh</strong></span>');
    expect(visible).not.toContain('aria-label="&lt;strong&gt;');
    expect(visible).not.toContain(' data-unexpected="yes"');
    expect(visible).toContain('icon&quot; data-unexpected=&quot;yes');
    const compact = button({ label: '<strong>Refresh</strong>', htmlLabel: true, icon: 'refresh', iconOnly: true,
      ariaLabel: 'Refresh calendar' });
    expect(compact).toContain('aria-label="Refresh calendar"');
    expect(compact).toContain('title="Refresh calendar"');
    expect(compact).not.toContain('<strong>');
  });

  it('retains an escaped visible label and its action when adding a decorative icon', () => {
    const html = button({ label: 'Reply & review', icon: 'reply', action: 'reply' });
    expect(html).toContain('<span>Reply &amp; review</span>');
    expect(html).toContain('data-action="reply"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  it('gives a compact icon button a tooltip and accessible name while preserving busy and disabled state', () => {
    const html = button({ label: 'Refresh email', icon: 'refresh', iconOnly: true,
      action: 'refresh', disabled: true, ariaBusy: true });
    expect(html).toContain('aria-label="Refresh email"');
    expect(html).toContain('title="Refresh email"');
    expect(html).toContain('data-action="refresh"');
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('<span>Refresh email</span>');
    expect(button({ label: 'Refresh email', iconOnly: true })).toContain('>Refresh email</button>');
  });
});
