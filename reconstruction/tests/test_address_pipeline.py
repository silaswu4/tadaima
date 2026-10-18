"""Synthetic address research integration tests with no live providers.

The property, dimension claims, and image responses are fixtures, not evidence
that a real address or physical dimension has been researched or measured.
"""

from copy import deepcopy
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from reconstruction.address.network import FetchError, FetchResult
from reconstruction.address.pipeline import _acquire, ground_proposal, read_json, run, validate_discovery
from reconstruction.address.providers import ProviderError
from reconstruction.address.schema import DISCOVERY_SCHEMA, PROPOSAL_SCHEMA, ResearchError, validate, validate_input
from reconstruction.geometry import validate_request


PAGE_URL = "https://property.example/unit-201"
PLAN_URL = "https://property.example/unit-201/floorplan.png"
PHOTO_URL = "https://property.example/unit-201/living-room.png"
# A tiny valid PNG; synthetic protocol fixture, not a real property photo.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGNsAAAAASUVORK5CYII=")
HTML = b"<html><title>Synthetic Unit 201</title><body>Unit 201 protocol fixture. No real property.</body></html>"


def address_request(**changes):
    return {"jobId": "address-test", "projectId": "synthetic-property", "inputRevision": 7,
            "address": "100 Synthetic Example Street", "unit": "201", "targetRoom": "living room",
            "listingUrls": [PAGE_URL], **changes}


def discovery_fixture(scope="exact_unit", include_plan=True):
    return {
        "summary": "Synthetic research provider fixture, no live property research",
        "sources": [{"id": "agent-source", "url": PAGE_URL, "title": "Synthetic Unit 201",
                     "kind": "property_manager", "scope": scope,
                     "matchReason": "Synthetic matching fixture", "addressText": "100 Synthetic Example Street",
                     "unitText": "201", "findings": ["Synthetic layout fixture"]}],
        "candidates": [{"id": "agent-candidate", "label": "Synthetic Unit 201 layout", "scope": scope,
                        "sourceIds": ["agent-source"], "matchReason": "Synthetic matching fixture"}],
        "assets": ([{"url": PLAN_URL, "sourceId": "agent-source", "candidateId": "agent-candidate",
                    "kind": "floor_plan", "label": "Synthetic floor plan"}] if include_plan else []) + [
                   {"url": PHOTO_URL, "sourceId": "agent-source", "candidateId": "agent-candidate",
                    "kind": "photo", "label": "Synthetic room photo"}],
        "gaps": [], "conflicts": [],
    }


def proposal_fixture(method="source_dimension"):
    geometry = read_json(Path(__file__).parents[1] / "fixtures/living-room.request.json")["geometry"]
    bindings = []
    for collection, fields in (("rooms", ("floorPolygon", "height")),
                               ("walls", ("start", "end", "height", "thickness")),
                               ("openings", ("offset", "width", "height", "sillHeight"))):
        for entity in geometry[collection]:
            entity["evidenceIds"] = ["claim001"]
            for field in fields:
                bindings.append({"elementId": entity["id"], "field": field, "evidenceIds": ["claim001"],
                                 "method": method, "explanation": "Synthetic dimension binding fixture"})
    return {"summary": "Synthetic geometry proposal", "selectedCandidateId": "candidate001", "geometry": geometry,
            "claims": [{"id": "claim001", "text": "Synthetic fixture dimensions; not a real measurement",
                        "sourceIds": ["src001"], "assetIds": ["asset001"], "dimensionStatus": method}],
            "bindings": bindings, "missingMeasurements": [], "assumptions": ["Synthetic fixture"],
            "conflicts": [], "omittedFeatures": []}


class FakeResearch:
    def __init__(self, results=None, error=None):
        self.results = results or [discovery_fixture()]
        self.error = error
        self.calls = []

    def research(self, task, output_schema):
        self.calls.append((task, deepcopy(output_schema)))
        if self.error:
            raise self.error
        return deepcopy(self.results[min(len(self.calls) - 1, len(self.results) - 1)])


