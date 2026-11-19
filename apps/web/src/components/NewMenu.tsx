import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { NEW_KINDS, type NewKind } from '../hooks.ts';
import { Icon } from './Icon.tsx';

export const NEW_ITEMS: Record<NewKind, { title: string; hint: string }> = {
  project: { title: 'Project', hint: 'A goal your agents work on together' },
  job: { title: 'Job', hint: 'Saved steps, run on demand or on a schedule' },
  agent: { title: 'Agent', hint: 'A teammate with skills and a model' },
};

/**
 * The one place to start anything: a button that opens Project, Job and Agent. The items are
 * links to #/new/<kind>, so they also open in a new tab. The list is positioned from the
 * button and fixed to the window, because the nav scrolls sideways on a phone and would clip it.
 */
export function NewMenu() {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, right: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const show = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setAt({ top: rect.bottom + 6, right: Math.max(8, innerWidth - rect.right) });
    setOpen(true);
  };
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  // Focus the first item when it opens, like any menu button.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Click elsewhere, scrolling, resizing or going to another page all close it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) close();
    };
    const dismiss = () => close();
    document.addEventListener('pointerdown', away);
    addEventListener('hashchange', dismiss);
    addEventListener('resize', dismiss);
    addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      removeEventListener('hashchange', dismiss);
      removeEventListener('resize', dismiss);
      removeEventListener('scroll', dismiss, true);
    };
  }, [open, close]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') close();
  };

  return (
    <div className="new-menu">
      <button
        ref={button}
        type="button"
        className="primary new-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            show();
          }
        }}
      >
        <Icon name="plus" size={14} /> New <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div
          ref={list}
          id={menuId}
          className="new-list"
          role="menu"
          aria-label="Create new"
          style={{ top: at.top, right: at.right }}
          onKeyDown={onMenuKey}
        >
          {NEW_KINDS.map((kind) => (
            <a
              key={kind}
              role="menuitem"
              className="new-item"
              href={`#/new/${kind}`}
              onClick={() => close()}
            >
              <b>{NEW_ITEMS[kind].title}</b>
              <span className="muted small">{NEW_ITEMS[kind].hint}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
