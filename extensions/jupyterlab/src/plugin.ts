/**
 * JupyterLab plugins for the Hugr GraphQL IDE.
 *
 * Two plugins:
 * 1. Editor UX — syntax highlighting, completion, hover, diagnostics, formatting
 * 2. Explorer — sidebar widgets for connections + schema exploration
 *
 * All kernel communication uses Jupyter comm protocol (no HTTP/CORS).
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
} from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { StateEffect } from '@codemirror/state';
import { CommClient } from './commClient.js';
import { HugrConnectionManager } from './connectionManager.js';
import { HugrSchemaExplorer } from './explorer/schemaExplorer.js';
import { graphqlLanguage } from './graphql/language.js';
import { createCompletionProvider } from './graphql/completion.js';
import { createHoverExtension } from './graphql/hover.js';
import { createDiagnosticsExtension } from './graphql/diagnostics.js';
import { registerFormatCommand } from './graphql/formatting.js';

// ---- Shared state ----

let activeCommClient: CommClient | null = null;

// ---- Plugin 1: Editor UX (direct CM6 injection) ----

const editorPlugin: JupyterFrontEndPlugin<void> = {
  id: '@hugr-lab/graphql-ide:editor',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
  ) => {
    console.log('[hugr-graphql-ide] editor plugin activating');

    const injected = new WeakSet<object>();

    const getKernel = (): any => {
      const panel = notebookTracker.currentWidget;
      return panel?.sessionContext?.session?.kernel ?? null;
    };

    const isHugrNotebook = (panel: any): boolean => {
      // Check kernel preference name
      const prefName = panel?.sessionContext?.kernelPreference?.name;
      if (prefName === 'hugr') return true;
      // Check running kernel name
      const kernelName = panel?.sessionContext?.session?.kernel?.name;
      if (kernelName === 'hugr') return true;
      // Check notebook metadata
      try {
        const meta = panel?.model?.metadata;
        if (meta) {
          // JupyterLab 4 API
          const ks = typeof meta.get === 'function' ? meta.get('kernelspec') : (meta as any)['kernelspec'];
          if (ks && (ks as any)?.name === 'hugr') return true;
        }
      } catch { /* ignore */ }
      return false;
    };

    const injectIntoCell = (cell: any) => {
      if (!cell || cell.model?.type !== 'code') return;
      const editor = (cell as any).editor;
      if (!editor) return;
      const cm = (editor as any).editor; // CM6 EditorView
      if (!cm || injected.has(cm)) return;

      try {
        cm.dispatch({
          effects: StateEffect.appendConfig.of([
            graphqlLanguage(),
            createCompletionProvider(getKernel),
            createHoverExtension(getKernel),
            createDiagnosticsExtension(),
          ]),
        });
        injected.add(cm);
      } catch (e) {
        console.warn('[hugr-graphql-ide] CM6 injection failed:', e);
      }
    };

    const injectAll = (panel: any) => {
      if (!isHugrNotebook(panel)) return;
      if (!panel?.content?.widgets) return;
      for (const cell of panel.content.widgets) {
        injectIntoCell(cell);
      }
    };

    // Track notebooks and inject extensions
    notebookTracker.widgetAdded.connect((_sender: any, panel: any) => {
      const tryInject = () => injectAll(panel);

      // Multiple timing strategies — cells may not have editors immediately
      setTimeout(tryInject, 200);
      setTimeout(tryInject, 1000);
      setTimeout(tryInject, 3000);

      // When new cells are added
      try {
        panel.content.model?.cells?.changed?.connect(() => {
          setTimeout(tryInject, 200);
        });
      } catch { /* ignore if API differs */ }

      // When kernel starts or restarts
      panel.sessionContext.statusChanged.connect(() => {
        setTimeout(tryInject, 300);
      });
    });

    // Re-inject when switching between notebooks
    notebookTracker.currentChanged.connect(() => {
      const panel = notebookTracker.currentWidget;
      if (panel) {
        setTimeout(() => injectAll(panel), 200);
      }
    });

    // Format command
    registerFormatCommand(app as any, notebookTracker as any);

    console.log('[hugr-graphql-ide] editor plugin activated');
  },
};

// ---- Plugin 2: Connection Manager + Schema Explorer ----

const explorerPlugin: JupyterFrontEndPlugin<void> = {
  id: '@hugr-lab/graphql-ide:explorer',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ILayoutRestorer],
  activate: (
    app: JupyterFrontEnd,
    notebookTracker: INotebookTracker,
    restorer: ILayoutRestorer | null,
  ) => {
    console.log('[hugr-graphql-ide] explorer plugin activating');

    // ---- Sidebar widgets ----
    const connectionManager = new HugrConnectionManager();
    const schemaExplorer = new HugrSchemaExplorer();

    // Connection manager on LEFT sidebar
    app.shell.add(connectionManager, 'left', { rank: 200 });
    // Schema explorer on RIGHT sidebar
    app.shell.add(schemaExplorer, 'right', { rank: 900 });

    if (restorer) {
      void restorer.add(connectionManager, 'hugr-connection-manager');
      void restorer.add(schemaExplorer, 'hugr-schema-explorer');
    }

    // ---- Comm-based kernel discovery ----
    let connectedKernelId: string | null = null;
    let isConnecting = false;

    const setupKernel = async (kernel: any) => {
      if (!kernel) return;

      const kernelId = kernel.id as string;

      // Already connected to this kernel — skip
      if (kernelId === connectedKernelId && activeCommClient) return;

      // Prevent re-entrant calls while connecting
      if (isConnecting) return;
      isConnecting = true;

      // Close previous comm
      if (activeCommClient) {
        activeCommClient.close();
        activeCommClient = null;
        connectedKernelId = null;
      }

      try {
        const client = new CommClient(kernel);
        await client.open();
        activeCommClient = client;
        connectedKernelId = kernelId;

        // Wire connection change notifications to refresh explorers
        client.setOnConnectionsChanged(() => {
          void schemaExplorer.refresh();
        });

        connectionManager.setClient(client);
        schemaExplorer.setClient(client);

        console.log('[hugr-graphql-ide] comm client connected to kernel', kernelId);
      } catch (err) {
        console.warn('[hugr-graphql-ide] failed to open comm:', err);
        connectedKernelId = null;
      } finally {
        isConnecting = false;
      }
    };

    const clearKernel = () => {
      if (activeCommClient) {
        activeCommClient.close();
        activeCommClient = null;
      }
      connectedKernelId = null;
      isConnecting = false;
      connectionManager.setClient(null);
      schemaExplorer.setClient(null);
    };

    // Discover kernel via statusChanged
    const tryDiscover = () => {
      const panel = notebookTracker.currentWidget;
      if (!panel) return;

      const kernel = panel.sessionContext?.session?.kernel;
      if (kernel) {
        void setupKernel(kernel);
      } else {
        clearKernel();
      }
    };

    notebookTracker.currentChanged.connect(() => tryDiscover());
    notebookTracker.widgetAdded.connect((_sender: any, panel: any) => {
      const onStatusChanged = () => tryDiscover();
      panel.sessionContext.statusChanged.connect(onStatusChanged);
      panel.disposed.connect(() => {
        panel.sessionContext.statusChanged.disconnect(onStatusChanged);
      });
    });

    console.log('[hugr-graphql-ide] explorer plugin activated');
  },
};

export default [editorPlugin, explorerPlugin];
