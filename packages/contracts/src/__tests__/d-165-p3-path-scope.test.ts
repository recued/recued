/** D-165 P3.path-picker Slice 3a — pure path-scope helper. */

import { describe, expect, it } from 'vitest';

import {
  checkPathScope,
  type PathScopeCheck,
  type PathScopeContract,
} from '@recued/contracts';

const check = (
  scope: PathScopeContract,
  args: Record<string, unknown> = {},
  connectionSubresourcePath?: string,
): PathScopeCheck => checkPathScope(scope, args, connectionSubresourcePath);

describe('checkPathScope connection_root policy', () => {
  it('admits only root-scoped connections and ignores the target template', () => {
    const scope = {
      policy: 'connection_root',
      target_path_template: '/photos/{id}',
    } satisfies PathScopeContract;

    expect(check(scope, { id: 'ignored' }, '/')).toEqual({
      ok: true,
      connection_path: '/',
    });
    expect(check(scope, { id: 'ignored' }, '/photos')).toEqual({
      ok: false,
      reason: 'connection_not_root',
      connection_path: '/photos',
    });
    expect(check(scope, { id: 'ignored' }, undefined)).toEqual({
      ok: true,
      connection_path: '/',
    });
  });
});

describe('checkPathScope connection_or_below policy', () => {
  const databaseScope = {
    policy: 'connection_or_below',
    target_path_template: '/databases/{id}',
  } satisfies PathScopeContract;

  it('admits equal targets, strict descendants, and root-as-ancestor', () => {
    expect(check(databaseScope, { id: 'abc' }, '/databases/abc')).toEqual({
      ok: true,
      connection_path: '/databases/abc',
      target_path: '/databases/abc',
    });
    expect(check(databaseScope, { id: 'abc' }, '/databases')).toEqual({
      ok: true,
      connection_path: '/databases',
      target_path: '/databases/abc',
    });
    expect(check(databaseScope, { id: 'abc' }, '/')).toEqual({
      ok: true,
      connection_path: '/',
      target_path: '/databases/abc',
    });
  });

  it('denies targets outside the scoped connection path', () => {
    expect(check(databaseScope, { id: 'xyz' }, '/databases/abc')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/databases/abc',
      target_path: '/databases/xyz',
    });
  });
});

describe('checkPathScope descendant_only policy', () => {
  it('admits strict descendants only', () => {
    const scope = {
      policy: 'descendant_only',
      target_path_template: '/photos/{key}',
    } satisfies PathScopeContract;

    expect(check(scope, { key: '2024/img' }, '/photos')).toEqual({
      ok: true,
      connection_path: '/photos',
      target_path: '/photos/2024/img',
    });
  });

  it('does not treat equality as descent', () => {
    const scope = {
      policy: 'descendant_only',
      target_path_template: '/photos',
    } satisfies PathScopeContract;

    expect(check(scope, {}, '/photos')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/photos',
      target_path: '/photos',
    });
  });

  it('treats root as ancestor only for non-root targets', () => {
    expect(check({
      policy: 'descendant_only',
      target_path_template: '/photos/{key}',
    }, { key: 'img' }, '/')).toEqual({
      ok: true,
      connection_path: '/',
      target_path: '/photos/img',
    });

    expect(check({
      policy: 'descendant_only',
      target_path_template: '//',
    }, {}, '/')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/',
      target_path: '/',
    });
  });
});

describe('checkPathScope strict descendant boundaries', () => {
  it('does not accept false string prefixes as path ancestry', () => {
    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/photos',
    }, {}, '/photo')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/photo',
      target_path: '/photos',
    });

    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/photosX',
    }, {}, '/photos')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/photos',
      target_path: '/photosX',
    });
  });

  it('allows dotted filenames without treating them as dot-segments', () => {
    expect(check({
      policy: 'descendant_only',
      target_path_template: '/photos/{key}',
    }, { key: 'img.jpg' }, '/photos')).toEqual({
      ok: true,
      connection_path: '/photos',
      target_path: '/photos/img.jpg',
    });
  });
});

