"""Data-only geometry handoffs; no provider credentials or external calls."""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reconstruction.address.handoff import FileGeometryProvider
from reconstruction.address import __main__ as address_cli
from reconstruction.address.schema import PROPOSAL_SCHEMA, ResearchError
from reconstruction.tests.test_address_pipeline import FakeFetcher, PNG, discovery_fixture, proposal_fixture


BODY = b"synthetic image bytes for packet hash verification"


def packet_fixture():
    return {"schemaVersion": "geometry-handoff/1.0", "producer": "Synthetic test producer declaration",
            "assetSha256": {"asset001": hashlib.sha256(BODY).hexdigest()}, "proposal": proposal_fixture()}


class FileGeometryProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "handoff.json"

    def provider(self, packet=None):
        self.path.write_text(json.dumps(packet if packet is not None else packet_fixture()))
        return FileGeometryProvider(self.path)

    def extract(self, provider, body=BODY, assets=None):
        return provider.extract("Data-only geometry handoff", assets if assets is not None else [
            {"id": "asset001", "mediaType": "image/png", "body": body}], PROPOSAL_SCHEMA)

    def test_valid_packet_binds_actual_bytes_and_exposes_declared_metadata(self):
        provider = self.provider()
        self.assertEqual(provider.mode, "file_handoff")
        self.assertEqual(provider.producer, "Synthetic test producer declaration")
        self.assertEqual(self.extract(provider), packet_fixture()["proposal"])

    def test_uppercase_hex_digest_supported(self):
        packet = packet_fixture()
        packet["assetSha256"]["asset001"] = packet["assetSha256"]["asset001"].upper()
        self.assertEqual(self.extract(self.provider(packet)), packet["proposal"])

    def test_changed_download_bytes_rejected(self):
        with self.assertRaises(ResearchError):
            self.extract(self.provider(), body=b"different image bytes")

    def test_missing_or_unseen_attested_asset_rejected(self):
        provider = self.provider()
        for assets in [[], [{"id": "asset002", "body": BODY}]]:
            with self.subTest(assets=assets), self.assertRaises(ResearchError):
                self.extract(provider, assets=assets)

    def test_every_attested_asset_must_be_supplied_even_if_not_cited(self):
        packet = packet_fixture()
        packet["assetSha256"]["asset002"] = hashlib.sha256(b"other").hexdigest()
        with self.assertRaises(ResearchError):
            self.extract(self.provider(packet))

    def test_every_claim_asset_must_have_an_attestation(self):
        packet = packet_fixture()
        packet["proposal"]["claims"][0]["assetIds"].append("fabricated-asset")
        with self.assertRaises(ResearchError):
            self.provider(packet)

    def test_bad_top_level_fields_and_versions_rejected(self):
        packets = [[], None]
        for field in packet_fixture():
            packet = packet_fixture()
            packet.pop(field)
            packets.append(packet)
        extra = packet_fixture()
        extra["execute"] = "arbitrary command"
        packets.append(extra)
        version = packet_fixture()
        version["schemaVersion"] = "geometry-handoff/999"
        packets.append(version)
        for packet in packets:
            with self.subTest(packet=packet):
                self.path.write_text(json.dumps(packet))
                with self.assertRaises(ResearchError):
                    FileGeometryProvider(self.path)

    def test_invalid_producer_and_asset_digest_fields_rejected(self):
        for producer in [None, "", " ", "x" * 101, 9]:
            packet = packet_fixture()
            packet["producer"] = producer
            with self.subTest(producer=producer), self.assertRaises(ResearchError):
                self.provider(packet)
        for attestation in [[], {"../escape": "a" * 64}, {"asset001": "a" * 63},
                            {"asset001": "z" * 64}, {"asset001": 42}]:
            packet = packet_fixture()
            packet["assetSha256"] = attestation
            with self.subTest(attestation=attestation), self.assertRaises(ResearchError):
                self.provider(packet)

    def test_invalid_proposal_schema_rejected(self):
        for change in [{"unexpected": True}, {"summary": ""}, {"claims": "not-an-array"}]:
            packet = packet_fixture()
            packet["proposal"].update(change)
            with self.subTest(change=change), self.assertRaises(ResearchError):
                self.provider(packet)

    def test_malformed_duplicate_or_oversized_json_rejected(self):
        for content in ["not-json", '{"a":1,"a":2}', '{"a":NaN}', " " * (2 * 1024 * 1024 + 1)]:
            with self.subTest(length=len(content)):
                self.path.write_text(content)
                with self.assertRaises(ResearchError):
                    FileGeometryProvider(self.path)

    def test_missing_file_rejected_without_persisting_path(self):
        with self.assertRaises(ResearchError) as caught:
            FileGeometryProvider(self.path)
        self.assertNotIn(str(self.path), str(caught.exception))

    def test_input_asset_ids_bodies_and_duplicates_validated(self):
        variants = [None, [None], [{"id": "../escape", "body": BODY}],
                    [{"id": "asset001", "body": "not-bytes"}], [{"id": "asset001", "body": b""}],
                    [{"id": "asset001", "body": BODY}] * 2]
        provider = self.provider()
        for assets in variants:
            with self.subTest(assets=assets), self.assertRaises(ResearchError):
                provider.extract("prompt", assets, PROPOSAL_SCHEMA)

    def test_returned_proposal_is_a_copy_and_packet_loaded_once(self):
        provider = self.provider()
        first = self.extract(provider)
        first["geometry"]["rooms"][0]["height"] = 999
        first["claims"].clear()
        self.path.write_text("This file changed after loading")
        second = self.extract(provider)
        self.assertEqual(second, packet_fixture()["proposal"])

    def test_null_geometry_without_asset_attestations_can_be_loaded(self):
        packet = packet_fixture()
        packet["proposal"].update(geometry=None, selectedCandidateId=None, claims=[], bindings=[])
        packet["assetSha256"] = {}
        result = self.extract(self.provider(packet), assets=[])
        self.assertIsNone(result["geometry"])

    def test_strings_are_data_and_no_api_or_commands_are_called(self):
        packet = packet_fixture()
        packet["proposal"]["summary"] = "$(echo never-execute); arbitrary content remains JSON data"
        with patch("urllib.request.urlopen", side_effect=AssertionError("No HTTP")), \
             patch("subprocess.run", side_effect=AssertionError("No commands")):
            result = self.extract(self.provider(packet))
        self.assertEqual(result["summary"], packet["proposal"]["summary"])


class FileHandoffCLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.packet = self.root / "handoff.json"
        self.discovery = self.root / "discovery.json"
        self.packet.write_text(json.dumps(packet_fixture()))
        self.discovery.write_text(json.dumps(discovery_fixture()))
        self.args = ["--address", "100 Synthetic Example Street", "--unit", "201",
                     "--project-id", "synthetic-property", "--job-id", "handoff-cli",
                     "--output", str(self.root / "job"), "--discovery-file", str(self.discovery),
                     "--proposal-file", str(self.packet)]

    def test_keyless_handoff_constructs_file_provider_without_paid_provider_constructors(self):
        dossier = {"schemaVersion": "address-research/1.0", "status": "needs_review", "sources": [], "assets": [],
                   "execution": {"research": "discovery_file", "geometry": "file_handoff",
                                 "declaredProducer": packet_fixture()["producer"]}}
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(address_cli, "BrowserUseResearchProvider", side_effect=AssertionError("No Browser Use")) as browser, \
             patch.object(address_cli, "OpenAIGeometryProvider", side_effect=AssertionError("No OpenAI")) as openai, \
             patch.object(address_cli, "run", return_value=dossier) as run, \
             redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(address_cli.main(self.args), 0)
        browser.assert_not_called()
        openai.assert_not_called()
        kwargs = run.call_args.kwargs
        self.assertIsNone(kwargs["research_provider"])
        self.assertEqual(kwargs["discovery"], discovery_fixture())
        provider = kwargs["geometry_provider"]
        self.assertIsInstance(provider, FileGeometryProvider)
        self.assertEqual(provider.extract("data", [{"id": "asset001", "body": BODY}], PROPOSAL_SCHEMA),
                         packet_fixture()["proposal"])

    def test_invalid_handoff_flag_combinations_fail_before_provider_or_run_calls(self):
        without_discovery = self.args[:]
        index = without_discovery.index("--discovery-file")
        del without_discovery[index:index + 2]
        for args in [without_discovery, self.args + ["--collect-only"]]:
            with self.subTest(args=args), patch.dict(os.environ, {}, clear=True), \
                 patch.object(address_cli, "BrowserUseResearchProvider") as browser, \
                 patch.object(address_cli, "OpenAIGeometryProvider") as openai, \
                 patch.object(address_cli, "run") as run, \
                 redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
                self.assertNotEqual(address_cli.main(args), 0)
                self.assertEqual(json.loads(stderr.getvalue())["error"], "ResearchError")
                self.assertEqual(stdout.getvalue(), "")
                browser.assert_not_called()
                openai.assert_not_called()
                run.assert_not_called()

    def test_actual_keyless_cli_receipt_records_file_handoff_execution_metadata(self):
        packet = packet_fixture()
        packet["assetSha256"]["asset001"] = hashlib.sha256(PNG).hexdigest()
        self.packet.write_text(json.dumps(packet))
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(address_cli, "BrowserUseResearchProvider", side_effect=AssertionError("No Browser Use")), \
             patch.object(address_cli, "OpenAIGeometryProvider", side_effect=AssertionError("No OpenAI")), \
             patch("reconstruction.address.pipeline.PublicFetcher", return_value=FakeFetcher()), \
             redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(address_cli.main(self.args), 0, stderr.getvalue())
        receipt = json.loads(stdout.getvalue())
        expected = {"research": "discovery_file", "geometry": "file_handoff", "declaredProducer": packet["producer"]}
        self.assertEqual(receipt["execution"], expected)
        self.assertIs(receipt["reviewRequired"], True)
        self.assertEqual(receipt["projectId"], "synthetic-property")
        dossier = json.loads((self.root / "job/dossier.json").read_text())
        self.assertEqual(dossier["execution"], expected)
        self.assertEqual(dossier["status"], "draft_ready")


if __name__ == "__main__":
    unittest.main()
