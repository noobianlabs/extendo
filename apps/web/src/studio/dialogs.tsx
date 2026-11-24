import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import {
  ArrowDown, ArrowUp, ChevronDown, CircleAlert, CornerDownLeft, FolderOpen,
  MessageSquare, Moon, Search, Settings2, Sun, X, Zap,
} from 'lucide-react';
import type { ProviderInfo, Settings, Thread } from '@extendo/contracts';
import styles from './dialogs.module.css';

type Command = { id: string; title: string; description?: string; shortcut?: string; run: () => void };
type Theme = 'dark' | 'light';
const formatNumber = new Intl.NumberFormat();

function Modal({
  children, titleId, initialFocus, onClose, palette = false, pending = false,
}: {
  children: ReactNode;
  titleId: string;
  initialFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  palette?: boolean;
  pending?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerOutside = useRef(false);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    initialFocus.current?.focus();
    return () => dialog.close();
  }, [initialFocus]);

  return <dialog
    ref={dialogRef} className={palette ? `${styles.modal} ${styles.palette}` : styles.modal}
    aria-labelledby={titleId}
    onCancel={(event) => {
      event.preventDefault();
      if (!pending) onClose();
    }}
    onPointerDown={(event) => { pointerOutside.current = event.target === event.currentTarget; }}
    onClick={(event) => {
      if (pointerOutside.current && event.target === event.currentTarget && !pending) onClose();
      pointerOutside.current = false;
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex]',
      )).filter((item) => !item.matches(':disabled') && item.tabIndex >= 0 && item.getClientRects().length > 0);
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && event.target === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault();
        first.focus();
      }
    }}
  >{children}</dialog>;
}

function DialogHeader({
  titleId, title, icon, pending, onClose,
}: { titleId: string; title: string; icon: ReactNode; pending: boolean; onClose: () => void }) {
  return <header className={styles.header}>
    {icon}<h2 id={titleId}>{title}</h2>
    <button type="button" className={styles.close} aria-label="Close dialog" title="Close"
      disabled={pending} onClick={onClose}><X size={16} /></button>
  </header>;
}

function matchText(value: string) {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLocaleLowerCase();
}

function fuzzyScore(term: string, raw: string) {
  const value = matchText(raw);
  if (value === term) return 200;
  if (value.startsWith(term)) return 160;
  const contained = value.indexOf(term);
  if (contained >= 0) return 120 - Math.min(contained, 40);
  let last = -1;
  let score = 40;
  for (const key of term) {
    const index = value.indexOf(key, last + 1);
    if (index < 0) return -1;
    if (index === last + 1 || /[\s_./-]/.test(value[index - 1] ?? '')) score += 4;
    score -= Math.min(index - last - 1, 5);
    last = index;
  }
  return Math.max(1, score);
}

function rank<T>(items: T[], terms: string[], fields: (item: T) => string[]) {
  if (!terms.length) return items;
  return items.flatMap((item) => {
    const values = fields(item);
    let score = 0;
    for (const term of terms) {
      const best = Math.max(...values.map((field, index) => {
        const result = fuzzyScore(term, field);
        return result < 0 ? result : Math.max(0, result - index * 20);
      }));
      if (best < 0) return [];
      score += best;
    }
    return [{ item, score }];
  }).sort((a, b) => b.score - a.score).map(({ item }) => item);
}

type PaletteProps = {
  open: boolean;
  threads: Thread[];
  onClose: () => void;
  onSelectThread: (id: string) => void;
  commands: Command[];
};

