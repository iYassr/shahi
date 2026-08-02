/**
 * Metro, taught about the monorepo.
 *
 * Two things it does not infer. `watchFolders` has to include the repo root or
 * edits to `shared/` never trigger a reload — the app would silently run against
 * a stale contract. And `nodeModulesPaths` has to list both the app's own
 * modules and the root's, because Bun hoists most dependencies to the root while
 * leaving some in the workspace.
 *
 * `@shahi/shared` is TypeScript source rather than a built package, which is
 * deliberate: it is types only, so Metro erases it and there is nothing to
 * build, publish or keep in sync.
 */
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// Let a package resolve its own deps before falling back to the root.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