class FakeGeometry:
    def __init__(self, results=None, error=None):
        self.results = results or [proposal_fixture()]
        self.error = error
        self.calls = []

    def extract(self, prompt, assets, output_schema):
        self.calls.append((prompt, deepcopy(assets), deepcopy(output_schema)))
        if self.error:
            raise self.error
        return deepcopy(self.results[min(len(self.calls) - 1, len(self.results) - 1)])


class FakeFetcher:
    def __init__(self, overrides=None):
        self.calls = []
        self.responses = {
            PAGE_URL: FetchResult(PAGE_URL, "text/html", HTML),
            PLAN_URL: FetchResult(PLAN_URL, "image/png", PNG),
            PHOTO_URL: FetchResult(PHOTO_URL, "image/png", PNG + b"synthetic distinct photo"),
        }
        self.responses.update(overrides or {})

    def fetch(self, url, *, max_bytes, **kwargs):
        self.calls.append((url, max_bytes))
        response = self.responses.get(url)
        if response is None:
            raise FetchError("Synthetic evidence unavailable")
        if isinstance(response, Exception):
            raise response
        if len(response.body) > max_bytes:
            raise FetchError("Synthetic response exceeded byte budget")
        return response


class AddressPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "job"

    def execute(self, *, discovery=None, research=None, geometry=None, fetcher=None, **kwargs):
        self.research = research or FakeResearch([discovery or discovery_fixture()])
        self.geometry = geometry or FakeGeometry()
        return run(address_request(), self.output, research_provider=self.research,
                   geometry_provider=self.geometry, fetcher=fetcher or FakeFetcher(), **kwargs)

    def dossier(self):
        return read_json(self.output / "dossier.json")

    def test_complete_mocked_address_to_downloaded_bytes_to_validated_request(self):
        dossier = self.execute()
        self.assertEqual(dossier["status"], "draft_ready")
        self.assertIs(dossier["reviewRequired"], True)
        self.assertEqual(len(self.research.calls), 1)
        self.assertEqual(self.research.calls[0][1], DISCOVERY_SCHEMA)
        self.assertEqual(self.geometry.calls[0][2], PROPOSAL_SCHEMA)
        self.assertEqual(self.geometry.calls[0][1][0], {"id": "asset001", "mediaType": "image/png", "body": PNG})
        self.assertEqual({a["id"] for a in self.geometry.calls[0][1]}, {"asset001", "asset002"})
        self.assertEqual((self.output / "assets/asset001.png").read_bytes(), PNG)
        self.assertEqual((self.output / "pages/src001.html").read_bytes(), HTML)
        self.assertEqual(dossier, self.dossier())
        result = validate_request(read_json(self.output / dossier["reconstructionRequestPath"]))
        self.assertEqual((result["projectId"], result["jobId"], result["inputRevision"]),
                         ("synthetic-property", "address-test", 7))
        self.assertEqual(result["evidence"][0]["privateAssetId"], "synthetic-property/address-test/asset001")
        self.assertIsNone(result["evidence"][0]["confirmedByUserAt"])
        self.assertFalse((self.output / "draft").exists())

    def test_provider_ids_are_rewritten_consistently(self):
        dossier = self.execute(collect_only=True)
        self.assertEqual(dossier["sources"][0]["id"], "src001")
        self.assertEqual(dossier["candidates"][0]["id"], "candidate001")
        self.assertEqual(dossier["candidates"][0]["sourceIds"], ["src001"])
        self.assertEqual(dossier["assets"][0]["sourceId"], "src001")
        self.assertEqual(dossier["assets"][0]["candidateId"], "candidate001")
        self.assertEqual(dossier["status"], "evidence_collected")
        self.assertFalse(self.geometry.calls)

    def test_missing_plan_stops_before_geometry_model(self):
        dossier = self.execute(discovery=discovery_fixture(include_plan=False))
        self.assertEqual(dossier["status"], "needs_evidence")
        self.assertEqual(len(self.research.calls), 2)
        self.assertFalse(self.geometry.calls)
        self.assertFalse((self.output / "reconstruction.request.json").exists())
        self.assertTrue(dossier["missingEvidence"])

    def test_failed_plan_download_stops_before_geometry_model(self):
        dossier = self.execute(fetcher=FakeFetcher({PLAN_URL: FetchError("Synthetic plan unavailable")}))
        self.assertEqual(dossier["status"], "needs_evidence")
        self.assertEqual(dossier["assets"][0]["status"], "failed")
        self.assertFalse(self.geometry.calls)

    def test_address_layout_ambiguity_and_inference_require_review(self):
        cases = []
        cases.append((discovery_fixture(scope="apartment_type"), proposal_fixture()))
        cases.append((discovery_fixture(), proposal_fixture(method="inferred")))
        conflict = discovery_fixture()
        conflict["conflicts"] = ["Two public sources disagree on orientation"]
        cases.append((conflict, proposal_fixture()))
        missing = proposal_fixture()
        missing["missingMeasurements"] = ["Verify ceiling height"]
        cases.append((discovery_fixture(), missing))
        for index, (discovery, proposal) in enumerate(cases):
            with self.subTest(index=index):
                dossier = run(address_request(), self.root / f"review{index}", research_provider=FakeResearch([discovery]),
                              geometry_provider=FakeGeometry([proposal]), fetcher=FakeFetcher())
                self.assertEqual(dossier["status"], "needs_review")
                self.assertIs(dossier["reviewRequired"], True)

    def test_mismatched_unit_downgrades_exact_unit_source_and_candidate(self):
        discovery = discovery_fixture()
        discovery["sources"][0]["unitText"] = "999"
        dossier = self.execute(discovery=discovery)
        self.assertEqual(dossier["sources"][0]["scope"], "unknown")
        self.assertEqual(dossier["candidates"][0]["scope"], "unknown")
        self.assertEqual(dossier["status"], "needs_review")

    def test_invalid_geometry_gets_one_repair_using_same_downloaded_assets(self):
        invalid = proposal_fixture()
        invalid["geometry"]["rooms"][0]["height"] = -1
        geometry = FakeGeometry([invalid, proposal_fixture()])
        dossier = self.execute(geometry=geometry)
        self.assertEqual(dossier["status"], "draft_ready")
        self.assertEqual(len(geometry.calls), 2)
        self.assertNotEqual(geometry.calls[0][0], geometry.calls[1][0])
        self.assertEqual(geometry.calls[0][1], geometry.calls[1][1])
        self.assertTrue((self.output / "proposal-1.json").is_file())
        self.assertTrue((self.output / "proposal-2.json").is_file())

    def test_invalid_repair_fails_after_two_attempts_and_preserves_evidence(self):
        proposal = proposal_fixture()
        proposal["bindings"].pop()
        geometry = FakeGeometry([proposal])
        with self.assertRaises(ResearchError):
            self.execute(geometry=geometry)
        self.assertEqual(len(geometry.calls), 2)
        self.assertEqual(self.dossier()["status"], "failed")
        self.assertTrue((self.output / "assets/asset001.png").is_file())
        self.assertFalse((self.output / "reconstruction.request.json").exists())

    def test_model_requests_more_evidence_without_geometry(self):
        proposal = proposal_fixture()
        proposal.update(geometry=None, selectedCandidateId=None, claims=[], bindings=[],
                        missingMeasurements=["No reliable metric scale"])
        dossier = self.execute(geometry=FakeGeometry([proposal]))
        self.assertEqual(dossier["status"], "needs_evidence")
        self.assertFalse((self.output / "reconstruction.request.json").exists())

    def test_fresh_output_required_and_existing_files_preserved(self):
        self.output.mkdir()
        sentinel = self.output / "keep.txt"
        sentinel.write_text("unrelated prior job")
        with self.assertRaises(FileExistsError):
            self.execute()
        self.assertEqual(sentinel.read_text(), "unrelated prior job")
        self.assertEqual(list(self.output.iterdir()), [sentinel])

    def test_geometry_provider_failure_preserves_dossier_without_credentials(self):
        with self.assertRaises(ProviderError):
            self.execute(geometry=FakeGeometry(error=ProviderError("api-key-do-not-persist")))
        dossier = self.dossier()
        self.assertEqual(dossier["status"], "failed")
        self.assertEqual(dossier["error"]["type"], "ProviderError")
        self.assertTrue((self.output / "assets/asset001.png").is_file())
        self.assertNotIn("api-key-do-not-persist", json.dumps(dossier))

    def test_research_provider_failure_preserves_initial_dossier_without_credentials(self):
        with self.assertRaises(ProviderError):
            self.execute(research=FakeResearch(error=ProviderError("secret-research-token")))
        dossier = self.dossier()
        self.assertEqual(dossier["status"], "failed")
        self.assertEqual(dossier["sources"], [])
        self.assertNotIn("secret-research-token", json.dumps(dossier))

    def test_explicit_discovery_can_run_without_research_provider(self):
        dossier = run(address_request(), self.output, discovery=discovery_fixture(),
                      geometry_provider=FakeGeometry(), fetcher=FakeFetcher())
        self.assertEqual(dossier["status"], "draft_ready")

    def test_additive_second_round_recovers_floor_plan_and_reuses_source_identity(self):
        research = FakeResearch([discovery_fixture(include_plan=False), discovery_fixture()])
        # A photograph downloaded in round one gets asset001; the later plan is asset002.
        proposal = proposal_fixture()
        proposal["claims"][0]["assetIds"] = ["asset002"]
        dossier = self.execute(research=research, geometry=FakeGeometry([proposal]))
        self.assertEqual(dossier["status"], "draft_ready")
        self.assertEqual(len(dossier["sources"]), 1)
        self.assertEqual(len(dossier["candidates"]), 1)
        self.assertEqual(len(dossier["rounds"]), 2)
        self.assertEqual(dossier["assets"][1]["kind"], "floor_plan")
        self.assertIn("src001", research.calls[1][0])

    def test_second_round_exact_plan_precedes_eight_earlier_photos_or_generic_plans(self):
        exact_page = "https://property.example/exact-unit-201"
        exact_plan = "https://property.example/exact-unit-201/floorplan.png"
        for kind in ["photo", "floor_plan"]:
            with self.subTest(earlier_kind=kind):
                first = discovery_fixture(scope="apartment_type", include_plan=False)
                first["assets"] = [{**first["assets"][0], "url": f"https://property.example/generic-{i}.png", "kind": kind}
                                   for i in range(8)]
                second = discovery_fixture()
                second["sources"][0]["url"] = exact_page
                second["assets"] = [{**second["assets"][0], "url": exact_plan}]
                responses = {a["url"]: FetchResult(a["url"], "image/png", PNG + bytes([i]))
                             for i, a in enumerate(first["assets"])}
                responses[exact_page] = FetchResult(exact_page, "text/html", HTML)
                responses[exact_plan] = FetchResult(exact_plan, "image/png", PNG + b"exact-plan")
                proposal = proposal_fixture()
                proposal["selectedCandidateId"] = "candidate002"
                proposal["claims"][0].update(sourceIds=["src002"], assetIds=["asset009"])
                geometry = FakeGeometry([proposal])
                dossier = run(address_request(), self.root / f"priority-{kind}",
                              research_provider=FakeResearch([first, second]), geometry_provider=geometry,
                              fetcher=FakeFetcher(responses))
                self.assertEqual(dossier["status"], "draft_ready")
                sent = geometry.calls[0][1]
                self.assertEqual(sent[0]["id"], "asset009")
                self.assertEqual(sent[0]["body"], PNG + b"exact-plan")
                self.assertEqual(len(sent), 8)
                self.assertTrue(next(a for a in dossier["assets"] if a["id"] == "asset009")["sentToVision"])

    def test_generic_pdf_document_does_not_trigger_geometry_extraction(self):
        discovery = discovery_fixture(include_plan=False)
        discovery["assets"][0].update(kind="document", url="https://property.example/brochure.pdf")
        fetcher = FakeFetcher({"https://property.example/brochure.pdf": FetchResult(
            "https://property.example/brochure.pdf", "application/pdf", b"%PDF-1.7\nSynthetic brochure")})
        dossier = self.execute(discovery=discovery, fetcher=fetcher)
        self.assertEqual(dossier["status"], "needs_evidence")
        self.assertFalse(self.geometry.calls)
        self.assertEqual(dossier["assets"][0]["status"], "downloaded")

    def test_later_explicit_attribution_upgrades_unassigned_extracted_asset_with_audit(self):
        first = discovery_fixture(include_plan=False)
        first["assets"] = []
        first["candidates"] = []
        fetcher = FakeFetcher({PAGE_URL: FetchResult(PAGE_URL, "text/html",
            f'<html><img src="{PHOTO_URL}" alt="Synthetic photo"></html>'.encode())})
        dossier = self.execute(discovery=first, fetcher=fetcher, collect_only=True, research_rounds=1)
        self.assertIsNone(dossier["assets"][0]["candidateId"])
        self.assertEqual(dossier["assets"][0]["kind"], "photo")
        second = discovery_fixture()
        second["assets"] = [{**second["assets"][0], "url": PHOTO_URL}]
        _acquire(second, dossier, self.output, fetcher)
        asset = dossier["assets"][0]
        self.assertEqual(asset["candidateId"], "candidate001")
        self.assertEqual(asset["kind"], "floor_plan")
        self.assertEqual(asset["attributionBeforeResearch"]["kind"], "photo")
        self.assertIsNone(asset["attributionBeforeResearch"]["candidateId"])
        self.assertEqual(sum(url == PHOTO_URL for url, _ in fetcher.calls), 1)

    def test_conflicting_later_candidate_attribution_is_recorded_and_rejected(self):
        dossier = self.execute(collect_only=True)
        second = discovery_fixture()
        second["candidates"][0]["label"] = "Synthetic incompatible mirrored layout"
        _acquire(second, dossier, self.output, FakeFetcher())
        asset = dossier["assets"][0]
        self.assertEqual(asset["candidateId"], "candidate001")
        self.assertEqual(asset["conflictingCandidateIds"], ["candidate001", "candidate002"])
        asset["sentToVision"] = True
        with self.assertRaises(ResearchError):
            ground_proposal(proposal_fixture(), dossier)

    def test_reserved_byte_cap_leaves_unattempted_urls_available_for_round_two(self):
        self.output.mkdir()
        (self.output / "pages").mkdir()
        (self.output / "assets").mkdir()
        dossier = {"request": validate_input(address_request()), "sources": [], "candidates": [],
                   "assets": [], "discoveryGaps": [], "discoveryConflicts": []}
        first = discovery_fixture(include_plan=False)
        first["assets"] = [{**first["assets"][0], "url": f"https://property.example/byte-test-{i}.png"}
                           for i in range(2)]
        fetcher = FakeFetcher({a["url"]: FetchResult(a["url"], "image/png", PNG)
                               for a in first["assets"]})
        _acquire(first, dossier, self.output, fetcher, byte_limit=len(PNG))
        self.assertEqual(len(dossier["assets"]), 1)
        self.assertEqual(dossier["assets"][0]["status"], "downloaded")
        later = deepcopy(first)
        later["assets"] = [{**first["assets"][1], "kind": "floor_plan"}]
        _acquire(later, dossier, self.output, fetcher)
        self.assertEqual(len(dossier["assets"]), 2)
        self.assertEqual(dossier["assets"][1]["url"], first["assets"][1]["url"])
        self.assertEqual(dossier["assets"][1]["status"], "downloaded")
        self.assertEqual(dossier["assets"][1]["kind"], "floor_plan")

    @unittest.skipUnless(os.environ.get("BLENDER_BIN"), "Set BLENDER_BIN for actual address-to-Blender integration")
    def test_mocked_address_research_produces_actual_editable_blender_and_glb_draft(self):
        dossier = self.execute(render_draft=True, blender=os.environ["BLENDER_BIN"])
        self.assertEqual(dossier["status"], "draft_ready")
        self.assertIs(dossier["reviewRequired"], True)
        manifest = read_json(self.output / dossier["draftManifestPath"])
        self.assertEqual((manifest["projectId"], manifest["jobId"], manifest["inputRevision"]),
                         ("synthetic-property", "address-test", 7))
        self.assertTrue(any("unconfirmed" in warning.lower() for warning in manifest["warnings"]))
        self.assertEqual(manifest["inputSha256"], dossier["draftInputSha256"])
        files = manifest["files"]
        self.assertTrue(any(info["fileName"].endswith(".blend") for info in files.values()))
        self.assertTrue(any(info["fileName"].endswith(".glb") for info in files.values()))
        for info in files.values():
            body = (self.output / "draft" / info["fileName"]).read_bytes()
            self.assertEqual(len(body), info["byteLength"])
            self.assertEqual(hashlib.sha256(body).hexdigest(), info["sha256"])
            if info["fileName"].endswith(".glb"):
                self.assertEqual(body[:4], b"glTF")
        source = read_json(self.output / "draft/scene.json")
        self.assertEqual(source["projectId"], "synthetic-property")
        self.assertEqual(source["inputRevision"], 7)
        self.assertTrue(all(e["confirmedByUserAt"] is None for e in source["evidence"]))


