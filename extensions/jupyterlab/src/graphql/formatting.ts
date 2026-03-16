/**
 * GraphQL code formatting for JupyterLab.
 *
 * Uses prettier/standalone with the GraphQL plugin to format GraphQL source.
 * Prettier is loaded dynamically to avoid bloating the initial bundle.
 *
 * Also provides a JupyterLab command that formats the active cell's code
 * when the cell language is GraphQL.
 *
 * Usage:
 *   import { formatGraphQL } from './graphql/formatting.js';
 *   const formatted = await formatGraphQL(code);
 */

/**
 * Formats a GraphQL source string using prettier.
 *
 * Prettier and its GraphQL plugin are imported dynamically on first call
 * so they do not affect initial load time.
 *
 * @param code - The raw GraphQL source to format.
 * @returns The formatted source string.
 * @throws If prettier fails to parse the input (e.g. syntax error).
 */
export async function formatGraphQL(code: string): Promise<string> {
  // Dynamic imports — prettier ships its own types but bundlers may not
  // resolve the deep paths at compile time, so we cast through any.
  const [prettier, graphqlPlugin] = await Promise.all([
    import('prettier/standalone' as any),
    import('prettier/plugins/graphql' as any),
  ]) as [any, any];

  const formatted = await prettier.format(code, {
    parser: 'graphql',
    plugins: [graphqlPlugin.default ?? graphqlPlugin],
    // Sensible defaults for GraphQL formatting.
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
  });

  return formatted;
}

/**
 * Registers a "Format GraphQL" command with the JupyterLab application.
 *
 * The command reads the active cell's source, formats it with prettier,
 * and replaces the cell content. It only acts on cells whose language
 * metadata indicates GraphQL.
 *
 * @param app - The JupyterLab application instance.
 * @param notebookTracker - The notebook tracker to access the active cell.
 */
export function registerFormatCommand(
  app: { commands: { addCommand(id: string, opts: Record<string, unknown>): void } },
  notebookTracker: {
    currentWidget: {
      content: {
        activeCell: {
          model: {
            sharedModel: { source: string; setSource(s: string): void };
            metadata: { get(key: string): unknown };
          };
        } | null;
      };
    } | null;
  },
): void {
  const COMMAND_ID = 'hugr:format-graphql';

  app.commands.addCommand(COMMAND_ID, {
    label: 'Format GraphQL',
    caption: 'Format the active cell as GraphQL using prettier',
    isEnabled: () => {
      const cell = notebookTracker.currentWidget?.content.activeCell;
      if (!cell) return false;
      // Check cell language metadata.
      const lang = cell.model.metadata.get('language') as string | undefined;
      return lang === 'graphql' || lang === 'gql';
    },
    execute: async () => {
      const cell = notebookTracker.currentWidget?.content.activeCell;
      if (!cell) return;

      const source = cell.model.sharedModel.source;
      if (!source.trim()) return;

      try {
        const formatted = await formatGraphQL(source);
        cell.model.sharedModel.setSource(formatted);
      } catch (err) {
        console.warn('[hugr] GraphQL formatting failed:', err);
      }
    },
  });
}
