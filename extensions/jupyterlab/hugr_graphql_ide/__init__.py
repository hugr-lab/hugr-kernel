"""Hugr GraphQL IDE — JupyterLab extension for GraphQL editor features."""


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "@hugr-lab/graphql-ide"}]


def _jupyter_server_extension_points():
    return [{"module": "hugr_graphql_ide"}]


def _load_jupyter_server_extension(server_app):
    """No server-side logic needed — all IDE features run via kernel protocol."""
    pass
