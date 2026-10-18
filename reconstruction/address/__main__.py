"""Server/local worker CLI. No HTTP route or provider secrets in browser code."""

import argparse
import json
import os
from pathlib import Path
import sys
import uuid

from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError
from .pipeline import read_json, run
from .providers import BrowserUseResearchProvider, OpenAIGeometryProvider, ProviderError
from .schema import ResearchError


def main(argv=None):
    parser = argparse.ArgumentParser(description="Address -> public spatial evidence -> grounded geometry draft -> optional Blender/GLB")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--input", type=Path, help="Private research request JSON")
    target.add_argument("--address", help="Full address including city/region")
    parser.add_argument("--unit")
    parser.add_argument("--project-id", default="address-demo")
    parser.add_argument("--job-id", default=None)
    parser.add_argument("--target-room", default="entire unit")
    parser.add_argument("--listing-url", action="append", default=[])
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--discovery-file", type=Path, help="Explicit pre-researched/recorded discovery; bypasses Browser Use")
    parser.add_argument("--proposal-file", type=Path, help="Hash-attested geometry handoff from Codex or another external agent; requires --discovery-file, bypasses OpenAI")
    parser.add_argument("--collect-only", action="store_true", help="Acquire evidence without model extraction")
    parser.add_argument("--rounds", type=int, choices=[1, 2], default=2)
    parser.add_argument("--research-timeout", type=float, default=240)
    parser.add_argument("--max-cost-per-round", type=float, default=2)
    parser.add_argument("--render-draft", action="store_true", help="Generate a labeled, unconfirmed Blender/GLB draft if valid geometry exists")
    parser.add_argument("--blender")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.proposal_file and (not args.discovery_file or args.collect_only):
            raise ResearchError("--proposal-file requires --discovery-file and cannot be combined with --collect-only")
        request = read_json(args.input) if args.input else {
            "projectId": args.project_id, "jobId": args.job_id or "research-" + uuid.uuid4().hex[:16],
            "inputRevision": 0, "address": args.address, "unit": args.unit,
            "listingUrls": args.listing_url, "targetRoom": args.target_room,
        }
        discovery = read_json(args.discovery_file) if args.discovery_file else None
        research = None if discovery is not None else BrowserUseResearchProvider(
            os.environ.get("BROWSER_USE_API_KEY", ""), timeout_seconds=args.research_timeout,
            max_cost_usd=args.max_cost_per_round, model=os.environ.get("BROWSER_USE_MODEL"))
        if args.proposal_file:
            from .handoff import FileGeometryProvider
            geometry = FileGeometryProvider(args.proposal_file)
        else:
            geometry = None if args.collect_only else OpenAIGeometryProvider(
                os.environ.get("OPENAI_API_KEY", ""), os.environ.get("OPENAI_MODEL", ""))
        dossier = run(request, args.output, research_provider=research, geometry_provider=geometry,
                      discovery=discovery, collect_only=args.collect_only, research_rounds=args.rounds,
                      render_draft=args.render_draft, blender=args.blender, preview=args.preview)
        # Return compact receipt: full address/photos/source text stay in private files.
        print(json.dumps({"schemaVersion": dossier["schemaVersion"], "status": dossier["status"],
                          "projectId": request["projectId"], "jobId": request["jobId"],
                          "inputRevision": request["inputRevision"], "reviewRequired": True,
                          "sourceCount": len(dossier["sources"]),
                          "downloadedAssetCount": sum(a["status"] == "downloaded" for a in dossier["assets"]),
                          "dossierPath": str(args.output.resolve() / "dossier.json"),
                          "reconstructionRequestPath": dossier.get("reconstructionRequestPath"),
                          "draftManifestPath": dossier.get("draftManifestPath"),
                          "execution": dossier["execution"]}, allow_nan=False))
        return 0
    except (ResearchError, ProviderError, GeometryError, PipelineError, OSError, ValueError) as error:
        # Known exception messages avoid provider response bodies and API secrets.
        message = str(error) if isinstance(error, (ResearchError, ProviderError, GeometryError)) else "Research job failed; check input paths and worker setup."
        print(json.dumps({"error": type(error).__name__, "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
