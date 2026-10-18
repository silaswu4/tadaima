/** Keep native ESM Three.js tests in one module realm. tsx's CJS bridge loads
 * another Three.js class identity, which invalidates instanceof fixture checks.
 * Backend aliases/JSON tests use the application's tsx loader separately. */
import { spawnSync } from "node:child_process";
const groups = [
  ["--experimental-strip-types", "--test", ...["test-captured-model.mjs", "test-textured-model.mjs", "test-captured-furniture.mjs", "test-explode.mjs", "test-room-appearance.mjs", "test-navigation.mjs", "test-quest-open.mjs", "test-walk-source.mjs", "test-walk-input.mjs", "test-walk-revision.mjs", "test-walk-material.mjs", "test-walk-authority.mjs", "test-indoor-lighting.mjs", "test-baked-indirect.mjs", "test-window-glass.mjs", "test-shadow-cache.mjs"].map((file) => `spatial/tests/${file}`)],
  ["--import", "tsx", "--test", "spatial/tests/test-workspace-xr.mjs", "spatial/tests/test-local-shopping.mjs", "reconstruction/local-preview.test.ts", "spatial/tests/test-walk-shopping.mjs", "spatial/tests/test-room-registry.mjs", "spatial/tests/test-room-agent.mjs", "spatial/tests/test-room-xr-actions.mjs"],
];
for (const args of groups) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) { process.stderr.write(result.error.message + "\n"); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
