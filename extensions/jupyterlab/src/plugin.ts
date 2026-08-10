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
import { CatalogTreeSection, CatalogOpenTarget } from './explorer/catalogTree';
import { SearchSection } from './explorer/searchSection';
import { DirectivesListSection } from './explorer/directivesList';
import { showDetailModal, showCatalogDetailModal } from './explorer/detailModal';
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
    let catalogTree: CatalogTreeSection | null = null;
    let searchSection: SearchSection | null = null;
    let directivesList: DirectivesListSection | null = null;

    // A type LINK names an exact GraphQL type — including generated ones the
    // logical-model search does not index — so it opens the introspection
    // modal directly rather than bouncing through the Search tab to a
    // guaranteed "Nothing matches".
    const nav = (typeName: string) => {
      const client = explorer.getClient();
      if (client) {
        showDetailModal(client, typeName, nav);
      }
    };

    // Catalog rows and search hits open the same detail views.
    const openDetail = (target: CatalogOpenTarget) => {
      const client = explorer.getClient();
      if (!client) {
        return;
      }
      if (target.view === 'type') {
        showDetailModal(client, target.name, nav);
      } else {
        showCatalogDetailModal(client, target, nav);
      }
    };

    const initSections = () => {
      const schemaContainer = explorer.getSectionContainer('schema');
      const catalogContainer = explorer.getSectionContainer('catalog');
      const typesContainer = explorer.getSectionContainer('types');
      const directivesContainer = explorer.getSectionContainer('directives');

      if (schemaContainer && !schemaTree) {
        schemaTree = new SchemaTreeSection(schemaContainer, (typeName: string) => {
          const client = explorer.getClient();
          if (client) {
            showDetailModal(client, typeName, nav);
          }
        });
      }
      if (catalogContainer && !catalogTree) {
        catalogTree = new CatalogTreeSection(catalogContainer, openDetail);
      }
      if (typesContainer && !searchSection) {
        searchSection = new SearchSection(typesContainer, openDetail);
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
      if (catalogTree) catalogTree.setClient(client);
      if (searchSection) searchSection.setClient(client);
      if (directivesList) directivesList.setClient(client);
    }) as EventListener);

    // Listen for search navigation requests from within the explorer
    explorer.node.addEventListener('hugr-types-search', ((e: CustomEvent) => {
      e.stopPropagation(); // prevent document listener from re-triggering
      if (searchSection) {
        searchSection.setSearchQuery(e.detail.query);
      }
    }) as EventListener);

    // Listen at document level for events from hover tooltips (outside explorer DOM)
    document.addEventListener('hugr-types-search', ((e: CustomEvent) => {
      // Show and activate the explorer panel if it's hidden/closed
      if (!explorer.isVisible) {
        app.shell.add(explorer, 'right', { rank: 100 });
      }
      app.shell.activateById(explorer.id);
      if (searchSection) {
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

    // Refresh explorer dropdown when connections change (add/delete/login/logout)
    document.addEventListener('hugr:connections-changed', ((e: CustomEvent) => {
      const connections = e.detail?.connections || [];
      explorer.updateConnectionsList(connections);
    }) as EventListener);
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
