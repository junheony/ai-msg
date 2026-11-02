# Server packaging: reviewed module-relative paths

`npm run build:server` bundles `bin`, `app`, `hookRelay`, and `permissionMcp` into `dist/server`. It also copies `hermesAcpBootstrap.py` beside `app.js`; `package.json` includes the entire `dist/server` directory. Sources are not shipped. Update this table and `src/server/packaging.test.ts` together when adding a module-relative path.

| Source | Repository lookup/use | Bundled lookup/use |
| --- | --- | --- |
| `src/server/cli/bin.ts` | Loads sibling `app.js` through its module URL. | Loads `dist/server/app.js` beside `bin.js`. |
| `src/server/cli/app.ts` | Detects direct development invocation of this file. | The executable is `bin.js`, so the direct-invocation guard stays inactive. |
| `src/server/config.ts` | Resolves two parent directories from `src/server` to the repository root. | Resolves two parents from `dist/server` to the package root. |
| `src/server/engine/HermesEngine.ts` | Resolves sibling `src/server/engine/hermesAcpBootstrap.py` using `new URL('./hermesAcpBootstrap.py', import.meta.url)`. | Inlined into `app.js`; the same relative URL resolves `dist/server/hermesAcpBootstrap.py`, copied by `scripts/build-server.mjs`. The installed Hermes Python interpreter executes this resource. |
| `src/server/engine/claudeCli/childScripts.ts` | Finds sibling `hookRelay.ts` and `permissionMcp.ts` (preferring `.js` if present). | Finds the separately bundled sibling `.js` children beside `app.js`; these are not inlined. |
| `src/server/engine/claudeCli/hookRelay.ts` | Direct-invocation guard for the source child. | Direct-invocation guard for `hookRelay.js`. |
| `src/server/engine/claudeCli/permissionMcp.ts` | Direct-invocation guard for the source child. | Direct-invocation guard for `permissionMcp.js`. |
| `src/server/engine/claudeCli/fixtures/capture.ts` | Writes captured fixture files beside itself and locates source child scripts. | Development fixture utility; not a bundle entry or runtime import. |
| `src/server/engine/claudeCli/fixtures/scrub.ts` | Direct-invocation guard for the development fixture scrubber. | Development fixture utility; not a bundle entry or runtime import. |

The packaging test scans the reviewed module set, builds into an isolated temporary directory, checks the copied Python resource against its source, and verifies that the bundled resource lookup remains module-relative. It does not execute Hermes or create a model session.
