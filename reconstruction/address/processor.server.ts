/** Node worker adapter. Run from a background job, never a browser import. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { AddressResearchProcessor, AddressResearchReceipt, AddressResearchRequest } from "./contracts";

const execute = promisify(execFile);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AddressProcessorOptions {
  projectRoot: string;
  outputRoot: string;
  pythonPath?: string;
  blenderPath?: string;
  /** Produce an unconfirmed visual draft when valid geometry exists. */
  renderDraft?: boolean;
}

export class LocalAddressResearchProcessor implements AddressResearchProcessor {
  private readonly options: AddressProcessorOptions;

  constructor(options: AddressProcessorOptions) {
    this.options = options;
    if (!isAbsolute(options.projectRoot) || !isAbsolute(options.outputRoot)) {
      throw new Error("projectRoot and outputRoot must be absolute private worker paths");
    }
  }

  getOutputDirectory(request: Pick<AddressResearchRequest, "projectId" | "jobId">): string {
    if (!safeId.test(request.projectId) || !safeId.test(request.jobId)) {
      throw new Error("projectId and jobId must be safe ASCII IDs");
    }
    return join(this.options.outputRoot, request.projectId, request.jobId);
  }

  async research(request: AddressResearchRequest): Promise<AddressResearchReceipt> {
    const output = this.getOutputDirectory(request);
    const temporary = await mkdtemp(join(tmpdir(), "tadaima-address-"));
    try {
      const input = join(temporary, "request.json");
      await writeFile(input, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
      const args = ["-m", "reconstruction.address", "--input", input, "--output", output];
      if (this.options.renderDraft) args.push("--render-draft");
      if (this.options.blenderPath) args.push("--blender", this.options.blenderPath);
      // Credentials are inherited from the server environment, never argv or JSON.
      const { stdout } = await execute(this.options.pythonPath ?? "python3", args, {
        cwd: this.options.projectRoot, timeout: 2400 * 1000,
        maxBuffer: 1024 * 1024, windowsHide: true,
      });
      const result: AddressResearchReceipt = JSON.parse(stdout);
      if (result.schemaVersion !== "address-research/1.0" ||
          result.projectId !== request.projectId || result.jobId !== request.jobId ||
          result.inputRevision !== request.inputRevision || result.reviewRequired !== true ||
          result.dossierPath !== join(output, "dossier.json") ||
          !["evidence_collected", "needs_evidence", "needs_review", "draft_ready"].includes(result.status)) {
        throw new Error("Address research returned an invalid or mismatched receipt");
      }
      return result;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
