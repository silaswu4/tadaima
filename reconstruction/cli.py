"""Run from repository root: python3 -m reconstruction.cli --help."""

import argparse
import json
from pathlib import Path
import sys

from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError, generate, read_request


def main(argv=None):
    parser = argparse.ArgumentParser(description="Metric room geometry -> editable Blender scene and GLB")
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate", help="Validate geometry without needing Blender")
    validate.add_argument("--input", required=True, type=Path)
    build = sub.add_parser("build", help="Generate a fresh artifact directory")
    build.add_argument("--input", required=True, type=Path)
    build.add_argument("--output", required=True, type=Path)
    build.add_argument("--blender", help="Blender 4.5 LTS+ executable; defaults to BLENDER_BIN or PATH")
    build.add_argument("--timeout", default=120.0, type=float, help="Blender runtime limit in seconds")
    build.add_argument("--preview", action="store_true", help="Also render a CPU Cycles PNG")
    build.add_argument("--photo-bundle", type=Path, help="Original matching native scan+photos ZIP for automatic calibrated texture projection")
    args = parser.parse_args(argv)
    try:
        if args.command == "validate":
            request = read_request(args.input)
            result = {"valid": True, "jobId": request["jobId"], "projectId": request["projectId"],
                      "inputRevision": request["inputRevision"]}
        else:
            result = generate(args.input, args.output, blender=args.blender,
                              timeout=args.timeout, preview=args.preview, photo_bundle=args.photo_bundle)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0
    except (GeometryError, PipelineError, OSError, ValueError) as error:
        print(json.dumps({"error": type(error).__name__, "message": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
