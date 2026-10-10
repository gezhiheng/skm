# SKM — Skill & Tool Package Manager

SKM is a local-first manager for AI coding-agent Skills and composite tool packages. Register a local Skill once, select it for individual projects or global inheritance, preview the proposed filesystem changes, and apply the plan. The CLI and the Vue dashboard call the same TypeScript Core; the API does not shell out to the CLI.

## Install and start

Use Node.js 22 or newer; this workspace is tested with Node.js 24 and includes an `.nvmrc` for Node 24. Use pnpm 8 or newer (the workspace declares pnpm 8.15.9).

```sh
pnpm install
pnpm build
pnpm skm --help
pnpm skm ui
```

Open [http://127.0.0.1:4318](http://127.0.0.1:4318). `pnpm build` builds the Core, API, CLI, and Web assets. `pnpm skm ui` serves those Web assets and the local API in one process. It prints the URL and leaves browser opening to you. Stop the server with Ctrl+C.

Commands use the built CLI, so run `pnpm build` after changing source. There is no required global installation or published npm package. The direct equivalent is `node packages/cli/dist/index.js <arguments>`.

For development, use two terminals:

```sh
# Terminal 1: API on 127.0.0.1:4318
pnpm dev:api

# Terminal 2: Vite on 127.0.0.1:5173 with /api proxying to the API
pnpm dev:web
```

`pnpm dev` is an alias for the API development command. The API watcher rebuilds Core before starting; rerun it after Core changes. API startup also accepts `SKM_HOST`, `SKM_PORT`, and `SKM_WEB_DIST`; `pnpm skm ui --port 4320` changes the CLI-started listener port.

## First Skill and project

The `fixtures/` directories are small local development examples. They are not real third-party packages. Substitute your own local directory containing `SKILL.md` for a fixture when using SKM with real Skills.

```sh
# Register a Skill. This creates a plan; it does not yet register the Skill.
pnpm skm skill register ./fixtures/skills/example-review
pnpm skm apply <registration-plan-id>

# The project directory must already exist.
mkdir -p /tmp/skm-demo-project
pnpm skm project add /tmp/skm-demo-project
pnpm skm apply <project-registration-plan-id>

# Declare the project's desired Skill set.
pnpm skm project config /tmp/skm-demo-project --inherit-global false --skills example-review
pnpm skm apply <configuration-plan-id>

# Preview, then install the Skill into this project.
pnpm skm skill add example-review --project /tmp/skm-demo-project
pnpm skm apply <installation-plan-id>

# Inspect the registry and real filesystem state.
pnpm skm inspect example-review
pnpm skm inspect example-review --project /tmp/skm-demo-project
pnpm skm project status /tmp/skm-demo-project
pnpm skm doctor
```

Each mutating command returns a plan ID, affected resources, planned actions, files to preserve, and conflicts. Review the output before running `apply`. A plan marked unsafe cannot be applied. Important assumptions are checked again at execution, so a plan becomes stale if files or relevant configuration change after preview; create a fresh plan instead of retrying an old one.

Use `pnpm skm show-plan <plan-id>` to review a saved plan again before applying it.

The Web UI follows the same workflow. Select a project, browse Skills and packages, preview a change, confirm it in the plan dialog, and inspect the operation result. Project settings, registry changes, global configuration, installation, and removal all go through shared Core plans.

## Desired configuration and installed files

A project's `.skm.yaml` expresses desired state:

```yaml
version: 1
inheritGlobal: true
skills:
  - example-review
```

`project config` changes this desired state. `skill add`, `package install`, and their removal commands change physical installations. They are separate operations: selecting a Skill does not install it, and uninstalling it does not remove it from desired configuration. Status shows selected but uninstalled Skills as missing. Managed installations that are no longer desired are also inspected so drift remains visible.

For example, remove both an installation and its desired selection explicitly:

```sh
pnpm skm skill remove example-review --project /tmp/skm-demo-project
pnpm skm apply <uninstall-plan-id>

# An empty string clears the explicit project selection.
pnpm skm project config /tmp/skm-demo-project --skills ""
pnpm skm apply <configuration-plan-id>
```

Use `project config <path>` without update options to read the configuration. `--skills` replaces the explicit list rather than appending to it. When `inheritGlobal` is true, the effective project selection combines the global desired list with that explicit project list. Project selections never become global automatically.

## Global Skills

The global desired list supplies inheritance; global physical installation is a separate step, just as it is for projects.

```sh
pnpm skm global config
pnpm skm global config --skills example-review
pnpm skm apply <global-configuration-plan-id>

pnpm skm global install example-review
pnpm skm apply <global-installation-plan-id>
pnpm skm global status

pnpm skm global remove example-review
pnpm skm apply <global-uninstall-plan-id>
```

`skill add/remove --global` and `package install/remove --global` are equivalent installation targets. Provide either `--global` or `--project`, not both. Package initialization requires a registered project and is never implicit in a global installation.

## Installation modes, updates, and safety

The default adapter uses `.agents/skills/<name>` inside a project and `~/.agents/skills/<name>` for the current user's global installation. These are supported Codex discovery locations: the [official Codex Skills documentation](https://developers.openai.com/codex/skills/) describes repository `.agents/skills` discovery, user `$HOME/.agents/skills`, and support for symlinked Skill folders. Codex scans ancestor directories up to the repository root, while SKM installs into the selected project directory. Other coding agents need a verified discovery directory; Core callers can inject an `AgentAdapter` for those paths.

SKM uses symbolic links by default. For a platform or environment where links cannot be created, explicitly preview a copy-mode plan:

```sh
pnpm skm skill add example-review --project /tmp/skm-demo-project --mode copy
pnpm skm apply <copy-installation-plan-id>

# Package Skill components support the same option.
pnpm skm package install example-review-suite --project /tmp/skm-demo-project --mode copy
```

Copy fallback is explicit. A failed symlink operation reports failure and rolls back recoverable work; create a new `--mode copy` plan afterward. SKM does not silently switch the installation mode after a reviewed plan. Copy-mode installs are checked against recorded contents, so edited copies are preserved and reported as drift rather than deleted.

Registration copies the source Skill into SKM's managed central directory. The original local directory remains yours. Update that central Skill from a new local directory with:

```sh
pnpm skm skill update example-review /path/to/updated/example-review
pnpm skm apply <update-plan-id>
```

Updates use the same plan, ownership, collision, and verification rules. Symlink installations see the updated central contents. Reinspect status after an update, especially for copy installations: rerun the installation command to preview refreshing an unchanged managed copy. Existing unmanaged files and directories are preserved; edited managed copies or changed links require intervention rather than an overwrite.

These removal operations have different scopes:

| Command | Scope |
| --- | --- |
| `skill remove <name> --project <path>` | Uninstall a verified SKM-managed project installation. Preserve central and original sources. |
| `project config <path> --skills <names>` | Replace desired project selection. Preserve actual installations. |
| `global config --skills <names>` | Replace desired global selection. Preserve actual installations. |
| `skill unregister <name>` | Remove the registry entry. Preserve centrally copied source and project data. |
| `skill unregister <name> --delete-source` | Remove the registry entry and central source only when known references and installations allow it. |
| `package remove <name> --project <path>` | Remove verified managed Skill components. Preserve initialized project files. |

`uninstall` is an alias for Skill, package, and global `remove`. Central source deletion is refused while known project selections, global selections, package components, or managed installations still reference the Skill. Removing a symlink removes the link itself; it never recursively removes its target.

## Composite packages

A package can describe multiple Skills, CLI tooling, and explicit project configuration components. Register the included fixture after registering its referenced Skill:

```sh
pnpm skm package register ./fixtures/packages/example-review-suite.json
pnpm skm apply <package-registration-plan-id>
pnpm skm inspect example-review-suite
pnpm skm inspect example-review-suite --project /tmp/skm-demo-project

pnpm skm package install example-review-suite --project /tmp/skm-demo-project
pnpm skm apply <package-installation-plan-id>

# Initialization is a separate explicit action.
pnpm skm init example-review-suite --project /tmp/skm-demo-project
pnpm skm apply <initialization-plan-id>
```

The fixture package combines a Skill and a `.example-review/settings.json` template. If an initialization target already exists, it is preserved and the conflicting plan cannot be applied. Uninstalling the package preserves generated project configuration.

A package definition is a validated JSON object:

```json
{
  "name": "my-suite",
  "version": "1.0.0",
  "components": [
    { "type": "skill", "skill": "example-review" },
    { "type": "project-config", "files": { ".my-suite/config.json": "{}\n" } },
    { "type": "cli-tool", "package": "my-tool", "packageManager": "npm", "executable": "my-tool" }
  ]
}
```

Skill components must reference registered Skills. Template paths are constrained to the project. Component adapters separate inspection, installation planning, uninstall planning, and project initialization.

External CLI components are modeled and inspectable, but installation and uninstall are disabled until a verified adapter with ownership checks is configured. Such plans show proposed argument-array commands for review and report an explicit conflict; they do not execute those commands. Arbitrary shell strings in package definitions are rejected. SKM does not ship or claim verified OpenSpec installation or initialization support; the generic component model can represent a verified integration later.

## CLI reference

The following are available through `pnpm skm`. Human-readable output is the default. `--json` produces machine-readable output, including full plans and apply results, and is especially useful for list, status, config, and doctor commands.

| Command | Purpose |
| --- | --- |
| `list [query]` / `search <query>` | Browse registered Skills and packages. |
| `inspect <name> [--project <path> \| --global]` | View metadata and inspect component lifecycle state, using a selected target when provided. |
| `skill register <path>` | Plan registration of a local Skill. |
| `skill update <name> <path>` | Plan a central Skill update. |
| `skill add <name> --project <path> [--mode copy]` | Plan project Skill installation. |
| `skill remove <name> --project <path>` | Plan managed Skill uninstall. |
| `skill unregister <name> [--delete-source]` | Plan registry removal or safe central source deletion. |
| `project add <path>` / `project list` | Register or list projects. |
| `project config <path> [--skills <names>] [--inherit-global true\|false]` | Read or plan desired configuration changes. |
| `project status <path>` | Inspect actual installations and effective selection. |
| `package register <file>` | Plan registration of a JSON package definition. |
| `package install/remove <name> --project <path>` | Plan installation or uninstall of package components. |
| `package init <name> --project <path>` / `init <name> --project <path>` | Plan explicit package configuration initialization. |
| `global config [--skills <names>]` / `global status` | Read or change global selection; inspect global files. |
| `global install/remove <name> [--mode copy]` | Plan global installation or uninstall. `--mode` applies to install. |
| `plan <action> --args <json>` | Create a plan through the generic Core operation layer. |
| `show-plan <plan-id>` | Read a saved preview through the same service as the Web API. |
| `apply <plan-id>` | Execute a reviewed saved plan. |
| `doctor` | Diagnose registry sources and project/global installation issues. |
| `ui [--port <port>]` | Start the built local Web dashboard and API. |

Project arguments accept a registered absolute or relative directory path, or the ID returned by `project list`. Quote paths containing spaces. A raw plan example is:

```sh
pnpm skm --json plan skill:install --args '{"name":"example-review","project":"/tmp/skm-demo-project","mode":"copy"}'
pnpm skm --json project status /tmp/skm-demo-project
pnpm skm --json doctor
```

Command errors and failed applications exit with status 1. Diagnostics exit with status 1 when an error-level issue is found; warnings remain visible in output. Operation results include completed steps and a failed step when applicable. A failed operation does not count as success; inspect the result and current status, resolve the reported cause, and preview a fresh plan before retrying.

JSON inspection returns `{ "item": { ... }, "components": [ ... ] }`: `item` contains registered metadata, and each component includes its state, description, and inspected paths. Apply results report rollback and replay when applicable. Reapplying a successfully completed plan returns its saved result without repeating its filesystem steps.

## Storage and local API

Default state lives in `~/.skm/`. Use `pnpm skm --data-dir /path/to/state <command>` to select a different directory, or set `SKM_HOME` for CLI and API processes. `--data-dir` also passes through `ui` startup. This changes registry storage, not the adapter's global user installation directory; use project targets when testing installations.

| Location | Authority |
| --- | --- |
| Project `.skm.yaml` | Desired project Skill selection and inheritance. |
| State `global.yaml` | Desired global Skill selection. |
| State `registry.yaml` and `resources/skills/` | Registry metadata and managed central Skill sources. |
| State `projects.yaml` | Registered project identities and paths. |
| State `ownership.yaml` | Evidence of installations SKM may remove. |
| State `plans/` | Saved operation previews for later apply. |
| State `results/` | Verified apply results and replay protection. |
| State `journals/` | Recovery records for interrupted operations. |
| State `.plan-key` and adjacent `.mac` files | Integrity checks for plans and operation records. |
| State `.operation.lock` | Serializes mutations for this data directory. |
| Real filesystem | Actual installation state, including collisions, broken links, and drift. |

SKM serializes mutations and uses recovery records to roll back interrupted work when ownership can still be verified. If a path changes during recovery, it preserves that path and reports the remaining backup location for inspection. A completed operation whose recovery-file cleanup fails is reported with a warning; keep the state directory and recovery records intact while resolving it.

The API binds to loopback by default. Requests must come from a loopback address with a loopback `Host`; a supplied `Origin` must match the server's origin. JSON content type is required for mutations. There are no permissive CORS headers. The development API additionally allows the Vite origins on localhost or 127.0.0.1 port 5173. Keep this local service private: there is no network authentication or remote multi-user mode.

## Structure and verification

```text
packages/core/   Shared schemas, registry, adapters, planning, safety, execution, inspection
packages/cli/    Commander argument parsing, human/JSON output, exit codes
packages/api/    Fastify validation and routes calling the Core; static Web serving
packages/web/    Vue 3 dashboard, project/catalog management, previews and results
fixtures/       Small local Skill and package examples
```

Run the complete checks from the workspace root:

```sh
pnpm typecheck
pnpm test
pnpm build
```

Tests use temporary directories. Core tests exercise registration, project isolation, inheritance, ownership, collisions, links/copies, drift, source preservation, safe deletion, package planning, stale plans, and failure handling. CLI tests run actual Node subprocesses and assert JSON plans/results, symlink updates and component inspection, copy installation/status/removal, global inheritance settings, preserved source and package configuration, invalid config errors, and stale-plan protection. API tests exercise the shared services, validation, local request restrictions, and confirmation on apply. UI tests exercise API error handling and the confirmation/result workflow.

The MVP uses filesystem persistence and is intended for a single local operator. It does not provide a remote catalog, automatic updates, package-manager execution, or verified integrations for coding agents other than Codex. Every such integration needs an explicit adapter and verified installation/ownership behavior before being enabled.
