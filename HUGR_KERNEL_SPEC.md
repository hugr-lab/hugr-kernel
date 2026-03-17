# Hugr GraphQL IDE — Specification

**Repository**: hugr-lab/hugr-kernel
**Date**: 2026-03-16
**Status**: In Progress

---

## 1. Overview

Hugr GraphQL IDE — интегрированная среда для работы с Hugr GraphQL API внутри JupyterLab и VS Code. Включает:

1. **Go Kernel** — Jupyter kernel на Go с ZMQ, Arrow IPC streaming, completion, hover
2. **JupyterLab Extension** — UI: editor UX (syntax, completion, hover, diagnostics, formatting), explorer (TODO)
3. **VS Code Extension** — (TODO) аналогичный UI для VS Code

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        JupyterLab / VS Code                       │
│                                                                    │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │ Connection       │  │ Editor UX    │  │ Explorer          │   │
│  │ Manager (UI)     │  │ (CM6/Monaco) │  │ (Catalog+Schema)  │   │
│  └────────┬─────────┘  └──────┬───────┘  └────────┬──────────┘   │
│           │                   │                    │              │
│           ▼                   ▼                    ▼              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Jupyter Protocol (shell / comm)                │  │
│  └──────────┬──────────────────┬──────────────────┬───────────┘  │
└─────────────┼──────────────────┼──────────────────┼──────────────┘
              │                  │                  │
              ▼                  ▼                  ▼
