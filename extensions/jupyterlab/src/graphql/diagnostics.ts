/**
 * CM6 linter for GraphQL syntax errors (no schema validation).
 * Uses prettier's built-in GraphQL parser to detect parse errors.
 */
import { Diagnostic as CMDiagnostic, linter } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import * as prettier from 'prettier/standalone';
import * as graphqlPlugin from 'prettier/plugins/graphql';

export const graphqlLinter = linter(async (view: EditorView): Promise<CMDiagnostic[]> => {
  const code = view.state.doc.toString().trim();
  if (!code || code.startsWith(':')) return [];

  try {
    await prettier.format(code, {
      parser: 'graphql',
      plugins: [graphqlPlugin],
    });
    return [];
  } catch (e: any) {
    // prettier wraps graphql-js SyntaxError with loc info
    const loc = e.loc?.start || e.loc;
    if (loc && loc.line && loc.column) {
      const lineNum = Math.min(loc.line, view.state.doc.lines);
      const line = view.state.doc.line(lineNum);
      const col = Math.min(loc.column - 1, line.length);
      const from = line.from + col;
      const to = Math.min(from + 1, line.to);

      // Extract just the first meaningful line from error message
      const msg = extractMessage(e.message);

      return [{
        from,
        to,
        severity: 'error',
        message: msg,
        source: 'graphql',
      }];
    }
    return [];
  }
}, { delay: 500 });

function extractMessage(raw: string): string {
  // prettier errors look like: "Syntax Error: Expected Name, found }.\n\nGraphQL request:4:5\n..."
  // Extract just the "Syntax Error: ..." part
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.startsWith('Syntax Error')) return line;
    if (line.startsWith('Expected')) return line;
  }
  return lines[0] || 'Syntax error';
}
