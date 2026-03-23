/**
 * JupyterLab plugin registration.
 */
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILabShell,
} from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ServerConnection } from '@jupyterlab/services';
import { IEditorLanguageRegistry } from '@jupyterlab/codemirror';
import { autocompletion } from '@codemirror/autocomplete';
import { hoverTooltip } from '@codemirror/view';

import { ConnectionManagerWidget } from './connectionManager';
import { HugrExplorerWidget } from './explorer/hugrExplorer';
import { SchemaTreeSection } from './explorer/schemaTree';
import { TypesSearchSection } from './explorer/typesSearch';
import { DirectivesListSection } from './explorer/directivesList';
import { showDetailModal } from './explorer/detailModal';
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
  activate: (app: JupyterFrontEnd) => {
    const explorer = new HugrExplorerWidget();
    app.shell.add(explorer, 'right', { rank: 100 });

    // Section widgets — created lazily after connections load
    let schemaTree: SchemaTreeSection | null = null;
    let typesSearch: TypesSearchSection | null = null;
    let directivesList: DirectivesListSection | null = null;

    const initSections = () => {
      const schemaContainer = explorer.getSectionContainer('schema');
      const typesContainer = explorer.getSectionContainer('types');
      const directivesContainer = explorer.getSectionContainer('directives');

      if (schemaContainer && !schemaTree) {
        schemaTree = new SchemaTreeSection(schemaContainer, (typeName: string) => {
          const client = explorer.getClient();
          if (client) {
            showDetailModal(client, typeName, (nav: string) => explorer.navigateToTypes(nav));
          }
        });
      }
      if (typesContainer && !typesSearch) {
        typesSearch = new TypesSearchSection(typesContainer, (typeName: string) => {
          explorer.navigateToTypes(typeName);
        });
      }
      if (directivesContainer && !directivesList) {
        directivesList = new DirectivesListSection(directivesContainer);
      }
    };

    // Listen for connection changes to update section clients
    explorer.node.addEventListener('hugr-connection-changed', ((e: CustomEvent) => {
      const { client } = e.detail;
      // Ensure sections are initialized (containers exist after first render)
      initSections();
      if (schemaTree) schemaTree.setClient(client);
      if (typesSearch) typesSearch.setClient(client);
      if (directivesList) directivesList.setClient(client);
    }) as EventListener);

    // Listen for types search navigation requests from within the explorer
    explorer.node.addEventListener('hugr-types-search', ((e: CustomEvent) => {
      e.stopPropagation(); // prevent document listener from re-triggering
      if (typesSearch) {
        typesSearch.setSearchQuery(e.detail.query);
      }
    }) as EventListener);

    // Listen at document level for events from hover tooltips (outside explorer DOM)
    document.addEventListener('hugr-types-search', ((e: CustomEvent) => {
      // Show and activate the explorer panel if it's hidden/closed
      if (!explorer.isVisible) {
        app.shell.add(explorer, 'right', { rank: 100 });
      }
      app.shell.activateById(explorer.id);
      if (typesSearch) {
        explorer.navigateToTypes(e.detail.query);
      }
    }) as EventListener);

    // Listen for directive navigation requests from within the explorer
    explorer.node.addEventListener('hugr-directive-search', ((e: CustomEvent) => {
      e.stopPropagation();
      if (directivesList) {
        directivesList.scrollToDirective(e.detail.query);
      }
    }) as EventListener);

    // Listen at document level for directive navigation from hover tooltips
    document.addEventListener('hugr-directive-search', ((e: CustomEvent) => {
      if (!explorer.isVisible) {
        app.shell.add(explorer, 'right', { rank: 100 });
      }
      app.shell.activateById(explorer.id);
      if (directivesList) {
        explorer.navigateToDirectives(e.detail.query);
      }
    }) as EventListener);

    const loadConnections = async () => {
      try {
        const settings = app.serviceManager.serverSettings;
        const resp = await ServerConnection.makeRequest(
          settings.baseUrl + 'hugr/connections', {}, settings
        );
        const connections = await resp.json();
        const defaultConn = connections.find((c: any) => c.status === 'default');
        explorer.setConnections(connections, defaultConn?.name || null);
      } catch (e) {
        console.error('Failed to load connections for explorer', e);
      }
    };
    loadConnections();
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