class GroundProposalTests(unittest.TestCase):
    def setUp(self):
        self.dossier = {
            "request": validate_input(address_request()), "observedAt": "2026-10-17T19:00:00Z",
            "sources": [{"id": "src001", "url": PAGE_URL, "status": "fetched"}],
            "candidates": [{"id": "candidate001", "sourceIds": ["src001"], "scope": "exact_unit"}],
            "assets": [{"id": "asset001", "url": PLAN_URL, "sourceId": "src001", "candidateId": "candidate001",
                        "kind": "floor_plan", "sentToVision": True}],
        }

    def test_every_numeric_field_has_evidence_binding(self):
        proposal = proposal_fixture()
        result = ground_proposal(proposal, self.dossier)
        self.assertEqual(len(proposal["bindings"]), 26)
        self.assertEqual(result["geometry"]["units"], "m")
        self.assertEqual(result["geometry"]["coordinateSystem"], "right-handed-y-up")

    def test_fabricated_or_unseen_asset_refs_rejected(self):
        for asset_ids in [["fabricated"], ["asset002"]]:
            with self.subTest(asset_ids=asset_ids):
                dossier = deepcopy(self.dossier)
                dossier["assets"].append({**dossier["assets"][0], "id": "asset002", "sentToVision": False})
                proposal = proposal_fixture()
                proposal["claims"][0]["assetIds"] = asset_ids
                with self.assertRaises(ResearchError):
                    ground_proposal(proposal, dossier)

    def test_foreign_candidate_assets_are_rejected(self):
        dossier = deepcopy(self.dossier)
        dossier["assets"][0]["candidateId"] = "candidate002"
        with self.assertRaises(ResearchError):
            ground_proposal(proposal_fixture(), dossier)

    def test_foreign_candidate_source_cannot_supply_numeric_claims(self):
        dossier = deepcopy(self.dossier)
        dossier["sources"].append({"id": "src002", "url": "https://other.example/unrelated", "status": "fetched"})
        proposal = proposal_fixture()
        proposal["claims"][0]["sourceIds"].append("src002")
        with self.assertRaises(ResearchError):
            ground_proposal(proposal, dossier)

    def test_unassigned_asset_from_foreign_source_is_rejected(self):
        dossier = deepcopy(self.dossier)
        dossier["assets"].append({**dossier["assets"][0], "id": "asset002", "sourceId": "src002", "candidateId": None})
        proposal = proposal_fixture()
        proposal["claims"][0]["assetIds"].append("asset002")
        with self.assertRaises(ResearchError):
            ground_proposal(proposal, dossier)

    def test_unknown_candidate_and_unfetched_text_claims_are_rejected(self):
        proposal = proposal_fixture()
        proposal["selectedCandidateId"] = "missing-candidate"
        with self.assertRaises(ResearchError):
            ground_proposal(proposal, self.dossier)
        dossier = deepcopy(self.dossier)
        dossier["sources"][0]["status"] = "failed"
        with self.assertRaises(ResearchError):
            ground_proposal(proposal_fixture(), dossier)

    def test_missing_duplicate_and_unsupported_field_bindings_rejected(self):
        proposals = []
        missing = proposal_fixture()
        missing["bindings"].pop()
        proposals.append(missing)
        duplicate = proposal_fixture()
        duplicate["bindings"].append(deepcopy(duplicate["bindings"][0]))
        proposals.append(duplicate)
        unsupported = proposal_fixture()
        unsupported["bindings"][0]["elementId"] = "missing-entity"
        proposals.append(unsupported)
        for proposal in proposals:
            with self.subTest(bindings=len(proposal["bindings"])):
                with self.assertRaises(ResearchError):
                    ground_proposal(proposal, self.dossier)

    def test_source_binding_cannot_upgrade_inferred_claim(self):
        proposal = proposal_fixture()
        proposal["claims"][0]["dimensionStatus"] = "inferred"
        with self.assertRaises(ResearchError):
            ground_proposal(proposal, self.dossier)

    def test_photograph_cannot_substitute_for_selected_floor_plan(self):
        for kind in ["photo", "document", "unknown"]:
            with self.subTest(kind=kind):
                dossier = deepcopy(self.dossier)
                dossier["assets"][0]["kind"] = kind
                with self.assertRaises(ResearchError):
                    ground_proposal(proposal_fixture(), dossier)

    def test_binding_must_reference_its_own_entity_evidence(self):
        proposal = proposal_fixture()
        proposal["bindings"][0]["evidenceIds"] = ["claim-not-on-entity"]
        with self.assertRaises(ResearchError):
            ground_proposal(proposal, self.dossier)

    def test_null_geometry_cannot_smuggle_claims_or_bindings(self):
        for field in ["claims", "bindings"]:
            with self.subTest(field=field):
                proposal = proposal_fixture()
                kept = proposal[field]
                proposal.update(geometry=None, selectedCandidateId=None, claims=[], bindings=[])
                proposal[field] = kept
                with self.assertRaises(ResearchError):
                    ground_proposal(proposal, self.dossier)

    def test_direct_media_source_citation_requires_a_matching_inspected_asset(self):
        dossier = deepcopy(self.dossier)
        dossier["sources"][0]["status"] = "media_source"
        result = ground_proposal(proposal_fixture(), dossier)
        self.assertEqual(result["projectId"], "synthetic-property")
        proposal = proposal_fixture()
        proposal["claims"][0]["assetIds"] = []
        with self.assertRaises(ResearchError):
            ground_proposal(proposal, dossier)


