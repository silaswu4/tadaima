"""python3 -m reconstruction.roomplan --input scan.json --output private/job."""

import argparse
import json
from pathlib import Path
import sys

from reconstruction.pipeline import PipelineError
from .importer import RoomPlanError, run


def main(argv=None):
    parser = argparse.ArgumentParser(description="Native RoomPlan scan -> reviewable room shell -> optional Blender/GLB")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--blender")
    parser.add_argument("--expected-project")
    parser.add_argument("--expected-job")
    parser.add_argument("--expected-revision", type=int)
    args = parser.parse_args(argv)
    try:
        result = run(args.input, args.output, render=args.render, blender=args.blender, preview=args.preview,
                     expected_project=args.expected_project, expected_job=args.expected_job,
                     expected_revision=args.expected_revision)
        print(json.dumps({key: result[key] for key in ("schemaVersion", "projectId", "jobId", "inputRevision", "status",
                                                     "reviewRequired", "sourcePath", "reconstructionRequestPath", "draftManifestPath")}))
        return 0
    except (RoomPlanError, PipelineError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, RoomPlanError) else "RoomPlan processing failed; inspect private paths and Blender setup."
        print(json.dumps({"error": type(error).__name__, "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
