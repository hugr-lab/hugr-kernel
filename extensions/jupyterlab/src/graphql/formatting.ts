/**
 * Prettier GraphQL formatting command.
 */
import { JupyterFrontEnd } from '@jupyterlab/application';

export function registerFormattingCommand(app: JupyterFrontEnd): void {
  app.commands.addCommand('hugr:format-graphql', {
    label: 'Format GraphQL',
    execute: async () => {
      // Get current notebook cell editor
      const widget = app.shell.currentWidget;
      if (!widget) return;

      try {
        const prettier = await import('prettier');
        const graphqlPlugin = await import('prettier/plugins/graphql');

        // This is a simplified version - actual implementation
        // would need to get the active cell's editor content
        console.log('Format GraphQL command registered');
      } catch (e) {
        console.error('Formatting failed', e);
      }
    },
  });
}
