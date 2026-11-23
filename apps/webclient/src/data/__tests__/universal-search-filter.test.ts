import { describe, expect, it } from 'vitest';
import type { CollectionSearchGroup } from '@recued/contracts';
import { filterUniversalSearch, searchTypeCounts } from '../universal-search-filter.js';
import { renderUniversalSearch, type UniversalSearchProps } from '../universal-search.js';

const mail: CollectionSearchGroup = { platform: 'mail', slug: 'inbox', more: true,
  source_freshness: { stale: false, last_success_at: 1, age_ms: 0, degraded: false, pending: 0 },
  matches: [1, 2].map(n => ({ record_id: `mail-${n}`, rank: 0, hot_fields: { subject: `Renewal mail ${n}` } })) };
const base: UniversalSearchProps = { query: 'renewal', actionAttr: 'data-action', groups: [mail], workGroups: [],
  contactSearch: { contacts: [{ _id: 'contact-1', _collection: 'contact', email: 'renewal@example.test',
    first_seen: 1, last_interaction: 1, interaction_count: 0, source: 'manual', created_at: 1, updated_at: 1 }], total: 999, loading: false, more: true },
  assetSearch: { query: 'renewal', matches: [{ id: 'passport', name: 'Renewal passport', class_name: 'Passport', status: 'active', stale: false, pending_write: false }],
    total: 80, offset: 1, more: true, loading: false },
};

describe('universal-search result-type filters', () => {
  it('scopes reminder results without counting the server total as loaded or hiding other type choices', () => {
    const reminderSearch = { input: { state: 'all' as const, query: 'renewal' }, total: 900, pages: 1, loading: false,
      matches: [{ reminder_id: 'rem_1', text: 'Renewal clinic', at: 1, when: 'Tomorrow', state: 'delivered' as const, delivered_at: 1, time_zone: 'Asia/Tokyo' }],
      next_cursor: { at: 1, reminder_id: 'rem_1' } };
    const props = { ...base, reminderSearch, resultType: 'reminder' as const };
    expect(searchTypeCounts(props).reminder).toEqual({ loaded: 1, more: true, pending: false, unavailable: false });
    const html = renderUniversalSearch(props);
    expect(html).toContain('Reminders · 1+ loaded'); expect(html).not.toContain('900 loaded');
    expect(html).toContain('#data/reminder/rem_1'); expect(html).toContain('Rang'); expect(html).toContain('Asia/Tokyo');
    expect(html).not.toContain('data-search-record="mail-1"'); expect(filterUniversalSearch(props, 'mail').reminderSearch).toBeUndefined();
  });
  it('counts loaded rows rather than provider totals and keeps paging and pending counts explicit', () => {
    const counts = searchTypeCounts(base);
    expect(counts.mail).toEqual({ loaded: 2, more: true, pending: false, unavailable: false });
    expect(counts.contact.loaded).toBe(1); expect(counts.asset.loaded).toBe(1); expect(counts.all.loaded).toBe(4);
    expect(counts.all.more).toBe(true);
    const pending = searchTypeCounts({ ...base, debouncing: true });
    expect(pending.mail).toMatchObject({ loaded: 0, pending: true, more: false });
  });
  it('keeps file-content activity out of another type’s loading and error state', () => {
    const props: UniversalSearchProps = { ...base, chatSearch: { query: 'renewal', matches: [], pages: 0, loading: true, incomplete: true },
      documentSearch: { query: 'renewal', phase: 'held', matches: [] }, capabilitiesError: 'Packs unavailable', workError: 'Tasks unavailable' };
    expect(searchTypeCounts(props).file.pending).toBe(true);
    expect(searchTypeCounts(props).chat).toMatchObject({ pending: true, more: true });
    const filtered = filterUniversalSearch(props, 'mail');
    expect(filtered.groups).toEqual([mail]); expect(filtered.documentSearch).toBeUndefined();
    expect(filtered.chatSearch).toBeUndefined(); expect(filtered.workError).toBeUndefined(); expect(filtered.capabilitiesError).toBeUndefined();
    expect(props.documentSearch?.phase).toBe('held');
  });
  it('renders just the selected type while keeping honest counts for switching types', () => {
    const html = renderUniversalSearch({ ...base, resultType: 'mail', marketplaceOffered: true });
    expect(html).toContain('value="mail" selected>Mail · 2+ loaded');
    expect(html).toContain('Contacts · 1+ loaded'); expect(html).not.toContain('999 loaded');
    expect(html).toContain('data-search-record="mail-1"'); expect(html).not.toContain('data-search-contact-email=');
    expect(html).not.toContain('data-search-asset-id='); expect(html).toContain('Showing only Mail results.');
    expect(html).toContain('Clear type filter');
  });
  it('scopes empty and unavailable states without claiming all types are empty or offering a cloud search', () => {
    const empty = renderUniversalSearch({ ...base, groups: [], resultType: 'mail', marketplaceOffered: true,
      workError: 'Unrelated work failure', didYouMean: { query: 'renew', corrections: [{ typed: 'renewal', word: 'renew', records: 1 }] } });
    expect(empty).toContain('No Mail results loaded'); expect(empty).not.toContain('No matches in the searched sources');
    expect(empty).not.toContain('Unrelated work failure'); expect(empty).not.toContain('Did you mean');
    expect(empty).not.toContain('universal-search-marketplace');
    const unavailable = renderUniversalSearch({ ...base, groups: [], resultType: 'mail', recordSearchAvailable: false });
    expect(unavailable).toContain('Mail results could not all be confirmed.'); expect(unavailable).not.toContain('No Mail results loaded');
  });
});
