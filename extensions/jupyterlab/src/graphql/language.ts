/**
 * CM6 GraphQL LanguageSupport with syntax highlighting, bracket closing,
 * indentation, and bracket matching.
 */
import {
  LanguageSupport,
  StreamLanguage,
  StringStream,
  indentUnit,
} from '@codemirror/language';
import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { bracketMatching } from '@codemirror/language';
import { EditorState, Extension, Prec } from '@codemirror/state';
import { keymap, hoverTooltip } from '@codemirror/view';
import { indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
import { graphqlCompletionSource } from './completion';
import { graphqlHoverSource } from './hover';
import { graphqlLinter } from './diagnostics';

interface GraphQLState {
  inString: boolean;
  inComment: boolean;
  afterColon: boolean;
}

const graphqlStreamParser = StreamLanguage.define<GraphQLState>({
  startState(): GraphQLState {
    return { inString: false, inComment: false, afterColon: false };
  },
  token(stream: StringStream, state: GraphQLState): string | null {
    if (stream.eatSpace()) return null;

    // Comments
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }

    // Block strings (triple-quoted)
    if (stream.match('"""')) {
      while (!stream.eol()) {
        if (stream.match('"""')) return 'string';
        stream.next();
      }
      return 'string';
    }

    // Strings
    if (stream.match('"')) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '"') break;
        if (ch === '\\') stream.next();
      }
      return 'string';
    }

    // Spread operator (must be before punctuation)
    if (stream.match('...')) {
      return 'punctuation';
    }

    // Directives
    if (stream.match(/@[a-zA-Z_]\w*/)) {
      return 'meta';
    }

    // Variables
    if (stream.match(/\$[a-zA-Z_]\w*/)) {
      return 'variableName.special';
    }

    // Numbers
    if (stream.match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/)) {
      return 'number';
    }

    // Punctuation
    if (stream.match(/[{}()\[\]:!=,|&]/)) {
      const ch = stream.current();
      if (ch === ':') state.afterColon = true;
      else state.afterColon = false;
      return 'punctuation';
    }

    // Identifiers and keywords
    if (stream.match(/[a-zA-Z_]\w*/)) {
      const word = stream.current();
      const keywords = [
        'query', 'mutation', 'subscription', 'fragment', 'on',
        'true', 'false', 'null',
        'type', 'input', 'enum', 'union', 'interface', 'scalar',
        'extend', 'implements', 'directive', 'schema',
      ];
      if (keywords.includes(word)) {
        state.afterColon = false;
        return 'keyword';
      }
      if (state.afterColon) {
        state.afterColon = false;
        return 'typeName';
      }
      state.afterColon = false;
      return 'propertyName';
    }

    stream.next();
    return null;
  },
});

/**
 * Returns the GraphQL language support with editor extensions:
 * - Syntax highlighting
 * - Auto-close brackets: { }, ( ), [ ], " "
 * - Bracket matching
 * - 2-space indentation
 */
/**
 * Custom Enter key handler that increases indentation after { and (.
 */
function graphqlNewlineAndIndent({ state, dispatch }: { state: EditorState; dispatch: (tr: any) => void }): boolean {
  const { head } = state.selection.main;
  const line = state.doc.lineAt(head);
  const textBefore = state.doc.sliceString(line.from, head);

  // Get current line's indentation
  const indent = textBefore.match(/^(\s*)/)?.[1] || '';
  const charBefore = head > 0 ? state.doc.sliceString(head - 1, head) : '';
  const charAfter = head < state.doc.length ? state.doc.sliceString(head, head + 1) : '';

  // If cursor is between { } or ( ), add extra indentation and closing line
  if ((charBefore === '{' && charAfter === '}') || (charBefore === '(' && charAfter === ')')) {
    const newIndent = indent + '  ';
    const insert = '\n' + newIndent + '\n' + indent;
    dispatch(state.update({
      changes: { from: head, to: head, insert },
      selection: { anchor: head + 1 + newIndent.length },
    }));
    return true;
  }

  // If line ends with { or (, increase indent
  if (charBefore === '{' || charBefore === '(') {
    const newIndent = indent + '  ';
    dispatch(state.update({
      changes: { from: head, to: head, insert: '\n' + newIndent },
      selection: { anchor: head + 1 + newIndent.length },
    }));
    return true;
  }

  return false;
}

export function graphqlLanguage(): LanguageSupport {
  const extensions: Extension[] = [
    closeBrackets(),
    bracketMatching(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    Prec.high(keymap.of([
      { key: 'Enter', run: graphqlNewlineAndIndent },
    ])),
    keymap.of([indentWithTab]),
    autocompletion({
      override: [graphqlCompletionSource],
      activateOnTyping: true,
      interactionDelay: 500,
      defaultKeymap: true,
    }),
    hoverTooltip(graphqlHoverSource, { hoverTime: 300 }),
    graphqlLinter,
  ];
  return new LanguageSupport(graphqlStreamParser, extensions);
}