function PaletteContent({ threads, onClose, onSelectThread, commands }: Omit<PaletteProps, 'open'>) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef(true);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const { groups, results } = useMemo(() => {
    const terms = matchText(query).trim().split(/\s+/).filter(Boolean);
    const matchingCommands = rank(commands, terms, (item) => [item.title, item.description ?? '']);
    const matchingThreads = rank(threads, terms, (item) => [item.title, item.cwd, item.branch ?? '']);
    const groups = [
      {
        name: 'Commands',
        total: matchingCommands.length,
        items: matchingCommands.slice(0, 50).map((command) => ({
          id: command.id, title: command.title, detail: command.description, shortcut: command.shortcut,
          action: command.run, mono: false,
        })),
      },
      {
        name: 'Threads',
        total: matchingThreads.length,
        items: matchingThreads.slice(0, 50).map((thread) => ({
          id: thread.id, title: thread.title.trim() || 'Untitled thread', detail: thread.cwd,
          shortcut: undefined, action: () => onSelectThread(thread.id), mono: true,
        })),
      },
    ].filter((group) => group.items.length);
    return { groups, results: groups.flatMap((group) => group.items) };
  }, [commands, onSelectThread, query, threads]);
  const current = Math.max(0, Math.min(activeIndex, results.length - 1));
  useLayoutEffect(() => {
    if (keyboardMove.current) activeRef.current?.scrollIntoView({ block: 'nearest' });
    keyboardMove.current = false;
  }, [current, query]);

  function activate(action: () => void) {
    onClose();
    action();
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || !results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      keyboardMove.current = true;
      setActiveIndex((current + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[current];
      if (item) activate(item.action);
    }
  }

  let index = 0;
  return <Modal titleId={`${id}-title`} initialFocus={inputRef} onClose={onClose} palette>
    <h2 className={styles.visuallyHidden} id={`${id}-title`}>Command palette</h2>
    <div className={styles.search}>
      <Search size={17} />
      <input type="text" ref={inputRef} role="combobox" aria-label="Search commands and threads"
        aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-results`}
        aria-activedescendant={results.length ? `${id}-option-${current}` : undefined}
        placeholder="Search commands and threads…" autoComplete="off" spellCheck={false}
        value={query} onKeyDown={navigate} onChange={(event) => {
          keyboardMove.current = true;
          setActiveIndex(0);
          setQuery(event.target.value);
        }} />
      <button className={styles.esc} type="button" aria-label="Close command palette" onClick={onClose}>Esc</button>
    </div>
    <div className={styles.paletteScroll}>
      <div id={`${id}-results`} role="listbox" aria-label="Search results">
        {groups.map((group) => <div className={styles.group} key={group.name} role="group" aria-label={group.name}>
          <div className={styles.groupTitle} aria-hidden="true">{group.name}</div>
          {group.items.map((item) => {
            const itemIndex = index++;
            const selected = current === itemIndex;
            const Icon = item.mono ? MessageSquare : Zap;
            return <div
              className={styles.option} role="option" aria-selected={selected}
              ref={selected ? activeRef : null} id={`${id}-option-${itemIndex}`} key={item.id}
              onMouseMove={() => setActiveIndex(itemIndex)} onMouseDown={(event) => event.preventDefault()}
              onClick={() => activate(item.action)}
            >
              <Icon size={15} />
              <div className={styles.optionText}>
                <span title={item.title} dir="auto">{item.title}</span>
                {item.detail && <span title={item.detail} dir="auto" data-mono={item.mono}>{item.detail}</span>}
              </div>
              {item.shortcut && <kbd className={styles.shortcut}>{item.shortcut}</kbd>}
            </div>;
          })}
          {group.total > group.items.length && <div className={styles.resultLimit} aria-hidden="true">
            Showing {group.items.length} of {formatNumber.format(group.total)}. Refine your search.
          </div>}
        </div>)}
      </div>
      {!results.length && <p className={styles.noResults} role="status">
        {query.trim() ? 'No matching commands or threads.' : 'No commands or threads available.'}
      </p>}
    </div>
    <div className={styles.paletteFoot} aria-hidden="true">
      <span><kbd><ArrowUp size={11} /></kbd><kbd><ArrowDown size={11} /></kbd> Navigate</span>
      <span><kbd><CornerDownLeft size={11} /></kbd> Select</span>
    </div>
  </Modal>;
}

export function CommandPalette({ open, ...props }: PaletteProps) {
  return open ? <PaletteContent {...props} /> : null;
}

function useSave(action: () => Promise<void>, onClose: () => void, fallback: string) {
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await action();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : fallback);
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return { pending, error, setError, submit };
}

function FormFooter({
  label, pendingLabel, pending, valid, onClose,
}: { label: string; pendingLabel: string; pending: boolean; valid: boolean; onClose: () => void }) {
  return <footer className={styles.formFoot}>
    <button type="button" className={styles.secondary} disabled={pending} onClick={onClose}>Cancel</button>
    <button type="submit" className={styles.primary} disabled={!valid} aria-disabled={pending || undefined}>
      {pending ? pendingLabel : label}
    </button>
  </footer>;
}

export interface ConfirmRequest {
  title: string;
  /** What will be destroyed, named. */
  description: ReactNode;
  confirmLabel: string;
  /** A second decision the person can make in the same confirmation, off unless they turn it on. */
  option?: string;
  onConfirm: (choice: { checked: boolean }) => Promise<void> | void;
}

/** A confirmation that names what it destroys. The cancel button holds focus for a destructive one. */
function ConfirmContent({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const id = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  return <Modal titleId={`${id}-title`} initialFocus={cancelRef} onClose={onClose} pending={pending}>
    <DialogHeader titleId={`${id}-title`} title={request.title} icon={<CircleAlert size={17} />}
      pending={pending} onClose={onClose} />
    <div className={styles.form}>
      <div className={styles.formBody}>
        <div className={styles.confirmBody}>
          {request.description}
          {request.option && <label className={styles.confirmOption}>
            <input type="checkbox" checked={checked} disabled={pending} onChange={(event) => setChecked(event.target.checked)} />
            <span>{request.option}</span>
          </label>}
        </div>
        {error && <p role="alert" className={styles.error}><CircleAlert size={15} />{error}</p>}
      </div>
      <footer className={styles.formFoot}>
        <button type="button" className={styles.secondary} ref={cancelRef} disabled={pending}
          onClick={onClose}>Cancel</button>
        <button type="button" ref={confirmRef} className={styles.destructive} disabled={pending}
          onClick={async () => {
            setPending(true);
            setError('');
            try { await request.onConfirm({ checked }); onClose(); }
            catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : 'That action did not finish.'); }
            finally { setPending(false); }
          }}>{pending ? 'Working…' : request.confirmLabel}</button>
      </footer>
    </div>
  </Modal>;
}

export function ConfirmDialog({ request, onClose }: { request?: ConfirmRequest; onClose: () => void }) {
  return request ? <ConfirmContent request={request} onClose={onClose} /> : null;
}

type SettingsProps = {
  open: boolean;
  settings: Settings;
  providers: ProviderInfo[];
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSave: (settings: Settings) => Promise<void>;
  onClose: () => void;
};

function SettingsContent({ settings, providers, theme, onTheme, onSave, onClose }: Omit<SettingsProps, 'open'>) {
  const id = useId();
  const providerRef = useRef<HTMLSelectElement>(null);
  const [providerId, setProviderId] = useState(settings.provider);
  const [model, setModel] = useState(settings.model ?? '');
  const [customModel, setCustomModel] = useState(
    Boolean(settings.model && settings.model !== providers.find((provider) => provider.id === settings.provider)?.model),
  );
  const [appearance, setAppearance] = useState(theme);
  const provider = providers.find((item) => item.id === providerId);
  const modelValue = customModel ? model.trim()
    : providerId === settings.provider && settings.model === provider?.model ? settings.model ?? '' : '';
  const changed = providerId !== settings.provider || modelValue !== (settings.model ?? '');
  const valid = (!changed || Boolean(provider?.configured)) && (!customModel || Boolean(modelValue));
  const { pending, error, setError, submit } = useSave(async () => {
    if (!valid) return;
    if (changed) await onSave({ provider: providerId, ...(modelValue ? { model: modelValue } : {}) });
    if (appearance !== theme) onTheme(appearance);
  }, onClose, 'Could not save settings.');
  return <Modal titleId={`${id}-title`} initialFocus={providerRef} onClose={onClose} pending={pending}>
    <DialogHeader titleId={`${id}-title`} title="Settings" icon={<Settings2 size={16} />}
      pending={pending} onClose={onClose} />
    <form className={styles.form} onSubmit={(event) => valid ? void submit(event) : event.preventDefault()}>
      <div className={styles.formBody}>
        <div className={styles.field}>
          <label htmlFor={`${id}-provider`}>Provider</label>
          <div className={styles.selectField}>
            <select id={`${id}-provider`} ref={providerRef} value={providerId}
              aria-describedby={`${id}-provider-note`} disabled={pending}
              onChange={(event) => {
                setProviderId(event.target.value);
                setModel('');
                setCustomModel(false);
                setError('');
              }}>
              {!provider && <option value={providerId}>{providerId || 'No provider available'}</option>}
              {providers.map((item) => <option key={item.id} value={item.id}>
                {item.name}{!item.configured ? ' (not configured)' : ''}
              </option>)}
            </select>
            <ChevronDown size={14} />
          </div>
          <p className={styles.help} id={`${id}-provider-note`}>
            {!provider?.configured ? <>
              {providerId === 'deepseek' && <>Set <code>DEEPSEEK_API_KEY</code> on the local server and restart it. </>}
              {providerId !== 'deepseek' && 'Configure the provider key in the server environment. '}
              {providers.some((item) => item.id === 'demo' && item.configured) && 'Demo works without a key.'}
            </> : provider.id === 'demo' ? 'Demo runs locally without an API key.'
              : 'Connected through the key in your server environment.'}
          </p>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-model`}>Default model</label>
          <div className={styles.selectField}>
            <select id={`${id}-model`} value={customModel ? 'custom' : 'default'}
              disabled={pending || !provider?.configured}
              onChange={(event) => { setCustomModel(event.target.value === 'custom'); setError(''); }}>
              <option value="default">{provider?.model || 'Provider default'}</option>
              {(providerId !== 'demo' || customModel) && <option value="custom">Custom model…</option>}
            </select>
            <ChevronDown size={14} />
          </div>
          {customModel && <input className={styles.monoInput} aria-label="Custom model identifier" type="text"
            value={model} maxLength={256} autoComplete="off" spellCheck={false}
            placeholder="Model identifier" required disabled={pending || !provider?.configured}
            onChange={(event) => { setModel(event.target.value); setError(''); }} />}
        </div>
        <fieldset className={styles.appearance} disabled={pending}>
          <legend>Appearance</legend>
          <div>
            {([{ name: 'Dark', value: 'dark', icon: Moon }, { name: 'Light', value: 'light', icon: Sun }] as const)
              .map(({ name, value, icon: Icon }) => <label key={value} className={styles.themeOption}>
                <input type="radio" name={`${id}-theme`} value={value} checked={appearance === value}
                  onChange={() => setAppearance(value)} />
                <Icon size={15} />{name}
              </label>)}
          </div>
        </fieldset>
        {error && <p role="alert" className={styles.error}><CircleAlert size={15} />{error}</p>}
      </div>
      <FormFooter label="Save settings" pendingLabel="Saving…" pending={pending} valid={valid} onClose={onClose} />
    </form>
  </Modal>;
}

