import { CircleAlert, CircleDot, Plus, Trash2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Extension, ExtensionState, LiveTool } from '@extendo/contracts';
import styles from './workshop.module.css';

const PluginEditor = lazy(() => import('./editor'));

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export interface WorkshopProps {
  open: boolean;
  state: ExtensionState;
  tools: LiveTool[];
  selected?: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onSave: (id: string, source: string) => Promise<SaveResult>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function mountedAt(extension: Extension): string {
  if (!extension.mountedAt) return 'not loaded';
  const at = new Date(extension.mountedAt);
  return Number.isNaN(at.valueOf()) ? 'not loaded' : clock.format(at);
}

export function Workshop({ open, state, tools, selected, onSelect, onCreate, onSave, onRemove, onClose }: WorkshopProps) {
  const headingId = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [failure, setFailure] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState(0);
  const [mounted, setMounted] = useState(open);
  const nameField = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) setMounted(true); }, [open]);

  const extensions = state.extensions;
  const current = extensions.find(({ id }) => id === selected) ?? extensions[0];
  const source = current ? drafts[current.id] ?? current.source : '';
  const dirty = current ? drafts[current.id] !== undefined && drafts[current.id] !== current.source : false;
  const mine = useMemo(() => current ? tools.filter(({ extensionId }) => extensionId === current.id) : [], [tools, current]);

  useEffect(() => {
    if (!creating) return;
    nameField.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => setStatus('idle'), 2200);
    return () => clearTimeout(timer);
  }, [status, sweep]);

  if (!mounted) return null;

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onCreate(trimmed);
      setName('');
      setCreating(false);
      setStatus('saved');
      setSweep((value) => value + 1);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not create the plugin.');
      setStatus('failed');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!current || busy) return;
    setBusy(true);
    setFailure(undefined);
    setStatus('saving');
    try {
      const result = await onSave(current.id, source);
      if (result.ok) {
        setStatus('saved');
        setSweep((value) => value + 1);
      } else {
        setStatus('failed');
        setFailure(result.error ?? 'The plugin did not load.');
      }
    } catch (error) {
      setStatus('failed');
      setFailure(error instanceof Error ? error.message : 'Could not save the plugin.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await onRemove(current.id);
      setDrafts(({ [current.id]: _removed, ...rest }) => rest);
      setStatus('idle');
      setFailure(undefined);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not delete the plugin.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={styles.panel} aria-labelledby={headingId} data-open={open} inert={!open} data-testid="workshop">
      <div className={styles.content}>
      <header className={styles.header}>
        <h2 id={headingId} className={styles.title}>Workshop</h2>
        <span className={styles.count}>{extensions.length === 0 ? 'no plugins' : `${extensions.length} plugin${extensions.length === 1 ? '' : 's'}`}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.iconButton} onClick={() => setCreating((value) => !value)}
          aria-expanded={creating} aria-label="New plugin" data-testid="new-plugin">
          <Plus size={14} aria-hidden="true" />
        </button>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close the workshop">
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {creating && <form className={styles.create} onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
        <label className={styles.createLabel} htmlFor={headingId + '-name'}>New plugin</label>
        <input id={headingId + '-name'} ref={nameField} value={name} onChange={(event) => setName(event.target.value)}
          placeholder="Word count" maxLength={80} className={styles.createInput} data-testid="plugin-name" />
        <button type="submit" className={styles.primary} disabled={!name.trim() || busy} data-testid="create-plugin">Create</button>
      </form>}

      {extensions.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyLead}>A plugin is a file you can write here.</p>
          <p className={styles.emptyBody}>
            Save it and its tool joins the agent’s tool list in this thread, without a restart. The
            agent can then call it like any tool that ships with Extendo.
          </p>
          <button type="button" className={styles.primary} onClick={() => setCreating(true)}>
            Write your first plugin
          </button>
        </div>
      ) : <>
        <div className={styles.tabs} role="tablist" aria-label="Plugins">
          {extensions.map((extension) => <button key={extension.id} type="button" role="tab"
            aria-selected={extension.id === current?.id} className={styles.tab}
            onClick={() => { onSelect(extension.id); setStatus('idle'); setFailure(undefined); }}
            data-testid={'plugin-tab-' + extension.id}>
            <span className={extension.error ? styles.dotFailed : extension.mountedAt ? styles.dotLive : styles.dotIdle} aria-hidden="true" />
            <span className={styles.tabName}>{extension.name}</span>
          </button>)}
        </div>

        <div className={styles.code}>
          {current && <Suspense fallback={<div className={styles.codeFallback}>Loading the editor…</div>}>
            <PluginEditor key={current.id} value={source} label={`Source of ${current.name}`}
              onChange={(value) => setDrafts((drafts) => ({ ...drafts, [current.id]: value }))}
              onSave={() => { void save(); }} />
          </Suspense>}
        </div>

        <footer className={styles.footer}>
          <div className={styles.facts}>
            <span className={styles.fact}>
              <span className={styles.factLabel}>tools</span>
              {mine.length === 0
                ? <span className={styles.factEmpty}>none</span>
                : mine.map(({ name: tool }) => <code key={tool} className={styles.tool}>{tool}</code>)}
            </span>
            <span className={styles.fact}>
              <span className={styles.factLabel}>mounted</span>
              <span className={styles.factValue}>{current ? mountedAt(current) : '—'}</span>
            </span>
            <span className={styles.fact}>
              <span className={styles.factLabel}>revision</span>
              <span className={styles.factValue}>{current?.revision ?? '—'}</span>
            </span>
          </div>
          <div className={styles.actions}>
            {status === 'saved' && <span key={sweep} className={styles.saved} data-testid="saved">mounted</span>}
            {status === 'saving' && <span className={styles.saved}>saving…</span>}
            <button type="button" className={styles.danger} onClick={() => { void remove(); }} disabled={busy}
              aria-label={`Delete ${current?.name ?? 'plugin'}`}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
            <button type="button" className={styles.save} onClick={() => { void save(); }} disabled={busy || !current}
              data-testid="save-plugin">
              {dirty ? 'Save' : 'Saved'}
              <kbd className={styles.kbd}>⌘S</kbd>
            </button>
          </div>
        </footer>

        {(failure || current?.error) && <p className={styles.failure} role="alert" data-testid="plugin-error">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{failure ?? current?.error}</span>
        </p>}
      </>}
      </div>
      {status === 'saved' && <span key={'sweep-' + sweep} className={styles.sweep} aria-hidden="true" />}
    </aside>
  );
}

