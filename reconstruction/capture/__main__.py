"""python3 -m reconstruction.capture --input capture.zip --output private/job."""

import argparse
import json
import os
from pathlib import Path
import sys

from reconstruction.address.providers import OpenAIGeometryProvider, ProviderError
from reconstruction.address.schema import ResearchError
from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError
from .bundle import BundleError
from .geometry import CaptureError
from .pipeline import run


def main(argv=None):
    parser = argparse.ArgumentParser(description="Photo-only capture -> vision room proposal -> optional Blender/GLB")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--blender")
    inference = parser.add_mutually_exclusive_group()
    inference.add_argument("--proposal-file", type=Path, help="Hash-bound Codex vision handoff; no provider keys")
    inference.add_argument("--infer", action="store_true", help="Send capture images to the configured OpenAI vision provider")
    appearance = parser.add_mutually_exclusive_group()
    appearance.add_argument("--appearance-file", type=Path, help="Hash-bound room-finish handoff; no provider keys")
    appearance.add_argument("--infer-appearance", action="store_true", help="Send room photos for finish estimation after geometry is available")
    parser.add_argument("--model", help="Vision-capable model; alternatively set OPENAI_VISION_MODEL")
    parser.add_argument("--expected-project")
    parser.add_argument("--expected-job")
    parser.add_argument("--expected-revision", type=int)
    args = parser.parse_args(argv)
    try:
        provider = None
        if args.infer or args.infer_appearance:
            model = args.model or os.environ.get("OPENAI_VISION_MODEL")
            if not model:
                raise ProviderError("Set --model or OPENAI_VISION_MODEL for hosted inference")
            provider = OpenAIGeometryProvider(os.environ.get("OPENAI_API_KEY", ""), model)
        elif args.model:
            raise ProviderError("--model requires --infer or --infer-appearance")
        dossier = run(args.input, args.output, render=args.render, preview=args.preview, blender=args.blender,
                      expected_project=args.expected_project, expected_job=args.expected_job,
                      expected_revision=args.expected_revision, geometry_provider=provider if args.infer else None,
                      proposal_file=args.proposal_file, appearance_provider=provider if args.infer_appearance else None,
                      appearance_file=args.appearance_file)
        print(json.dumps({key: dossier[key] for key in (
            "schemaVersion", "projectId", "jobId", "inputRevision", "status", "reviewRequired", "method", "photoUsage",
            "photoCount", "missingMeasurements", "inferenceRequestPath", "proposalPath", "reconstructionRequestPath", "draftManifestPath")}, allow_nan=False))
        return 0
    except (CaptureError, BundleError, GeometryError, PipelineError, ProviderError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, (CaptureError, BundleError, GeometryError, ResearchError, ProviderError)) else "Capture processing failed; check private input/output paths and Blender setup."
        print(json.dumps({"error": type(error).__name__, "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