export function SettingsDialog({ open, ...props }: SettingsProps) {
  return open ? <SettingsContent {...props} /> : null;
}

type OpenProjectProps = { open: boolean; onSave: (path: string) => Promise<void>; onClose: () => void };

function OpenProjectContent({ onSave, onClose }: Omit<OpenProjectProps, 'open'>) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState('');
  const directory = path.trim();
  const { pending, error, setError, submit } = useSave(() => onSave(directory), onClose, 'Could not open that directory.');
  return <Modal titleId={`${id}-title`} initialFocus={inputRef} onClose={onClose} pending={pending}>
    <DialogHeader titleId={`${id}-title`} title="Open a project" icon={<FolderOpen size={17} />}
      pending={pending} onClose={onClose} />
    <form className={styles.form} onSubmit={(event) => directory ? void submit(event) : event.preventDefault()}>
      <div className={styles.formBody}>
        <div className={styles.field}>
          <label htmlFor={`${id}-directory`}>Local directory</label>
          <input id={`${id}-directory`} ref={inputRef} className={styles.monoInput} type="text"
            dir="ltr" placeholder="/path/to/project" autoComplete="off" spellCheck={false} required
            disabled={pending} value={path} aria-describedby={error ? `${id}-error` : undefined}
            aria-invalid={error ? true : undefined}
            onChange={(event) => { setPath(event.target.value); setError(''); }} />
          {error && <p id={`${id}-error`} role="alert" className={styles.error}><CircleAlert size={15} />{error}</p>}
        </div>
      </div>
      <FormFooter label="Open project" pendingLabel="Opening…" pending={pending} valid={Boolean(directory)} onClose={onClose} />
    </form>
  </Modal>;
}

export function OpenProjectDialog({ open, ...props }: OpenProjectProps) {
  return open ? <OpenProjectContent {...props} /> : null;
}