┌────────────────────────────────────────────────────────────────┐
│ Go Kernel (hugr-kernel)                                         │
│                                                                  │
│  • execute_request → query-engine/client → Arrow IPC streaming  │
│  • complete_request → AST parse + schema introspection          │
│  • inspect_request → AST parse + schema introspection           │
│  • history_request → empty history                               │
│  • comm_msg → explorer protocol (TODO)                           │
│                                                                  │
│  Uses: query-engine/client, query-engine/types, gqlparser/v2    │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────┐
│     Hugr Server(s)       │
│  • GraphQL endpoint      │
│  • IPC endpoint          │
│  • catalog views         │
│  • introspection         │
└──────────────────────────┘
```

### 2.1 Go Kernel

**Binary**: `hugr-kernel` (Go 1.26.1)
**Protocol**: Jupyter Wire Protocol 5.4 over ZMQ
**Dependencies**: `query-engine/client`, `query-engine/types`, `gqlparser/v2`, `arrow-go/v18`

**Connections**: Loaded from `~/.hugr/connections.json` at startup.

#### execute_request
- Принимает GraphQL запрос или meta commands
- Определяет активное соединение (default или через `:use <name>`)
- Выполняет запрос через `query-engine/client`
- Arrow IPC streaming через HTTP сервер на localhost
- **Flatten**: автоматически разворачивает complex Arrow types (Struct → dot-separated columns, List/Map/Union → JSON strings) для совместимости с Perspective viewer
- Возвращает `application/vnd.hugr.result+json` с multipart результатами

#### complete_request
- Получает полный код и позицию курсора
- Парсит GraphQL через `gqlparser/v2/parser.ParseQuery` (AST подход)
- Определяет контекст: SelectionSet, Argument, ArgumentValue, Directive, DirectiveArg, Variable, TopLevel
- Запрашивает у Hugr подходящие поля/аргументы через cached introspection
- Возвращает `complete_reply` с matches и `_hugr_completions` в metadata

#### inspect_request
- Определяет токен и контекст через AST parse
- Запрашивает описание через cached introspection
- Возвращает `text/markdown` + `text/plain` hover

#### Cursor Context Resolution

Контекст определяется через AST парсинг (`gqlparser/v2`), не через character-by-character сканирование:

1. `SafeParse(code)` — парсит полный код, возвращает partial AST даже при ошибках
2. `ResolveFromAST(doc, code, cursorPos)` — обходит AST, находит deepest node at cursor
3. Fallback на truncated parse (`code[:cursorPos]`) если полный парс не даёт контекста
4. Prefix извлекается из raw текста (scan backward for ident chars)

Контексты:
- `ContextSelectionSet` — внутри `{ }`, нужны поля текущего типа
- `ContextArgument` — внутри `( )`, нужны аргументы поля
- `ContextArgumentValue` — после `arg:`, нужны значения (input fields, enums)
- `ContextDirective` — после `@`, нужны директивы
- `ContextDirectiveArg` — внутри `@dir( )`, нужны аргументы директивы
- `ContextVariable` — после `$`, нужны session переменные
- `ContextTopLevel` — на уровне документа

#### Schema Introspection

Lazy, кэшированное. Не загружает всю схему.

| Нужно | Запрос |
|-------|--------|
| Root types | `__schema { queryType mutationType subscriptionType }` |
| Type fields | `__type(name:) { fields { name type args } }` |
| Input fields | `__type(name:) { inputFields { name type } }` |
| Directives | `__schema { directives { name locations args } }` |

**Кэш**: In-memory map, TTL 30 min. Инвалидация через `:refresh`.

**TODO**: LRU cache (limit ~1000 types), для больших типов (5-10k полей) использовать `core.catalog.fields` вместо introspection.

#### Meta Commands

| Command | Description |
|---------|-------------|
| `:connect <name> <url>` | Добавить соединение |
| `:use <name>` | Переключить активное соединение |
| `:connections` | Список соединений |
| `:disconnect <name>` | Удалить соединение |
| `:default <name>` | Установить default |
| `:status` | Статус ядра |
| `:set <var> <val>` | Установить session variable |
| `:unset <var>` | Удалить session variable |
| `:variables` | Список session variables |
| `:refresh` | Инвалидировать schema cache |
| `:auth <name> key\|bearer <value>` | Установить auth |
| `:role <name> <role>` | Установить role |
| `:json` | Вывести результат как JSON (inline flag) |

### 2.2 JupyterLab Extension

**Тип**: JupyterLab 4.x frontend extension (TypeScript).

#### Editor UX

**Syntax Highlighting** (CodeMirror 6 StreamLanguage):
- Keywords, types, strings, comments, directives, variables, numbers, spread operator

**Auto-close**: `{}`, `()`, `[]`, `""`
**Bracket matching**: подсветка парных скобок
**Indentation**: 2 spaces, auto-indent после `{` и `(`

**Completion** (`completion.ts`):
- Использует `kernel.requestComplete()` (Jupyter protocol)
- Debounce: 500ms (`interactionDelay`)
- Request cancellation через sequence numbers
- Показывает: label, kind, detail (type), documentation

**Hover** (`hover.ts`):
- Использует `kernel.requestInspect()` (Jupyter protocol)
- Delay: 300ms
- Markdown rendering в tooltip

**Diagnostics** (`diagnostics.ts`):
- **Client-side** syntax validation через `prettier` + GraphQL plugin
- Delay: 500ms debounce
- Подчёркивание ошибок (red for errors)
- Без schema validation (только синтаксис)

**Formatting** (`formatting.ts`):
- Prettier с GraphQL parser
- Команда "Format Document"

#### Explorer (TODO)

Два раздела:
- **Logical Explorer** — каталог Hugr (data sources, modules, tables/views/functions)
- **Schema Explorer** — raw GraphQL schema (root types, type fields)

Коммуникация через Jupyter comm protocol (`hugr.explorer` target).

### 2.3 VS Code Extension (TODO)

Аналогичная функциональность, адаптированная под VS Code API.

---

## 3. Project Structure

```
hugr-kernel/
├── cmd/hugr-kernel/main.go          # Entry point, signal handling, env config
├── internal/
│   ├── kernel/
│   │   ├── kernel.go                # ZMQ sockets, message loops, heartbeat
│   │   ├── message.go               # Jupyter wire protocol v5.4
│   │   ├── handlers.go              # Shell message handlers
│   │   └── arrowhttp.go             # Arrow IPC HTTP streaming server
│   ├── connection/
│   │   ├── connection.go            # Connection struct, Hugr client wrapper
│   │   └── manager.go               # ConnectionManager (add/remove/default)
│   ├── session/session.go           # Session variables, execution counter
│   ├── meta/
│   │   ├── parser.go                # Meta command parser (: prefix)
│   │   ├── registry.go              # Command registry and dispatch
│   │   └── commands.go              # All meta command implementations
│   ├── completion/
│   │   ├── context.go               # CursorContext struct + ResolveCursorContext
│   │   ├── parseutil.go             # SafeParse wrapper for gqlparser
│   │   ├── astwalker.go             # AST walk → CursorContext resolution
│   │   ├── completer.go             # Schema-aware completion items
│   │   └── context_test.go          # 8 context resolution tests
│   ├── hover/hover.go               # Hover/inspect with schema lookup
│   ├── schema/
│   │   ├── client.go                # Cached schema introspection client
│   │   └── queries.go               # Introspection query strings
│   ├── result/
│   │   ├── handler.go               # Response → viewer metadata + Arrow flatten
│   │   └── spool.go                 # Arrow IPC file spool (temp files)
│   └── renderer/table.go            # ASCII table fallback
├── extensions/
│   └── jupyterlab/                  # JupyterLab frontend extension
│       ├── src/
│       │   ├── index.ts
│       │   ├── plugin.ts            # Plugin registration
│       │   ├── commClient.ts        # Comm protocol client (explorer)
│       │   ├── connectionManager.ts # Connection manager sidebar
│       │   ├── graphql/
│       │   │   ├── language.ts       # CM6 GraphQL syntax + extensions
│       │   │   ├── completion.ts     # kernel.requestComplete() integration
│       │   │   ├── hover.ts          # kernel.requestInspect() integration
│       │   │   ├── diagnostics.ts    # Client-side syntax linter (prettier)
│       │   │   └── formatting.ts     # Prettier formatting command
│       │   └── explorer/
│       │       ├── logicalExplorer.ts
│       │       ├── schemaExplorer.ts
│       │       └── detailModal.ts
│       └── package.json
├── kernel/kernel.json               # Kernel spec
├── pyproject.toml                   # Python env (JupyterLab)
├── Makefile                         # build, install, test
└── go.mod
```

**Result MIME type**: `application/vnd.hugr.result+json` with `parts` array for multipart results.

---

## 4. Dependencies

### Go (kernel)
- `query-engine/client` — Hugr GraphQL + IPC client
- `query-engine/types` — Arrow table, response types, flatten utilities
- `vektah/gqlparser/v2` — GraphQL parser for AST-based completion
- `apache/arrow-go/v18` — Arrow IPC, memory management
- `go-zeromq/zmq4` — ZMQ for Jupyter wire protocol

### TypeScript (JupyterLab extension)
- `@jupyterlab/application`, `@jupyterlab/services`, `@jupyterlab/notebook`
- `@codemirror/autocomplete`, `@codemirror/language`, `@codemirror/lint`, `@codemirror/view`, `@codemirror/state`
- `@lumino/widgets`
- `prettier` + `prettier/plugins/graphql` — formatting + syntax diagnostics

---

## 5. Status

### Done
- [x] Go kernel: ZMQ, execute, meta commands, Arrow IPC streaming
- [x] Connection manager (runtime, from JSON config)
- [x] Session variables
- [x] Completion: AST-based context resolution, schema introspection, nested input objects
- [x] Hover: field/argument/input field documentation
- [x] Arrow flatten: Struct/List/Map/Union → flat columns for Perspective
- [x] JupyterLab: syntax highlighting, bracket matching, auto-close, indentation
- [x] JupyterLab: completion via kernel protocol
- [x] JupyterLab: hover via kernel protocol
- [x] JupyterLab: client-side syntax diagnostics (prettier)
- [x] JupyterLab: formatting (prettier)
- [x] Protocol version 5.4
- [x] history_request handler (empty)

### TODO
- [ ] Comm protocol for explorer (comm_open/comm_msg)
- [ ] Logical Explorer UI (data sources, modules, catalog)
- [ ] Schema Explorer UI (root types, type fields, search)
- [ ] Detail modals
- [ ] LRU cache for schema types (limit ~1000, TTL 30min)
- [ ] Use `core.catalog.fields` for large types instead of introspection
- [ ] Use `core.catalog.types` for type discovery with field count threshold
- [ ] Connection Manager UI (sidebar widget)
- [ ] VS Code extension
- [ ] Schema-level diagnostics (unknown fields, missing args) — from kernel
