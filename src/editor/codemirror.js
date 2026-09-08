import { basicSetup, EditorView } from 'codemirror';
import { indentWithTab, redo, undo } from '@codemirror/commands';
import { markdown, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--editor-ink)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    fontSize: '0.9rem',
    lineHeight: '1.75',
    padding: '1.8rem 0 5rem',
  },
  '.cm-content': {
    maxWidth: '860px',
    margin: '0 auto',
    padding: '0 3rem',
    caretColor: 'var(--editor-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--editor-faint)',
    border: '0',
    paddingLeft: '0.5rem',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--editor-selection) !important',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-accent)' },
  '.cm-panels': {
    backgroundColor: 'var(--editor-surface)',
    color: 'var(--editor-ink)',
    borderColor: 'var(--editor-border)',
    fontFamily: 'var(--sans)',
  },
  '.cm-search': { padding: '0.6rem 0.8rem' },
  '.cm-search input, .cm-search button': {
    font: 'inherit',
    color: 'var(--editor-ink)',
    background: 'var(--editor-surface)',
    border: '1px solid var(--editor-border)',
    borderRadius: '6px',
  },
  '.cm-tooltip': {
    border: '1px solid var(--editor-border)',
    backgroundColor: 'var(--editor-surface)',
    color: 'var(--editor-ink)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--editor-tint)',
    border: '0',
    color: 'var(--editor-muted)',
  },
});

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--editor-accent)', fontWeight: '700' },
  { tag: [tags.strong, tags.emphasis], color: 'var(--editor-ink)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--editor-accent)', textDecoration: 'underline' },
  { tag: [tags.monospace, tags.string], color: 'var(--editor-success)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--editor-faint)' },
  { tag: tags.comment, color: 'var(--editor-muted)', fontStyle: 'italic' },
  { tag: tags.contentSeparator, color: 'var(--editor-border-strong)' },
]);

function selectionText(view) {
  const range = view.state.selection.main;
  return view.state.doc.sliceString(range.from, range.to);
}

function replaceSelection(view, value, selectFrom, selectTo) {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: value },
    selection: EditorSelection.single(range.from + selectFrom, range.from + selectTo),
    scrollIntoView: true,
  });
  view.focus();
}

function wrap(view, before, after, placeholder = '') {
  const selected = selectionText(view) || placeholder;
  replaceSelection(view, `${before}${selected}${after}`, before.length, before.length + selected.length);
}

function insertBlock(view, value) {
  const range = view.state.selection.main;
  const doc = view.state.doc.toString();
  const before = doc.slice(0, range.from).endsWith('\n\n') || range.from === 0 ? '' : '\n\n';
  const after = doc.slice(range.to).startsWith('\n\n') || range.to === doc.length ? '' : '\n\n';
  replaceSelection(view, `${before}${value}${after}`, before.length, before.length + value.length);
}

function prefixLines(view, prefix, ordered = false) {
  const range = view.state.selection.main;
  const startLine = view.state.doc.lineAt(range.from);
  const endLine = view.state.doc.lineAt(range.to);
  const lines = [];
  for (let number = startLine.number; number <= endLine.number; number += 1) {
    lines.push(view.state.doc.line(number));
  }
  const alreadyPrefixed = lines.every((line) =>
    ordered ? /^\s*\d+\.\s/.test(line.text) : line.text.startsWith(prefix),
  );
  const changes = lines.map((line, index) => {
    if (alreadyPrefixed) {
      const match = ordered ? line.text.match(/^\s*\d+\.\s/) : [prefix];
      return { from: line.from, to: line.from + match[0].length, insert: '' };
    }
    return { from: line.from, insert: ordered ? `${index + 1}. ` : prefix };
  });
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
}

