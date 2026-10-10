# Build SKM: Skill & Tool Package Manager

## 1. Your Mission

You are a senior TypeScript engineer. Build a working MVP of **SKM**, a local-first Skill and Tool Package Manager for AI coding agents.

The user manages many AI Skills, coding-agent tools, and project-specific configurations. SKM must make it easy to discover, install, inspect, update, and remove these resources across multiple projects.

**Build the complete MVP in one pass. Do not stop after planning, scaffolding, or writing documentation.** Inspect the environment, make reasonable decisions independently, implement the application, run tests, fix failures, and provide a working result.

Ask questions only when a genuine blocker prevents implementation. Do not ask for confirmation on ordinary engineering decisions.

## 2. Non-Negotiable Architecture

### CLI is the source of truth

All business operations must be available through the CLI.

The Web UI is a visual interface for the same capabilities. It must not implement its own independent business logic for managing Skills, projects, packages, configuration, or filesystem operations.

Use a shared TypeScript core with clear boundaries:

- `CLI`: command parsing, human-readable output, JSON output, exit codes.
- `Core`: business logic, validation, project resolution, operation planning, execution, status inspection.
- `Web API`: HTTP interface that calls the shared Core.
- `Web UI`: project selection, resource browsing, configuration, operation previews, execution feedback.

The CLI and Web API must share the same Core implementation and produce consistent results.

Do not make the Web API shell out to the SKM CLI for every operation. Instead, both should invoke the same Core services. External commands required by package adapters may be executed through a safe subprocess abstraction.

All persistent business-state changes and managed filesystem mutations must pass through the shared Core operation layer.

UI-only state, such as search text and open dialogs, does not need CLI commands.

## 3. Technology Stack

Use TypeScript throughout.

- Runtime: Node.js, use a currently supported LTS version.
- Package manager: pnpm.
- Monorepo: pnpm workspaces.
- CLI: Commander or another lightweight mature CLI framework.
- Backend: Fastify.
- Frontend: Vue 3 + Vite + TypeScript.
- Validation: Zod.
- Testing: Vitest.
- Configuration: YAML or JSON with validated schemas.
- Persistence: filesystem-based configuration and a lightweight registry. Do not introduce a database unless a concrete MVP requirement demands one.

Use mature, maintained dependencies and keep the dependency tree reasonable.

The Web UI and backend should run locally. Document all commands needed to start, build, test, and use the application.

## 4. Core Domain Model

Support these concepts:

### Skill

A directory containing `SKILL.md` and optional supporting files.

A Skill may be managed centrally and linked into one or more agent-specific or project-specific Skill directories.

### Tool Package

A package that may contain multiple components, including:

- Skills
- CLI tools
- Project configuration or initialization templates

Do not assume every package is a single Skill directory.

OpenSpec is an important example of a composite package. Model it through the generic package/component abstraction rather than hardcoding special cases throughout the application.

### Project

A local project directory with its own SKM configuration.

Projects may inherit globally configured Skills or use only their explicitly selected Skills.

### Agent Adapter

An adapter describes how a particular coding agent discovers Skills, including its target directory and any supported installation constraints.

Keep agent-specific paths out of the Core business logic.

Implement at least one useful default adapter and make adding more straightforward. Do not fabricate undocumented agent paths; clearly document supported adapters.

### Component Adapter

A component adapter defines how to inspect, plan, install, and uninstall a particular component type, such as a Skill, CLI tool, or project configuration.

Only implement component types necessary for a useful MVP. The architecture must permit additional adapters without rewriting the UI or the Core.

## 5. MVP Functional Requirements

### A. Central Registry

Provide a central directory for managed Skills and package definitions.

Support:

- Listing and searching registered Skills and packages.
- Viewing metadata and component composition.
- Registering a local Skill directory.
- Removing a Skill from the registry without accidentally deleting project data.
- Tracking versions where available.
- Clear distinction between removing a registry entry and deleting centrally managed source files.

Include several small example fixtures for development and testing. Do not pretend they are real third-party packages.

### B. Project Management

Support:

- Registering a project by local directory path.
- Listing registered projects.
- Inspecting a project's SKM configuration.
- Selecting which Skills a project uses.
- Enabling or disabling inheritance from global Skills.
- Showing the effective Skill set for a project.
- Showing where each Skill is expected to be installed and where it is actually found.
- Detecting missing installations, broken links, unmanaged collisions, and configuration drift.

Project-specific Skills must not automatically become global Skills.

### C. Installation and Removal

Support installing and removing Skills for a particular project, as well as globally configured Skills.

Use symbolic links by default where supported. Provide a copy-based fallback when necessary or explicitly requested.

Do not silently overwrite existing files or directories.

Removal must only delete resources that SKM can verify it manages. Never recursively delete an arbitrary symlink target.

Keep these operations distinct:

- Uninstall from a project.
- Remove a Skill from a project's desired configuration.
- Remove a registry entry.
- Delete a centrally managed Skill source.
- Uninstall a CLI tool.
- Initialize a project's tool-specific configuration.

A Skill's removal must not implicitly delete its source or project-generated data.

When deleting centrally managed resources, check all known references and refuse unsafe deletion.

### D. Composite Tool Packages

Implement a generic Tool Package abstraction with multiple components.

At minimum, model the lifecycle interfaces needed for:

- Skill installation.
- CLI tool inspection and installation.
- Explicit project initialization.

External CLI installation must use an explicit adapter and a known package or executable configuration. Do not execute arbitrary shell strings loaded from an untrusted package definition.

If a real package's installation method cannot be verified, provide the generic adapter interface and clearly document the limitation rather than claiming full support.

OpenSpec should be represented as a composite package example only to the extent its real components and installation methods are verified. Project initialization must be a separate, explicit action.

### E. Operation Planning and Execution

All mutating operations must support a plan-before-apply workflow.

The plan should describe:

- Resources to create.
- Resources to link or copy.
- Resources to remove.
- Existing files to preserve.
- Conflicts requiring user intervention.
- External commands to run, if any.
- The affected project and component.
- Whether an operation is safe to execute.

The CLI should support dry-run or plan output.

The Web UI must display the plan before execution for consequential changes. Require explicit user confirmation before applying it.

Revalidate important assumptions immediately before execution. A stale plan must not blindly overwrite a filesystem state that has changed since preview.

### F. Status and Diagnostics

Implement:

- Overall registry status.
- Per-project status.
- Global versus project-specific Skill comparison.
- Expected versus actual installation state.
- Broken symlink detection.
- Conflict detection.
- Basic diagnostics through `doctor`.

Status must inspect the real filesystem rather than trusting configuration alone.

### G. Web Dashboard

Build a real, usable Vue 3 interface, not a placeholder page.

Required views:

1. **Dashboard**: registered projects, registered Skills/packages, and basic health indicators.
2. **Projects**: project list, project details, inheritance settings, effective Skills.
3. **Skills & Packages**: browse, search, inspect, register local Skills.
4. **Install Management**: select a project, select Skills/packages, preview and apply changes.
5. **Status & Diagnostics**: missing installations, conflicts, broken links, and repair guidance.
6. **Operation Results**: success/failure, affected resources, command output where applicable, and actionable error messages.

The UI should be responsive, consistent, and practical for daily development use.

Provide loading states, empty states, validation feedback, operation progress, and clear error handling.

Do not add decorative charts or complicated visualizations without a real use case.

All data-driven views must obtain business data through the Web API backed by the shared Core.

All data mutations must call the same operation services used by the CLI.

### H. CLI Commands

Provide a coherent command set similar to:

- `skm list`
- `skm search <query>`
- `skm skill register <path>`
- `skm skill add <name> --project <path>`
- `skm skill remove <name> --project <path>`
- `skm project add <path>`
- `skm project list`
- `skm project status <path>`
- `skm package install <name> --project <path>`
- `skm init <package> --project <path>`
- `skm plan`
- `skm apply <plan-id>`
- `skm doctor`
- `skm ui`

You may adjust the command names for consistency, but all major Web operations must have corresponding CLI capabilities.

