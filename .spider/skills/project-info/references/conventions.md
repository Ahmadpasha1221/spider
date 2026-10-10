# Spider Coding Conventions

## TypeScript & Architecture
- Strict TypeScript (`noImplicitAny`, strict null checks).
- Clean separation between Agent Runtime, Tool Registry, and Permission Manager.
- All model interactions are provider-neutral.
- Tools must be registered canonically in `src/runtime/tools/toolRegistry.ts`.
- Filesystem and script execution tools must enforce directory containment and execute-level permissions.