describe('checkPathScope path traversal fail-closed behavior', () => {
  it.each([
    ['parent segment escapes scope', '/photos/{key}', '../private', '/photos/../private'],
    ['bare parent segment', '/photos/{key}', '..', '/photos/..'],
    ['multiple parent segments', '/photos/{key}', '../../etc', '/photos/../../etc'],
    ['template dot segment', '/photos/./{key}', 'x', '/photos/./x'],
    ['arg dot segment', '/photos/{key}', './x', '/photos/./x'],
  ])('denies %s before prefix scope evaluation', (_label, target_path_template, key, target_path) => {
    expect(check({
      policy: 'descendant_only',
      target_path_template,
    }, { key }, '/photos')).toEqual({
      ok: false,
      reason: 'path_traversal',
      connection_path: '/photos',
      target_path,
    });
  });
});

describe('checkPathScope template/token fail-closed behavior', () => {
  it('requires target templates for target-based policies', () => {
    expect(check({ policy: 'connection_or_below' }, {}, '/photos')).toEqual({
      ok: false,
      reason: 'missing_template',
      connection_path: '/photos',
    });
    expect(check({ policy: 'descendant_only' }, {}, '/photos')).toEqual({
      ok: false,
      reason: 'missing_template',
      connection_path: '/photos',
    });
  });

  it.each([
    ['missing arg', {}, '/photos'],
    ['empty string arg', { key: '' }, '/photos'],
    ['null arg', { key: null }, '/photos'],
  ] as const)('fails closed for %s', (_label, args, connectionSubresourcePath) => {
    expect(check({
      policy: 'descendant_only',
      target_path_template: '/photos/{key}',
    }, args, connectionSubresourcePath)).toEqual({
      ok: false,
      reason: 'unresolved_template_token',
      connection_path: '/photos',
    });
  });

  it('resolves numeric zero and false args instead of treating them as missing', () => {
    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/ids/{id}',
    }, { id: 0 }, '/ids')).toEqual({
      ok: true,
      connection_path: '/ids',
      target_path: '/ids/0',
    });

    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/flags/{enabled}',
    }, { enabled: false }, '/flags')).toEqual({
      ok: true,
      connection_path: '/flags',
      target_path: '/flags/false',
    });
  });
});

describe('checkPathScope case-insensitive comparison', () => {
  it('compares lowercased canonical paths only when requested', () => {
    const scope = {
      policy: 'connection_or_below',
      target_path_template: '/Notion/{id}',
      canonicalization: 'case_insensitive',
    } satisfies PathScopeContract;

    expect(check(scope, { id: 'abc' }, '/Notion/ABC')).toEqual({
      ok: true,
      connection_path: '/Notion/ABC',
      target_path: '/Notion/abc',
    });

    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/Notion/{id}',
    }, { id: 'abc' }, '/Notion/ABC')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/Notion/ABC',
      target_path: '/Notion/abc',
    });
  });
});

describe('checkPathScope canonicalization interactions', () => {
  it('compares and returns canonical target paths for repeated and trailing slashes', () => {
    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/photos/{key}',
    }, { key: '/x' }, '/photos/')).toEqual({
      ok: true,
      connection_path: '/photos',
      target_path: '/photos/x',
    });

    expect(check({
      policy: 'descendant_only',
      target_path_template: '/photos/{key}',
    }, { key: 'a/' }, '/photos')).toEqual({
      ok: true,
      connection_path: '/photos',
      target_path: '/photos/a',
    });
  });

  it('returns canonical paths in not-ok cases too', () => {
    expect(check({
      policy: 'connection_or_below',
      target_path_template: '/photos//x/',
    }, {}, '/photo/')).toEqual({
      ok: false,
      reason: 'not_in_scope',
      connection_path: '/photo',
      target_path: '/photos/x',
    });
  });
});
