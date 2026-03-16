/**
 * GraphQL language mode for CodeMirror 6.
 *
 * Provides syntax highlighting, bracket matching, auto-close brackets,
 * and indentation rules for GraphQL documents in JupyterLab notebooks.
 *
 * This is a lightweight, self-contained implementation that does not
 * depend on external grammar packages. It covers the GraphQL spec:
 * keywords, types, strings, comments, directives, and variables.
 *
 * Usage:
 *   import { graphqlLanguage } from './graphql/language.js';
 *   const ext = graphqlLanguage();
 */

import {
  LanguageSupport,
  StreamLanguage,
  type StringStream,
  indentOnInput,
} from '@codemirror/language';
import { closeBrackets } from '@codemirror/autocomplete';
import { bracketMatching } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/** GraphQL keywords recognized by the highlighter. */
const KEYWORDS = new Set([
  'query',
  'mutation',
  'subscription',
  'fragment',
  'on',
  'type',
  'interface',
  'union',
  'enum',
  'input',
  'extend',
  'implements',
  'scalar',
  'schema',
  'directive',
  'repeatable',
  'true',
  'false',
  'null',
]);

/** Built-in GraphQL types. */
const BUILTIN_TYPES = new Set([
  'Int',
  'Float',
  'String',
  'Boolean',
  'ID',
]);

/**
 * StreamLanguage definition for GraphQL.
 *
 * Tokenizes GraphQL documents into the following token types:
 *   - keyword: language keywords (query, mutation, type, etc.)
 *   - typeName: built-in scalar types and capitalized identifiers
 *   - string: string literals (single-line and block strings)
 *   - comment: line comments (# ...)
 *   - variableName: variable references ($name)
 *   - meta: directives (@name)
 *   - number: integer and float literals
 *   - punctuation: structural characters ({ } ( ) [ ] : ! = | ...)
 *   - operator: spread operator (...)
 */
const graphqlStreamLanguage = StreamLanguage.define({
  name: 'graphql',

  startState() {
    return {
      inBlockString: false,
    };
  },

  token(stream: StringStream, state: { inBlockString: boolean }): string | null {
    // Block string continuation.
    if (state.inBlockString) {
      if (stream.match('"""')) {
        state.inBlockString = false;
        return 'string';
      }
      // Consume characters until we find """ or end of line.
      while (!stream.eol()) {
        if (stream.match('"""', false)) break;
        stream.next();
      }
      return 'string';
    }

    // Skip whitespace.
    if (stream.eatSpace()) return null;

    // Line comment.
    if (stream.match('#')) {
      stream.skipToEnd();
      return 'comment';
    }

    // Block string start.
    if (stream.match('"""')) {
      state.inBlockString = true;
      return 'string';
    }

    // Regular string.
    if (stream.match('"')) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') {
          stream.next(); // Skip escaped character.
        } else if (ch === '"') {
          break;
        }
      }
      return 'string';
    }

    // Spread operator.
    if (stream.match('...')) {
      return 'operator';
    }

    // Variable reference ($name).
    if (stream.match(/^\$[a-zA-Z_]\w*/)) {
      return 'variableName';
    }

    // Directive (@name).
    if (stream.match(/^@[a-zA-Z_]\w*/)) {
      return 'meta';
    }

    // Number (integer or float).
    if (stream.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)) {
      return 'number';
    }

    // Identifier or keyword.
    if (stream.match(/^[a-zA-Z_]\w*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return 'keyword';
      if (BUILTIN_TYPES.has(word)) return 'typeName';
      // Capitalized names are likely type references.
      if (word[0] === word[0].toUpperCase() && word[0] !== '_') return 'typeName';
      return 'variableName';
    }

    // Punctuation.
    const ch = stream.next();
    if (ch && '{}()[]!:=|&'.includes(ch)) {
      return 'punctuation';
    }

    return null;
  },

  indent(state: { inBlockString: boolean }, textAfter: string, context: any) {
    if (state.inBlockString) return -1; // No auto-indent inside block strings.

    const unit: number = context.unit ?? 2;

    // Decrease indent for closing braces/parens.
    if (/^\s*[}\)]/.test(textAfter)) {
      const cur = context.lineIndent(context.pos, -1);
      return Math.max(0, cur - unit);
    }

    // Check if the previous line ends with { or (.
    if (context.pos > 0) {
      const prevLine = context.state.doc.lineAt(Math.max(0, context.pos - 1));
      const prevText: string = prevLine.text.trimEnd();
      if (prevText.endsWith('{') || prevText.endsWith('(')) {
        return context.lineIndent(prevLine.from, -1) + unit;
      }
    }

    return -1; // Use default.
  },

  languageData: {
    commentTokens: { line: '#' },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
});

/**
 * Creates a CodeMirror 6 extension providing full GraphQL language support.
 *
 * Includes:
 * - Syntax highlighting via stream parser
 * - Bracket matching (highlight matching {} () [])
 * - Auto-close brackets and quotes
 * - Indent-on-input (auto-dedent on } and ))
 *
 * @returns A CodeMirror Extension array.
 */
export function graphqlLanguage(): Extension {
  return [
    new LanguageSupport(graphqlStreamLanguage, []),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
  ];
}
