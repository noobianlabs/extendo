import { unifiedMergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useLayoutEffect, useRef } from 'react';
import styles from './chat.module.css';

export interface FileDiff {
  path: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  summary?: string;
}

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)', fontSize: '0.75rem' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-content': { outline: '1px solid var(--ring)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', maxHeight: '19rem' },
  '.cm-content': { padding: '0.25rem 0' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted-1)', borderRight: '0.5px solid var(--border-2)' },
  '.cm-deletedChunk': { backgroundColor: 'color-mix(in srgb, var(--destructive) 10%, var(--bg))' },
  '.cm-deletedChunk .cm-deletedText': { background: 'color-mix(in srgb, var(--destructive) 20%, var(--bg))' },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--success) 10%, var(--bg))' },
  '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--success) 20%, var(--bg))' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--success)' },
  '&.cm-merge-b .cm-deletedLineGutter': { background: 'var(--destructive)' },
});

export default function DiffView({ diff }: { diff: FileDiff }) {
  const mount = useRef<HTMLDivElement>(null);
  const { path, before, after } = diff;

  useLayoutEffect(() => {
    if (!mount.current) return;
    const view = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: after,
        extensions: [
          theme, lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `Changes to ${path}` }),
          unifiedMergeView({ original: before, mergeControls: false, gutter: true, highlightChanges: true }),
        ],
      }),
    });
    return () => view.destroy();
  }, [after, before, path]);

  return <div ref={mount} className={styles.diffView} dir="ltr" />;
}