Include machine-readable JSON output for list, status, plan, and diagnostic commands. Keep human-readable output as the default.

The `skm ui` command should start the local backend and make the Web UI accessible, preferably opening the browser only when explicitly requested or clearly documented.

## 6. Configuration and Storage

Use a predictable local data directory, such as `~/.skm/`, containing:

- Global configuration.
- Registry metadata and centrally managed resources.
- Registered project metadata where necessary.
- Operation or installation ownership records.

Each project should have a small `.skm.yaml` file declaring its desired configuration, including inheritance behavior and selected resources.

Define which data is authoritative:

- Project configuration expresses desired state.
- Registry metadata describes managed sources and packages.
- Filesystem inspection establishes actual installation state.
- Ownership records help determine which resources SKM is allowed to remove.

Avoid maintaining redundant state unless its purpose is explicit.

Configuration should be schema-validated, with useful errors for malformed or unsupported fields.

## 7. Security and Reliability

This tool can modify real project files. Treat filesystem safety as a core requirement.

- Normalize and validate paths.
- Handle spaces and unusual characters in paths.
- Do not follow arbitrary symlinks when deleting resources.
- Never overwrite unmanaged files silently.
- Track ownership of managed installations.
- Reject unsafe deletion when ownership cannot be established.
- Validate package definitions before executing adapters.
- Avoid shell interpolation. Use subprocess APIs with argument arrays.
- Restrict the local Web API to local use by default.
- Add basic request validation and appropriate CORS restrictions.
- Prevent accidental duplicate operations and handle partial failures.
- Make errors actionable.
- Avoid claiming an operation succeeded until verification passes.

If an operation partially fails, report completed and failed steps, preserve recoverable state, and provide a safe retry path.

## 8. Testing and Acceptance Criteria

Write meaningful tests for Core logic, CLI behavior, API endpoints, and critical UI workflows.

At minimum, verify:

1. A Skill can be registered, installed into Project A, inspected, and safely removed.
2. Project B remains unaffected when a Skill is installed into Project A.
3. Global inheritance correctly changes the effective Skill set.
4. Symlink installation and copy fallback work as designed.
5. An existing unmanaged directory is detected and preserved.
6. Uninstalling a project Skill does not delete its central source.
7. Deleting a centrally managed source is rejected when references remain.
8. Broken symlinks and configuration drift are reported.
9. A composite package can produce a plan with multiple component types.
10. CLI and Web API invoke the same business services.
11. The Web UI can browse Skills, select a project, preview a change, confirm it, and display the verified result.
12. Invalid configuration and partial operation failures produce clear errors.

Use temporary directories in filesystem tests. Never let tests modify the real user's home directory.

## 9. Implementation Strategy

Work in this order, but complete the entire sequence in this run:

1. Inspect the repository and determine whether to integrate with existing files or create a new project.
2. Establish workspace structure, schemas, and Core interfaces.
3. Implement filesystem safety utilities, registry, project resolution, and operation planning.
4. Implement Skill adapters and essential package/component interfaces.
5. Implement CLI commands.
6. Implement Fastify API routes over the shared Core.
7. Implement the Vue Web UI.
8. Add integration tests and critical UI tests.
9. Run type checking, linting if configured, tests, and production builds.
10. Fix issues, then write the README with installation, startup, commands, limitations, and examples.

Do not leave the main flows as TODOs or mock implementations.

Prefer a smaller set of fully working features over many incomplete features. If a feature is too risky or its external integration cannot be verified, implement a safe, clearly reported limitation rather than faking success.

## 10. Final Deliverables

When finished, report:

- What was implemented.
- The project structure.
- How to install dependencies and start the CLI and Web UI.
- Example CLI commands.
- Tests, type checks, and builds actually executed, with their results.
- Known limitations and any external integrations that still require configuration.

**Definition of Done:** A developer can run SKM locally, register a Skill, manage its use in multiple projects from both CLI and Web UI, preview and apply changes safely, inspect actual installation state, and run the test suite successfully.

Start implementing now. Do not return only a plan.