class AddressSchemaTests(unittest.TestCase):
    def test_input_defaults_are_explicit(self):
        raw = address_request()
        for key in ("unit", "listingUrls", "targetRoom"):
            raw.pop(key)
        result = validate_input(raw)
        self.assertIsNone(result["unit"])
        self.assertEqual(result["listingUrls"], [])
        self.assertEqual(result["targetRoom"], "entire unit")

    def test_unsafe_input_fields_and_revisions_are_rejected(self):
        for change in [{"apiKey": "not-a-request-field"}, {"inputRevision": True}, {"inputRevision": -1},
                       {"inputRevision": 2**53}, {"jobId": "../escape"}, {"address": " "}]:
            with self.subTest(fields=list(change)):
                with self.assertRaises(ResearchError):
                    validate_input(address_request(**change))

    def test_schema_checks_unknown_fields_nonfinite_and_boolean_numbers(self):
        variants = []
        extra = proposal_fixture()
        extra["inventedField"] = "no"
        variants.append(extra)
        for number in [float("nan"), float("inf"), True]:
            proposal = proposal_fixture()
            proposal["geometry"]["rooms"][0]["height"] = number
            variants.append(proposal)
        for proposal in variants:
            with self.subTest(extra="inventedField" in proposal):
                with self.assertRaises(ResearchError):
                    validate(proposal, PROPOSAL_SCHEMA)

    def test_duplicate_and_dangling_discovery_references_are_rejected(self):
        variants = []
        duplicate = discovery_fixture()
        duplicate["sources"].append(deepcopy(duplicate["sources"][0]))
        variants.append(duplicate)
        missing = discovery_fixture()
        missing["candidates"][0]["sourceIds"] = ["missing-source"]
        variants.append(missing)
        bad_asset = discovery_fixture()
        bad_asset["assets"][0]["candidateId"] = "missing-candidate"
        variants.append(bad_asset)
        for discovery in variants:
            with self.subTest(sources=len(discovery["sources"])):
                with self.assertRaises(ResearchError):
                    validate_discovery(discovery)

    def test_json_duplicate_keys_and_nonfinite_literals_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.json"
            for body in ['{"a": 1, "a": 2}', '{"a":NaN}', '{"a":Infinity}']:
                with self.subTest(body=body):
                    source.write_text(body)
                    with self.assertRaises(ResearchError):
                        read_json(source)


if __name__ == "__main__":
    unittest.main()
