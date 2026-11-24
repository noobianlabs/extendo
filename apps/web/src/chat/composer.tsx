import { ArrowUp, ChevronDown, CircleAlert, Paperclip, Square, SquareSlash } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, FormEvent } from 'react';
import styles from './chat.module.css';

const LIMIT = 128_000;

interface ComposerProps {
  running: boolean;
  steering: boolean;
  waiting: boolean;
  loading: boolean;
  needsProvider: boolean;
  connected: boolean;
  providerLabel: string;
  suggestion?: { text: string };
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}

export function Composer({
  running, steering, waiting, loading, needsProvider, connected, providerLabel, suggestion, onSend, onCancel, onOpenSettings, onOpenPalette,
}: ComposerProps) {
  const text = useRef('');
  const composing = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const moveCaret = useRef(false);
  const dragDepth = useRef(0);
  const inFlight = useRef(false);
  const reading = useRef(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState('');
  const label = providerLabel.trim() || 'Provider';
  const canSend = (!running || steering) && !loading && !needsProvider && connected && !sending && !attaching && Boolean(draft.trim());

  function updateDraft(value: string) {
    text.current = value;
    setDraft(value);
  }

  useLayoutEffect(() => {
    if (!suggestion) return;
    const current = text.current;
    const next = current && current !== suggestion.text ? `${current}\n\n${suggestion.text}` : suggestion.text;
    if (next.length > LIMIT) {
      setLocalError('This suggestion won’t fit in the message.');
    } else {
      moveCaret.current = next !== current;
      updateDraft(next);
      setLocalError('');
    }
    textarea.current?.focus({ preventScroll: true });
  }, [suggestion]);

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    if (moveCaret.current && text.current === draft) {
      moveCaret.current = false;
      field.setSelectionRange(draft.length, draft.length);
      field.scrollTop = field.scrollHeight;
    }
    if (!CSS.supports('field-sizing', 'content')) {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    }
  }, [draft]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend || composing.current || inFlight.current || reading.current) return;
    const submitted = text.current;
    if (!submitted.trim()) return;
    inFlight.current = true;
    setSending(true);
    setLocalError('');
    textarea.current?.focus({ preventScroll: true });
    try {
      await onSend(submitted.trim());
      if (text.current === submitted) updateDraft('');
    } catch {
      setLocalError('Couldn’t send the message. Your draft is still here.');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  async function attach(files: FileList | File[]) {
    if (!files.length || reading.current) return;
    const file = files[0];
    if (files.length !== 1 || !file) {
      setLocalError('Attach one text file at a time.');
      return;
    }
    setLocalError('');
    if (file.size > LIMIT * 4) {
      setLocalError('This file won’t fit in the message.');
      return;
    }
    reading.current = true;
    setAttaching(true);
    try {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(contents)) {
        setLocalError('Only plain-text files can be attached.');
        return;
      }
      const name = file.name.replace(/[\r\n]/g, ' ');
      const next = `${text.current}${text.current ? '\n\n' : ''}File: ${name}\n${contents}`;
      if (next.length > LIMIT) {
        setLocalError('This file would take the message over 128,000 characters.');
        return;
      }
      moveCaret.current = true;
      updateDraft(next);
      textarea.current?.focus({ preventScroll: true });
    } catch {
      setLocalError('Couldn’t read this file as UTF-8 text.');
    } finally {
      reading.current = false;
      setAttaching(false);
    }
  }

  function dragFiles(event: DragEvent<HTMLFormElement>) {
    return event.dataTransfer.types.includes('Files');
  }

  const hint = loading ? 'Opening session…' : !connected ? 'Disconnected' : waiting ? 'Waiting for approval'
    : steering ? 'Send to steer this run' : sending ? 'Sending…' : attaching ? 'Reading file…' : '';

  return (
    <div className={styles.composeDock}>
      <form
        className={styles.composer}
        aria-label="Compose a message"
        onSubmit={event => void submit(event)}
        onDragEnter={event => {
          if (!dragFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={event => {
          if (!dragFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={event => {
          if (!dragDepth.current) return;
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={event => {
          if (!dragFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void attach(event.dataTransfer.files);
        }}
      >
        <textarea
          ref={textarea}
          className={styles.textarea}
          aria-label="Message"
          dir="auto"
          rows={1}
          maxLength={LIMIT}
          value={draft}
          placeholder={needsProvider ? 'Draft a message…' : steering ? 'Steer Extendo while it works…' : 'Message Extendo…'}
          onChange={event => {
            updateDraft(event.currentTarget.value);
            if (localError) setLocalError('');
          }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey ||
              event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
            event.preventDefault();
            if (canSend && !event.repeat) event.currentTarget.form?.requestSubmit();
          }}
        />
        <div className={styles.composerTools}>
          <button type="button" className={styles.provider} onClick={onOpenSettings} title={label} aria-label={`Provider settings: ${label}`}>
            <span dir="auto">{label}</span><ChevronDown size={13} aria-hidden="true" />
          </button>
          <button type="button" className={styles.iconButton} disabled={attaching} title="Attach a text file" aria-label="Attach a text file" onClick={() => picker.current?.click()}>
            <Paperclip size={15} aria-hidden="true" />
          </button>
          <button type="button" className={styles.iconButton} title="Open command palette" aria-label="Open command palette" onClick={onOpenPalette}>
            <SquareSlash size={15} aria-hidden="true" />
          </button>
          <input
            type="file"
            ref={picker}
            hidden
            accept="text/*,application/json,application/xml,.md,.mdx,.log,.txt,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.yaml,.yml,.toml,.sh"
            onChange={event => {
              if (event.currentTarget.files) void attach(Array.from(event.currentTarget.files));
              event.currentTarget.value = '';
            }}
          />
          <div className={styles.sendControl}>
            {hint && <span role="status" className={styles.composeStatus}>{hint}</span>}
            {running && (
              <button type="button" className={styles.stop} disabled={!connected} onClick={onCancel}
                title={waiting ? 'Cancel the turn and its approval' : 'Stop response'} aria-label="Stop response">
                <Square size={12} fill="currentColor" aria-hidden="true" />
              </button>
            )}
            <button type="submit" className={styles.send} disabled={!canSend}
              title={steering ? 'Steer this run (Enter)' : 'Send message (Enter)'} aria-label={steering ? 'Steer this run' : 'Send message'}>
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
        {dragging && <div className={styles.dropTarget} aria-hidden="true"><Paperclip size={16} /> Drop to attach as text</div>}
      </form>
      {localError ? (
        <div className={styles.localError} role="alert"><CircleAlert size={13} aria-hidden="true" /> {localError}</div>
      ) : (
        <div className={styles.composeFoot}>
          {draft.length >= LIMIT ? 'Message limit reached' : <><kbd>Enter</kbd> to {steering ? 'steer' : 'send'} <span aria-hidden="true">·</span> <kbd>Shift + Enter</kbd> for a new line</>}
        </div>
      )}
    </div>
  );
}