/**
 * The tools the model is offered on its next request. Plugin tools are named, built-ins are counted,
 * and the list opens upward from its trigger so a screenshot can show the whole surface at once.
 */
export function CapabilityStrip({ tools, onOpen, plugins }: { tools: LiveTool[]; onOpen: () => void; plugins: number }) {
  const [list, setList] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const authored = tools.filter(({ extensionId }) => extensionId);
  const builtin = tools.length - authored.length;

  useEffect(() => {
    if (!list) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setList(false); } };
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setList(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [list]);

  return (
    <div className={styles.stripWrap} ref={wrap}>
      <div className={styles.strip} data-testid="capability-strip">
        <button type="button" className={styles.stripButton} onClick={() => setList((value) => !value)}
          aria-expanded={list} aria-haspopup="dialog" data-testid="open-tools">
          <CircleDot size={11} aria-hidden="true" />
          <span className={styles.stripLabel}>tools</span>
        </button>
        {authored.length === 0
          ? <span className={styles.stripMuted}>{plugins === 0 ? 'no plugins yet' : 'no plugin tools loaded'}</span>
          : authored.map(({ name, extensionId }) => <button key={name} type="button" className={styles.chip}
            onClick={onOpen} title={`Provided by ${extensionId}`} data-testid={'live-tool-' + name}>
            {name}
          </button>)}
        <span className={styles.stripCount}>{builtin} built in</span>
      </div>
      {list && (
        <div className={styles.toolList} role="dialog" aria-label="Tools the agent can use" data-testid="tool-list">
          <p className={styles.toolListHead}>
            <span>agent tools</span>
            <span className={styles.toolListCount}>{tools.length}</span>
          </p>
          <ul className={styles.toolListBody}>
            {tools.map((tool) => <li key={tool.name} className={styles.toolRow}>
              <code className={tool.extensionId ? styles.toolOwned : styles.toolBuiltin}>{tool.name}</code>
              <span className={styles.toolWhere}>{tool.extensionId ? 'plugin/' + tool.extensionId : 'built in'}</span>
              <span className={styles.toolDescription}>{tool.description}</span>
            </li>)}
          </ul>
          <p className={styles.toolListFoot}>The model is offered these on its next request.</p>
        </div>
      )}
    </div>
  );
}