function setHeading(view, level) {
  const range = view.state.selection.main;
  const start = view.state.doc.lineAt(range.from).from;
  const end = view.state.doc.lineAt(range.to).to;
  const original = view.state.doc.sliceString(start, end);
  const marker = level ? `${'#'.repeat(level)} ` : '';
  const replacement = original.replace(/^#{1,6}\s*/gm, '').replace(/^/gm, marker);
  view.dispatch({ changes: { from: start, to: end, insert: replacement }, scrollIntoView: true });
  view.focus();
}

export function createMarkdownEditor(host, callbacks = {}) {
  let view;
  const format = (action) => {
    const handlers = {
      bold: () => wrap(view, '**', '**', 'bold text'),
      italic: () => wrap(view, '*', '*', 'italic text'),
      strike: () => wrap(view, '~~', '~~', 'strikethrough'),
      link: () => wrap(view, '[', '](https://)', 'link text'),
      inlineCode: () => wrap(view, '`', '`', 'code'),
      h1: () => setHeading(view, 1),
      h2: () => setHeading(view, 2),
      h3: () => setHeading(view, 3),
      paragraph: () => setHeading(view, 0),
      quote: () => prefixLines(view, '> '),
      bullet: () => prefixLines(view, '- '),
      ordered: () => prefixLines(view, '', true),
      checklist: () => prefixLines(view, '- [ ] '),
      codeblock: () => {
        const selected = selectionText(view) || 'code';
        insertBlock(view, `\`\`\`\n${selected}\n\`\`\``);
      },
      math: () => {
        const selected = selectionText(view);
        if (selected && !selected.includes('\n') && selected.length <= 60) wrap(view, '$', '$', 'x');
        else insertBlock(view, `$$\n${selected || 'E = mc^2'}\n$$`);
      },
      sidenote: () => wrap(view, '<Sidenote>', '</Sidenote>', 'Margin note'),
      footnote: () => {
        const id = `note-${Date.now().toString(36)}`;
        const selected = selectionText(view) || 'footnote';
        const range = view.state.selection.main;
        const marker = `[^${id}]`;
        const suffix = `${view.state.doc.length ? '\n\n' : ''}[^${id}]: ${selected}`;
        view.dispatch({
          changes: [
            { from: range.from, to: range.to, insert: marker },
            { from: view.state.doc.length, insert: suffix },
          ],
          selection: EditorSelection.single(range.from + marker.length),
          scrollIntoView: true,
        });
        view.focus();
      },
      table: () =>
        insertBlock(view, '| Column | Column |\n| --- | --- |\n| Value | Value |'),
      horizontalRule: () => insertBlock(view, '---'),
    };
    handlers[action]?.();
  };

  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        markdown(),
        syntaxHighlighting(markdownHighlight),
        editorTheme,
        EditorView.lineWrapping,
        Prec.high(keymap.of([
          indentWithTab,
          {
            key: '/',
            run(editor) {
              const range = editor.state.selection.main;
              const line = editor.state.doc.lineAt(range.from);
              const atEmptyLineStart = range.empty && !editor.state.doc.sliceString(line.from, range.from).trim();
              if (!atEmptyLineStart) return false;
              callbacks.onSlashCommand?.();
              return true;
            },
          },
          { key: 'Enter', run: insertNewlineContinueMarkup },
          { key: 'Mod-s', run: () => (callbacks.onSave?.(), true) },
          { key: 'Mod-b', run: () => (format('bold'), true) },
          { key: 'Mod-i', run: () => (format('italic'), true) },
          { key: 'Mod-Shift-7', run: () => (format('ordered'), true) },
          { key: 'Mod-Shift-8', run: () => (format('bullet'), true) },
        ])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.onChange?.(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            callbacks.onSelectionChange?.(selectionText(update.view));
          }
        }),
        EditorView.domEventHandlers({
          paste(event) {
            const files = [...(event.clipboardData?.files || [])];
            if (files.length && callbacks.onFiles?.(files, 'paste')) {
              event.preventDefault();
              return true;
            }
            const text = event.clipboardData?.getData('text/plain') || '';
            if (/^\s*<svg[\s>]/i.test(text) && text.includes('</svg>')) {
              callbacks.onSvgPaste?.(text);
              event.preventDefault();
              return true;
            }
            return false;
          },
          drop(event) {
            const files = [...(event.dataTransfer?.files || [])];
            if (files.length && callbacks.onFiles?.(files, 'drop')) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        }),
      ],
    }),
  });

  return {
    view,
    format,
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value || '' } });
    },
    focus: () => view.focus(),
    undo: () => undo(view),
    redo: () => redo(view),
    insertBlock: (value) => insertBlock(view, value),
    goToLine(lineNumber) {
      const safeLine = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
      const position = view.state.doc.line(safeLine).from;
      view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      view.focus();
    },
  };
}
