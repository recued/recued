import { describe, it, expect, vi } from 'vitest';
import { createActionDispatcher, type ActionHandlers } from '../action-dispatcher.js';

/** Minimal DOM-free mocks — the dispatcher only touches a handful of
 *  methods on `root` and whatever `closest` returns, so we stub those
 *  rather than pulling in a full jsdom environment. */
const makeFakeRoot = () => {
  let listener: ((event: Event) => void) | null = null;
  const fakeRoot = {
    addEventListener: (_evt: string, fn: (event: Event) => void) => { listener = fn; },
    removeEventListener: (_evt: string, fn: (event: Event) => void) => {
      if (listener === fn) listener = null;
    },
    contains: () => true,
  } as unknown as HTMLElement;
  return {
    root: fakeRoot,
    dispatch: (event: Event) => { if (listener) listener(event); },
    hasListener: () => listener !== null,
  };
};

const makeClickEvent = (dataset: Record<string, string>): Event => {
  const preventDefault = vi.fn();
  const el = {
    dataset,
    closest: () => el as unknown as HTMLElement,
  } as unknown as HTMLElement;
  return { target: el, preventDefault } as unknown as Event;
};

type TestAction = 'save' | 'cancel' | 'delete';

describe('createActionDispatcher', () => {
  it('dispatches clicks by data-action to the matching handler', () => {
    const saveSpy = vi.fn();
    const cancelSpy = vi.fn();
    const deleteSpy = vi.fn();
    const handlers: ActionHandlers<TestAction> = {
      save: saveSpy,
      cancel: cancelSpy,
      delete: deleteSpy,
    };
    const { root, dispatch } = makeFakeRoot();
    createActionDispatcher({ root, handlers });

    dispatch(makeClickEvent({ action: 'save' }));
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('passes the full dataset to the handler so it can read extra data-* attrs', () => {
    const saveSpy = vi.fn();
    const handlers: ActionHandlers<TestAction> = {
      save: saveSpy,
      cancel: vi.fn(),
      delete: vi.fn(),
    };
    const { root, dispatch } = makeFakeRoot();
    createActionDispatcher({ root, handlers });

    dispatch(makeClickEvent({ action: 'save', recipeId: 'abc-123', key: 'local' }));
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'save', recipeId: 'abc-123', key: 'local' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('calls event.preventDefault when it matches a handler', () => {
    const handlers: ActionHandlers<TestAction> = {
      save: vi.fn(),
      cancel: vi.fn(),
      delete: vi.fn(),
    };
    const { root, dispatch } = makeFakeRoot();
    createActionDispatcher({ root, handlers });

    const event = makeClickEvent({ action: 'save' });
    dispatch(event);
    expect((event.preventDefault as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks with no data-action attribute', () => {
    const saveSpy = vi.fn();
    const handlers: ActionHandlers<TestAction> = {
      save: saveSpy,
      cancel: vi.fn(),
      delete: vi.fn(),
    };
    const { root, dispatch } = makeFakeRoot();
    createActionDispatcher({ root, handlers });

    // An element with no data-action — closest returns null.
    const plainEl = { closest: () => null } as unknown as HTMLElement;
    const event = { target: plainEl, preventDefault: vi.fn() } as unknown as Event;
    dispatch(event);
    expect(saveSpy).not.toHaveBeenCalled();
    expect((event.preventDefault as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('ignores unknown actions without calling any handler or preventDefault', () => {
    const saveSpy = vi.fn();
    const handlers: ActionHandlers<TestAction> = {
      save: saveSpy,
      cancel: vi.fn(),
      delete: vi.fn(),
    };
    const { root, dispatch } = makeFakeRoot();
    createActionDispatcher({ root, handlers });

    const event = makeClickEvent({ action: 'unknown-action' });
    dispatch(event);
    expect(saveSpy).not.toHaveBeenCalled();
    expect((event.preventDefault as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('returns a dispose function that detaches the listener', () => {
    const handlers: ActionHandlers<TestAction> = {
      save: vi.fn(),
      cancel: vi.fn(),
      delete: vi.fn(),
    };
    const fake = makeFakeRoot();
    const dispose = createActionDispatcher({ root: fake.root, handlers });
    expect(fake.hasListener()).toBe(true);
    dispose();
    expect(fake.hasListener()).toBe(false);
  });

  it('skips dispatch when shouldDispatch returns false', () => {
    const saveSpy = vi.fn();
    const handlers: ActionHandlers<TestAction> = {
      save: saveSpy,
      cancel: vi.fn(),
      delete: vi.fn(),
    };
    const { root, dispatch } = makeFakeRoot();
    createActionDispatcher({ root, handlers, shouldDispatch: () => false });

    dispatch(makeClickEvent({ action: 'save' }));
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
