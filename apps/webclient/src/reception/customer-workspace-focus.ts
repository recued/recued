/** Reveal a heading after asynchronous content is enabled, without centering a tall report. */
export const focusCustomerWorkspace = (root: HTMLElement): void => {
    const header = root.closest?.('[data-customer-work]')?.querySelector<HTMLElement>('[data-customer-job-header]');
    const heading = root.hasAttribute('data-jobs-board') && header
        ? header.querySelector<HTMLElement>('h2') ?? root
        : root.querySelector<HTMLElement>('h2,h3,h4') ?? root;
    if (header && !header.contains(heading))
        heading.style.scrollMarginTop = (header.getBoundingClientRect().height + 12) + 'px';
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'start' });
};

/** Disabling a loading button can move focus to body. Restore it after enabling,
 * or use the adjacent page control when the action reached the last page. */
export const restoreCustomerWorkspaceControl = (doc:Document,source:HTMLElement|null,fallbacks:HTMLElement[]=[],previousActive:Element|null=source):void=>{
  if(!source || doc.activeElement!==doc.body && doc.activeElement!==source && doc.activeElement!==previousActive)return;
  const target=[source,...fallbacks].find(node=>node.isConnected && !node.matches(':disabled'));
  target?.focus({preventScroll:true});
};
