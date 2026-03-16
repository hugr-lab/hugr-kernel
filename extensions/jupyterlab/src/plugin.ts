/**
 * JupyterLab plugin registration.
 */
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILabShell,
} from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';
import { autocompletion } from '@codemirror/autocomplete';
import { hoverTooltip } from '@codemirror/view';

import { ConnectionManagerWidget } from './connectionManager';
import { CommClient } from './commClient';
import { LogicalExplorerWidget } from './explorer/logicalExplorer';
import { SchemaExplorerWidget } from './explorer/schemaExplorer';
import { DetailModal } from './explorer/detailModal';
import { graphqlLanguage } from './graphql/language';
import { graphqlCompletionSource, setCompletionSessionContext } from './graphql/completion';
import { graphqlHoverSource, setHoverSessionContext } from './graphql/hover';
import { graphqlLinter } from './graphql/diagnostics';
import { registerFormattingCommand } from './graphql/formatting';

const connectionManagerPlugin: JupyterFrontEndPlugin<void> = {
  id: '@hugr-lab/jupyterlab-graphql-ide:connection-manager',
  autoStart: true,
  activate: (app: JupyterFrontEnd) => {
    const widget = new ConnectionManagerWidget();
    app.shell.add(widget, 'left', { rank: 200 });
  },
};

const explorerPlugin: JupyterFrontEndPlugin<void> = {
  id: '@hugr-lab/jupyterlab-graphql-ide:explorer',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, notebooks: INotebookTracker) => {
    const commClient = new CommClient();
    const catalogExplorer = new LogicalExplorerWidget(commClient);
    const schemaExplorer = new SchemaExplorerWidget(commClient);
    const detailModal = new DetailModal(commClient);

    app.shell.add(catalogExplorer, 'right', { rank: 100 });
    app.shell.add(schemaExplorer, 'right', { rank: 101 });

    // Connect to kernel when notebook changes
    notebooks.currentChanged.connect(async (_, notebook) => {
      if (notebook?.sessionContext?.session?.kernel) {
        await commClient.connect(notebook.sessionContext.session.kernel);
        catalogExplorer.refresh();
        schemaExplorer.refresh();
      }
    });

    // Handle detail clicks
    catalogExplorer.node.addEventListener('hugr-node-click', async (e: any) => {
      const nodeId = e.detail?.nodeId;
      if (nodeId) {
        await detailModal.showDetail(nodeId);
        app.shell.add(detailModal, 'main');
        app.shell.activateById(detailModal.id);
      }
    });
  },
};

const editorPlugin: JupyterFrontEndPlugin<void> = {
  id: '@hugr-lab/jupyterlab-graphql-ide:editor',
  autoStart: true,
  requires: [INotebookTracker, IEditorLanguageRegistry],
  activate: (
    app: JupyterFrontEnd,
    notebooks: INotebookTracker,
    languages: IEditorLanguageRegistry,
  ) => {
    // Register GraphQL language
    languages.addLanguage({
      name: 'graphql',
      mime: 'application/graphql',
      load: async () => graphqlLanguage(),
    });

    // Track active notebook for completion/hover context
    notebooks.currentChanged.connect((_, notebook) => {
      const ctx = notebook?.sessionContext ?? null;
      setCompletionSessionContext(ctx);
      setHoverSessionContext(ctx);
    });

    // Register formatting command
    registerFormattingCommand(app);
  },
};

export default [connectionManagerPlugin, explorerPlugin, editorPlugin];
