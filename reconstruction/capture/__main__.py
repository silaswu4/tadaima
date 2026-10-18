"""python3 -m reconstruction.capture --input capture.zip --output private/job."""

import argparse
import json
from pathlib import Path
import sys

from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError
from .bundle import BundleError
from .geometry import CaptureError
from .pipeline import run


def main(argv=None):
    parser = argparse.ArgumentParser(description="Mobile capture bundle -> measured room proposal -> optional Blender/GLB")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--blender")
    parser.add_argument("--expected-project")
    parser.add_argument("--expected-job")
    parser.add_argument("--expected-revision", type=int)
    args = parser.parse_args(argv)
    try:
        dossier = run(args.input, args.output, render=args.render, preview=args.preview, blender=args.blender,
                      expected_project=args.expected_project, expected_job=args.expected_job,
                      expected_revision=args.expected_revision)
        print(json.dumps({key: dossier[key] for key in (
            "schemaVersion", "projectId", "jobId", "inputRevision", "status", "reviewRequired", "method", "photoUsage",
            "photoCount", "missingMeasurements", "reconstructionRequestPath", "draftManifestPath")}, allow_nan=False))
        return 0
    except (CaptureError, BundleError, GeometryError, PipelineError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, (CaptureError, BundleError, GeometryError)) else "Capture processing failed; check private input/output paths and Blender setup."
        print(json.dumps({"error": type(error).__name__, "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
