import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useLayoutEffect, useRef } from 'react';
import styles from './workshop.module.css';

/**
 * Code carries one accent and four steps of the neutral ramp, nothing else: a keyword is the only
 * coloured token in a plugin, which keeps the editor in the same palette as the rest of the app.
 */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword], color: 'var(--accent)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--text)', opacity: 0.82 },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--muted-3)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--muted-1)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--muted-1)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--text)', fontWeight: '550' },
  { tag: [tags.typeName, tags.className], color: 'var(--text)', fontWeight: '550' },
  { tag: [tags.punctuation, tags.bracket, tags.operator], color: 'var(--muted-2)' },
  { tag: tags.invalid, color: 'var(--destructive)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)', height: '100%', fontSize: 'var(--type-caption)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { padding: '10px 0 24px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-3)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 3.5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-1)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)', outline: 'none' },
});

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  label: string;
}

export default function PluginEditor({ value, onChange, onSave, label }: EditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useLayoutEffect(() => {
    const parent = mount.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), history(), indentOnInput(), bracketMatching(), highlightActiveLine(),
          EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } },
            ...historyKeymap, ...defaultKeymap, indentWithTab,
          ]),
          javascript(),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => { editor.destroy(); view.current = undefined; };
  }, [label]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={mount} className={styles.editor} dir="ltr" data-testid="plugin-editor" />;
}
