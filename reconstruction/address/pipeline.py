"""Bounded address -> evidence -> geometry proposal -> optional Blender draft.

Only trusted local worker code runs. Model output is data, independently checked
against downloaded evidence and the existing geometric validator before Blender.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re

from reconstruction.geometry import GeometryError, validate_request
from reconstruction.pipeline import generate
from .assets import downloadable_asset, extract_page_assets
from .network import FetchError, PublicFetcher, public_url
from .prompts import discovery_task, geometry_prompt
from .schema import DISCOVERY_SCHEMA, PROPOSAL_SCHEMA, ResearchError, validate, validate_input


MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024
MAX_ASSETS = 40


def read_json(path):
    if Path(path).stat().st_size > 2 * 1024 * 1024:
        raise ResearchError("JSON input exceeds 2 MiB")
    body = Path(path).read_bytes()
    if len(body) > 2 * 1024 * 1024:
        raise ResearchError("JSON input exceeds 2 MiB")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ResearchError("JSON input contains duplicate keys")
            result[key] = value
        return result
    return json.loads(body, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ResearchError("Nonfinite JSON value")))


def _write(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def _sha(body):
    return hashlib.sha256(body).hexdigest()


def _unique(entries, kind):
    values = {entry["id"]: entry for entry in entries}
    if len(values) != len(entries):
        raise ResearchError(f"Duplicate {kind} ID")
    return values


def validate_discovery(raw):
    validate(raw, DISCOVERY_SCHEMA, "discovery")
    sources = _unique(raw["sources"], "source")
    candidates = _unique(raw["candidates"], "candidate")
    if set(sources) & set(candidates):
        raise ResearchError("Source and candidate IDs must be distinct")
    for source in sources.values():
        public_url(source["url"])
    for candidate in candidates.values():
        if not candidate["sourceIds"] or set(candidate["sourceIds"]) - sources.keys():
            raise ResearchError("Candidate references missing sources")
    for asset in raw["assets"]:
        public_url(asset["url"])
        if asset["sourceId"] not in sources or (asset["candidateId"] is not None and asset["candidateId"] not in candidates):
            raise ResearchError("Asset references a missing source or candidate")
        if asset["candidateId"] and asset["sourceId"] not in candidates[asset["candidateId"]]["sourceIds"]:
            raise ResearchError("Asset source is outside its candidate")
    return raw


def _unit(value):
    return re.sub(r"^(?:unit|apt|apartment|suite|#)\s*", "", (value or "").lower()).strip()


def _acquire(discovery, dossier, output, fetcher, *, source_limit=12, candidate_limit=12,
             asset_limit=MAX_ASSETS, byte_limit=MAX_TOTAL_ASSET_BYTES):
    known_sources = {s["id"]: s for s in dossier["sources"]}
    known_urls = {s["url"] for s in dossier["sources"]}
    # Later rounds are additive. Never silently replace already-inspected records.
    remap = {}
    pending = []
    for entry in discovery["sources"]:
        url = public_url(entry["url"])
        if url in known_urls:
            remap[entry["id"]] = next(s["id"] for s in dossier["sources"] if s["url"] == url)
            continue
        if len(dossier["sources"]) >= source_limit:
            continue
        source_id = f"src{len(dossier['sources']) + 1:03}"
        remap[entry["id"]] = source_id
        source = {**entry, "id": source_id, "url": url, "status": "unfetched", "text": "", "links": []}
        if source["scope"] == "exact_unit" and dossier["request"]["unit"] and _unit(source["unitText"]) != _unit(dossier["request"]["unit"]):
            source["scope"] = "unknown"
            source["scopeWarning"] = "Declared exact-unit source lacks matching unit text"
        dossier["sources"].append(source)
        known_sources[source_id] = source
        known_urls.add(url)
        try:
            response = fetcher.fetch(url, max_bytes=2 * 1024 * 1024)
            if response.content_type not in {"text/html", "application/xhtml+xml", "text/plain"}:
                # Direct PDF/image sources are acquired below and remain cited.
                downloadable_asset(response)
                pending.append({"url": url, "sourceId": source_id, "candidateId": None,
                                "kind": "unknown", "label": source["title"]})
                source["status"] = "media_source"
                continue
            page = extract_page_assets(response.body.decode("utf-8", errors="replace"), response.url)
            relative = f"pages/{source_id}.html"
            (output / relative).write_bytes(response.body)
            source.update(status="fetched", finalUrl=response.url, pagePath=relative,
                          sha256=_sha(response.body), byteLength=len(response.body),
                          fetchedTitle=page["title"], text=page["text"], links=page["links"])
            pending.extend({**asset, "sourceId": source_id, "candidateId": None} for asset in page["assets"])
        except FetchError as error:
            source.update(status="failed", error=str(error))
    candidate_remap = {}
    for entry in discovery["candidates"]:
        source_ids = list(dict.fromkeys(remap[s] for s in entry["sourceIds"] if s in remap))
        if not source_ids:
            continue
        existing = next((c for c in dossier["candidates"] if c["label"] == entry["label"] and c["sourceIds"] == source_ids), None)
        if existing:
            candidate_remap[entry["id"]] = existing["id"]
        elif len(dossier["candidates"]) < candidate_limit:
            candidate_id = f"candidate{len(dossier['candidates']) + 1:03}"
            candidate = {**entry, "id": candidate_id, "sourceIds": source_ids}
            if candidate["scope"] == "exact_unit" and not any(known_sources[s]["scope"] == "exact_unit" for s in source_ids):
                candidate["scope"] = "unknown"
            dossier["candidates"].append(candidate)
            candidate_remap[entry["id"]] = candidate_id
    # Agent-inspected URLs precede extracted gallery candidates. Extraction does
    # not guess a unit/candidate for every picture on a multi-plan building page.
    explicit = [{**a, "sourceId": remap[a["sourceId"]],
                 "candidateId": candidate_remap.get(a["candidateId"])}
                for a in discovery["assets"] if a["sourceId"] in remap
                and (a["candidateId"] is None or a["candidateId"] in candidate_remap)]
    pending = sorted(explicit + pending, key=lambda a: {"floor_plan": 0, "document": 1, "photo": 2, "unknown": 3, "tour": 4}[a["kind"]])
    urls = {a["url"] for a in dossier["assets"]}
    total = sum(a.get("byteLength", 0) for a in dossier["assets"])
    for entry in pending:
        url = public_url(entry["url"])
        if url in urls:
            previous = next(a for a in dossier["assets"] if a["url"] == url)
            # A later explicitly researched association can refine an unassigned
            # extraction, but must not erase an earlier named candidate/source.
            if entry["candidateId"] and previous["sourceId"] == entry["sourceId"]:
                if previous["candidateId"] is None:
                    previous["attributionBeforeResearch"] = {"candidateId": None, "kind": previous["kind"], "label": previous["label"]}
                    previous.update(candidateId=entry["candidateId"], kind=entry["kind"], label=entry["label"])
                elif previous["candidateId"] != entry["candidateId"]:
                    previous["conflictingCandidateIds"] = sorted(set(previous.get("conflictingCandidateIds", []) + [previous["candidateId"], entry["candidateId"]]))
            continue
        if len(dossier["assets"]) >= asset_limit:
            continue
        if byte_limit < MAX_TOTAL_ASSET_BYTES and total >= byte_limit:
            # Leave unattempted first-round URLs available for the reserved
            # second-round byte budget, rather than marking them permanently bad.
            continue
        urls.add(url)
        asset_id = f"asset{len(dossier['assets']) + 1:03}"
        asset = {**entry, "id": asset_id, "url": url, "status": "unfetched", "sentToVision": False}
        dossier["assets"].append(asset)
        if asset["kind"] == "tour":
            asset["status"] = "reference_only"
            continue
        if total >= byte_limit:
            asset["status"] = "budget_exhausted"
            continue
        try:
            response = fetcher.fetch(url, max_bytes=min(8 * 1024 * 1024, byte_limit - total))
            media = downloadable_asset(response)
            digest = _sha(response.body)
            duplicate = next((a for a in dossier["assets"] if a.get("sha256") == digest), None)
            relative = duplicate["path"] if duplicate else f"assets/{asset_id}.{media['extension']}"
            if not duplicate:
                (output / relative).write_bytes(response.body)
            total += len(response.body)
            asset.update(status="downloaded", path=relative, finalUrl=response.url,
                         sha256=digest, byteLength=len(response.body), mediaType=media["mediaType"])
        except FetchError as error:
            asset.update(status="failed", error=str(error))
    dossier["discoveryGaps"] = list(dict.fromkeys(dossier["discoveryGaps"] + discovery["gaps"]))[:40]
    dossier["discoveryConflicts"] = list(dict.fromkeys(dossier["discoveryConflicts"] + discovery["conflicts"]))[:40]


def _attachments(dossier, output):
    selected, images, pdfs, hashes, total = [], 0, 0, set(), 0
    scopes = {c["id"]: c["scope"] for c in dossier["candidates"]}
    ordered = sorted(dossier["assets"], key=lambda a: (
        {"floor_plan": 0, "document": 1, "photo": 2, "unknown": 3, "tour": 4}[a["kind"]],
        scopes.get(a["candidateId"]) != "exact_unit",
    ))
    for asset in dossier["assets"]:
        asset["sentToVision"] = False
    for asset in ordered:
        if asset["status"] != "downloaded" or asset["sha256"] in hashes:
            continue
        description = (asset["label"] + " " + asset["url"]).lower()
        if asset["kind"] != "floor_plan" and re.search(
            r"(?:^|[/_.\s-])(?:logo|favicon|icon|pixel|spinner|loader|tracking|analytics|close)(?:$|[/_.\s-])", description):
            continue
        if asset["kind"] == "document" and not re.search(
            r"floor|layout|brochure|architect|building|property|dimension|unit|room", description):
            # Keep ancillary legal documents inventoried without spending vision
            # PDF slots on them. Relevant PDFs can still be explicitly classified.
            continue
        is_pdf = asset["mediaType"] == "application/pdf"
        if (is_pdf and pdfs >= 2) or (not is_pdf and images >= 8) or total + asset["byteLength"] > MAX_TOTAL_ASSET_BYTES:
            continue
        asset["sentToVision"] = True
        hashes.add(asset["sha256"])
        images += not is_pdf
        pdfs += is_pdf
        total += asset["byteLength"]
        selected.append({"id": asset["id"], "mediaType": asset["mediaType"], "body": (output / asset["path"]).read_bytes()})
    return selected


def ground_proposal(proposal, dossier):
    """Verify all citations/field bindings, then reuse canonical geometry validation."""
    validate(proposal, PROPOSAL_SCHEMA, "proposal")
    if proposal["geometry"] is None:
        if proposal["claims"] or proposal["bindings"]:
            raise ResearchError("A null geometry proposal must leave claims and bindings empty")
        return None
    sources = {s["id"]: s for s in dossier["sources"]}
    assets = {a["id"]: a for a in dossier["assets"] if a["sentToVision"]}
    candidates = {c["id"]: c for c in dossier["candidates"]}
    candidate = candidates.get(proposal["selectedCandidateId"])
    if not candidate:
        raise ResearchError("Geometry requires one existing selectedCandidateId")
    claims = _unique(proposal["claims"], "claim")
    evidence = []
    plan_claims = set()
    for claim in claims.values():
        if not claim["sourceIds"] and not claim["assetIds"]:
            raise ResearchError("Every claim needs inspected source or asset evidence")
        if set(claim["sourceIds"]) - sources.keys() or set(claim["assetIds"]) - assets.keys():
            raise ResearchError("Claim cites unknown or uninspected evidence")
        if set(claim["sourceIds"]) - set(candidate["sourceIds"]):
            raise ResearchError("Claim source is outside the selected layout candidate")
        for source_id in claim["sourceIds"]:
            media_inspected = sources[source_id]["status"] == "media_source" and any(
                assets[asset_id]["sourceId"] == source_id for asset_id in claim["assetIds"])
            if sources[source_id]["status"] != "fetched" and not media_inspected:
                raise ResearchError("Claim cites source text that was not downloaded")
        for asset_id in claim["assetIds"]:
            asset = assets[asset_id]
            if asset["sourceId"] not in candidate["sourceIds"]:
                raise ResearchError("Claim asset source is outside the selected layout candidate")
            if asset["candidateId"] and asset["candidateId"] != candidate["id"]:
                raise ResearchError("Claim mixes assets from different layout candidates")
            if asset.get("conflictingCandidateIds"):
                raise ResearchError("Claim cites an asset with conflicting layout attribution")
            if asset["kind"] == "floor_plan" and asset["sourceId"] in candidate["sourceIds"]:
                plan_claims.add(claim["id"])
        source_url = sources[claim["sourceIds"][0]]["url"] if claim["sourceIds"] else assets[claim["assetIds"][0]]["url"]
        evidence.append({"id": claim["id"], "sourceUrl": source_url,
                         "privateAssetId": f"{dossier['request']['projectId']}/{dossier['request']['jobId']}/{claim['assetIds'][0]}" if claim["assetIds"] else None,
                         "observedAt": dossier["observedAt"],
                         "claim": f"Unconfirmed address-derived draft ({candidate['scope']}): {claim['text']}",
                         "dimensionStatus": claim["dimensionStatus"], "confirmedByUserAt": None})
    if not plan_claims:
        raise ResearchError("Geometry must cite an inspected floor plan from the selected candidate's sources")
    request = {key: dossier["request"][key] for key in ("jobId", "projectId", "inputRevision")}
    request.update(geometry=proposal["geometry"], evidence=evidence)
    request = validate_request(request)
    entities = {}
    for collection, fields in (("rooms", ("floorPolygon", "height")),
                               ("walls", ("start", "end", "height", "thickness")),
                               ("openings", ("offset", "width", "height", "sillHeight"))):
        for entity in request["geometry"][collection]:
            if entity["id"] in entities:
                raise ResearchError("Geometry IDs must be unique across entity types")
            entities[entity["id"]] = (entity, fields)
    expected = {(key, field) for key, (_, fields) in entities.items() for field in fields}
    found = set()
    for binding in proposal["bindings"]:
        key = (binding["elementId"], binding["field"])
        if key not in expected or key in found:
            raise ResearchError("Binding has unknown entity/field or duplicates another binding")
        entity = entities[key[0]][0]
        refs = set(binding["evidenceIds"])
        if not refs or refs - set(entity["evidenceIds"]):
            raise ResearchError("Binding must cite its entity's evidence")
        if binding["method"] == "source_dimension" and any(claims[ref]["dimensionStatus"] != "source_dimension" for ref in refs):
            raise ResearchError("Source dimension binding cannot upgrade inferred evidence")
        if binding["field"] == "floorPolygon" and not refs & plan_claims:
            raise ResearchError("Room floor polygon must cite the selected candidate plan")
        found.add(key)
    if found != expected:
        raise ResearchError("Missing numeric-field evidence bindings")
    return request


def _appearance_photos(request, dossier, output, selected_candidate_id):
    """Bind independently downloaded photo bytes without upgrading unit scope."""
    sources = {source["id"]: source for source in dossier["sources"]}
    candidates = {candidate["id"]: candidate for candidate in dossier["candidates"]}
    photos, seen, total = [], set(), 0
    for asset in dossier["assets"]:
        if (asset["status"] != "downloaded" or asset["kind"] != "photo"
                or asset.get("mediaType") not in ("image/jpeg", "image/png")
                or asset.get("conflictingCandidateIds")
                or asset["candidateId"] not in (None, selected_candidate_id)
                or asset["sha256"] in seen):
            continue
        if len(photos) >= 8 or total + asset["byteLength"] > MAX_TOTAL_ASSET_BYTES:
            continue
        with (output / asset["path"]).open("rb") as handle:
            body = handle.read(8 * 1024 * 1024 + 1)
        if len(body) != asset["byteLength"] or _sha(body) != asset["sha256"]:
            raise ResearchError("Appearance photo bytes differ from downloaded evidence")
        source = sources[asset["sourceId"]]
        candidate = candidates.get(asset["candidateId"])
        scope = ("exact_unit" if source["scope"] == "exact_unit" and candidate
                 and candidate["scope"] == "exact_unit" else
                 "building_reference" if source["scope"] in ("building_generic", "apartment_type")
                 or (candidate and candidate["scope"] in ("building_generic", "apartment_type")) else "unknown")
        # This ID is derived from a verified file, independent of model claims.
        evidence_id = "appearance-" + hashlib.sha256(
            f"{asset['id']}:{asset['sha256']}".encode()).hexdigest()[:40]
        if any(entry["id"] == evidence_id for entry in request["evidence"]):
            raise ResearchError("Appearance evidence ID collides with existing evidence")
        request["evidence"].append({"id": evidence_id, "sourceUrl": asset["url"],
            "privateAssetId": f"{request['projectId']}/{request['jobId']}/{asset['id']}",
            "observedAt": dossier["observedAt"], "claim": (
                f"Downloaded room photo supplied for appearance estimation ({scope}); "
                "unit/room applicability and intrinsic finishes remain unconfirmed."),
            "dimensionStatus": None, "confirmedByUserAt": None})
        photos.append({"id": asset["id"], "evidenceId": evidence_id, "sha256": asset["sha256"],
                       "mediaType": asset["mediaType"], "body": body, "scope": scope})
        seen.add(asset["sha256"])
        total += len(body)
    return photos


def run(raw_request, output_path, *, research_provider=None, geometry_provider=None,
        discovery=None, fetcher=None, collect_only=False, research_rounds=2,
        render_draft=False, blender=None, preview=False, appearance_provider=None,
        appearance_file=None):
    if appearance_provider is not None and appearance_file is not None:
        raise ResearchError("Choose either an appearance provider or an appearance file")
    appearance_requested = appearance_provider is not None or appearance_file is not None
    if collect_only and appearance_requested:
        raise ResearchError("Appearance inference requires geometry; omit collect_only")
    request = validate_input(raw_request)
    for url in request["listingUrls"]:
        public_url(url)
    if isinstance(research_rounds, bool) or research_rounds not in {1, 2}:
        raise ResearchError("research_rounds must be 1 or 2")
    if discovery is None and research_provider is None:
        raise ResearchError("A research provider or explicit discovery file is required")
    if not collect_only and geometry_provider is None:
        raise ResearchError("A geometry provider is required unless collect_only=True")
    if collect_only and render_draft:
        raise ResearchError("Cannot render a draft in collect-only mode")
    output = Path(output_path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(mode=0o700)  # Fresh directory; never overwrite another job.
    (output / "pages").mkdir(mode=0o700)
    (output / "assets").mkdir(mode=0o700)
    dossier = {"schemaVersion": "address-research/1.0", "status": "researching",
               "request": request, "observedAt": datetime.now(timezone.utc).isoformat(),
               "execution": {"research": "discovery_file" if discovery is not None else "research_provider",
                             "geometry": "not_requested" if collect_only else getattr(geometry_provider, "mode", "geometry_provider"),
                             "declaredProducer": getattr(geometry_provider, "producer", None)},
               "reviewRequired": True, "sources": [], "candidates": [], "assets": [],
               "discoveryGaps": [], "discoveryConflicts": [], "rounds": [], "warnings": [
                   "All geometry is a proposal. Source applicability and dimensions require review.",
                   "Research is bounded public evidence collection, not exhaustive property coverage."]}
    if appearance_requested:
        dossier["appearanceStatus"] = "needs_geometry"
    fetcher = fetcher or PublicFetcher()
    _write(output / "dossier.json", dossier)
    try:
        for index in range(research_rounds):
            raw = discovery if index == 0 and discovery is not None else research_provider.research(
                discovery_task(request, dossier if index else None), DISCOVERY_SCHEMA)
            validated = validate_discovery(raw)
            _write(output / f"discovery-{index + 1}.json", validated)
            dossier["rounds"].append({"round": index + 1, "summary": validated["summary"]})
            reserve = index == 0 and research_rounds == 2 and research_provider is not None
            _acquire(validated, dossier, output, fetcher,
                     source_limit=8 if reserve else 12, candidate_limit=8 if reserve else 12,
                     asset_limit=24 if reserve else MAX_ASSETS,
                     byte_limit=24 * 1024 * 1024 if reserve else MAX_TOTAL_ASSET_BYTES)
            _write(output / "dossier.json", dossier)
            exact_candidates = {c["id"] for c in dossier["candidates"] if c["scope"] == "exact_unit"}
            if research_provider is None or any(
                a["status"] == "downloaded" and a["kind"] == "floor_plan"
                and (not request["unit"] or a["candidateId"] in exact_candidates)
                for a in dossier["assets"]):
                break
        if collect_only:
            dossier["status"] = "evidence_collected"
        else:
            attachments = _attachments(dossier, output)
            if not attachments or not any(a["sentToVision"] and a["kind"] == "floor_plan" for a in dossier["assets"]):
                dossier.update(status="needs_evidence", missingEvidence=["A downloadable floor plan or spatial PDF is needed before geometry extraction."])
            else:
                feedback = None
                for attempt in range(2):
                    proposal = geometry_provider.extract(geometry_prompt(request, dossier, feedback), attachments, PROPOSAL_SCHEMA)
                    _write(output / f"proposal-{attempt + 1}.json", proposal)
                    try:
                        reconstruction = ground_proposal(proposal, dossier)
                        break
                    except (ResearchError, GeometryError) as error:
                        feedback = str(error)
                        if attempt == 1:
                            raise ResearchError(f"Geometry proposal failed validation after repair: {feedback}") from error
                dossier["proposal"] = proposal
                if reconstruction is None:
                    dossier["status"] = "needs_evidence"
                else:
                    inferred = any(b["method"] == "inferred" for b in proposal["bindings"])
                    selected = next(c for c in dossier["candidates"] if c["id"] == proposal["selectedCandidateId"])
                    dossier["status"] = "needs_review" if (inferred or selected["scope"] != "exact_unit" or proposal["missingMeasurements"] or proposal["conflicts"] or dossier["discoveryConflicts"]) else "draft_ready"
                    if appearance_requested:
                        from reconstruction.appearance import FileAppearanceProvider, infer_appearance, prepare_appearance
                        photos = _appearance_photos(reconstruction, dossier, output, selected["id"])
                        dossier["appearanceStatus"] = "needs_photos"
                        if photos:
                            # Keep the exact hash-bound inputs available if a
                            # hosted call or supplied local handoff fails.
                            _write(output / "reconstruction.request.json", reconstruction)
                            _write(output / "appearance.inference.request.json", prepare_appearance(reconstruction, photos))
                            dossier["reconstructionRequestPath"] = "reconstruction.request.json"
                            dossier["appearanceInferenceRequestPath"] = "appearance.inference.request.json"
                            provider = (FileAppearanceProvider(appearance_file, reconstruction, photos)
                                        if appearance_file is not None else appearance_provider)
                            reconstruction = infer_appearance(reconstruction, photos, provider)
                            dossier["appearanceStatus"] = ("estimated_needs_review" if reconstruction["appearance"]["surfaces"]
                                                           else "needs_photo_review")
                            dossier["appearancePhotoIds"] = [photo["id"] for photo in photos]
                            dossier["status"] = "needs_review"
                            dossier["warnings"].append(
                                "Photo-derived finishes require review; building references do not establish exact-unit appearance."
                                if reconstruction["appearance"]["surfaces"] else
                                "No visible finishes could be bound to room surfaces; styling defaults remain unverified.")
                        else:
                            dossier["status"] = "needs_review"
                            dossier["warnings"].append("No usable room photos were available for appearance; styling defaults remain unverified.")
                    _write(output / "reconstruction.request.json", reconstruction)
                    dossier["reconstructionRequestPath"] = "reconstruction.request.json"
                    if render_draft:
                        manifest = generate(output / "reconstruction.request.json", output / "draft", blender=blender, preview=preview)
                        manifest["warnings"].append("Unconfirmed address-derived draft; review dossier.json for unit applicability, inferred measurements and conflicts.")
                        _write(output / "draft/manifest.json", manifest)
                        dossier["draftManifestPath"] = "draft/manifest.json"
                        dossier["draftInputSha256"] = manifest["inputSha256"]
        _write(output / "dossier.json", dossier)
        return dossier
    except Exception as error:
        # Providers/network expose sanitized errors; never persist their raw HTTP
        # bodies or credentials. Preserve acquired evidence for a diagnosable job.
        dossier.update(status="failed", error={"type": type(error).__name__,
                                             "message": str(error) if isinstance(error, (ResearchError, GeometryError)) else "Research/provider/generation failed; inspect the calling error."})
        _write(output / "dossier.json", dossier)
        raise
