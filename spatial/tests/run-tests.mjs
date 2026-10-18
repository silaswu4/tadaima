/** Keep native ESM Three.js tests in one module realm. tsx's CJS bridge loads
 * another Three.js class identity, which invalidates instanceof fixture checks.
 * Backend aliases/JSON tests use the application's tsx loader separately. */
import { spawnSync } from "node:child_process";
const groups = [
  ["--experimental-strip-types", "--test", ...["test-captured-model.mjs", "test-textured-model.mjs", "test-captured-furniture.mjs", "test-explode.mjs", "test-room-appearance.mjs", "test-navigation.mjs", "test-quest-open.mjs"].map((file) => `spatial/tests/${file}`)],
  ["--import", "tsx", "--test", "spatial/tests/test-workspace-xr.mjs", "spatial/tests/test-local-shopping.mjs", "reconstruction/local-preview.test.ts"],
];
for (const args of groups) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) { process.stderr.write(result.error.message + "\n"); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
