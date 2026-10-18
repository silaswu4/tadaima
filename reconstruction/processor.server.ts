/** Node-only local adapter. Import on the server, never from frontend/spatial. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ReconstructionManifest, ReconstructionProcessor, ReconstructionRequest } from "./contracts";

const execute = promisify(execFile);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface LocalProcessorOptions {
  /** Absolute path to the repository, which contains reconstruction/cli.py. */
  projectRoot: string;
  /** Private artifact root; do not use public/. Each job gets a fresh child. */
  outputRoot: string;
  blenderPath?: string;
  pythonPath?: string;
  timeoutSeconds?: number;
}

export class LocalReconstructionProcessor implements ReconstructionProcessor {
  private readonly options: LocalProcessorOptions;

  constructor(options: LocalProcessorOptions) {
    this.options = options;
    if (!isAbsolute(options.projectRoot) || !isAbsolute(options.outputRoot)) {
      throw new Error("projectRoot and outputRoot must be absolute paths");
    }
    const timeout = options.timeoutSeconds ?? 120;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) {
      throw new Error("timeoutSeconds must be between 0 and 3600");
    }
  }

  getOutputDirectory(request: Pick<ReconstructionRequest, "projectId" | "jobId">): string {
    if (!safeId.test(request.projectId) || !safeId.test(request.jobId)) {
      throw new Error("projectId and jobId must be safe ASCII IDs of at most 64 characters");
    }
    return join(this.options.outputRoot, request.projectId, request.jobId);
  }

  async generate(request: ReconstructionRequest): Promise<ReconstructionManifest> {
    const output = this.getOutputDirectory(request);
    const staging = await mkdtemp(join(tmpdir(), "tadaima-reconstruction-"));
    try {
      const input = join(staging, "request.json");
      await writeFile(input, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
      const timeout = this.options.timeoutSeconds ?? 120;
      const args = ["-m", "reconstruction.cli", "build", "--input", input,
        "--output", output, "--timeout", String(timeout)];
      if (this.options.blenderPath) args.push("--blender", this.options.blenderPath);
      const { stdout } = await execute(this.options.pythonPath ?? "python3", args, {
        cwd: this.options.projectRoot,
        timeout: (timeout + 15) * 1000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const result: ReconstructionManifest = JSON.parse(stdout);
      if (result.schemaVersion !== "1.0" || result.projectId !== request.projectId ||
          result.jobId !== request.jobId || result.inputRevision !== request.inputRevision ||
          !result.artifacts?.glbAssetId || !result.files?.glb?.sha256) {
        throw new Error("Reconstruction returned an invalid or mismatched manifest");
      }
      return result;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
