"""Keyless, data-only geometry proposal handoff with evidence byte binding.

A packet records its producer's declaration, not a verified identity or proof
that an image was inspected correctly. Existing grounding and geometry review
remain mandatory after this adapter returns a proposal.
"""

from copy import deepcopy
import hashlib
import re

from .pipeline import read_json
from .schema import ID, PROPOSAL_SCHEMA, ResearchError, validate


class FileGeometryProvider:
    """Load a local JSON proposal and require the exact cited evidence bytes."""

    mode = "file_handoff"

    def __init__(self, path):
        try:
            packet = read_json(path)
        except ResearchError:
            raise
        except (OSError, ValueError, UnicodeError):
            raise ResearchError("Unable to read geometry handoff JSON") from None
        required = {"schemaVersion", "producer", "assetSha256", "proposal"}
        if not isinstance(packet, dict) or set(packet) != required:
            raise ResearchError("Geometry handoff contains missing or unsupported fields")
        if packet["schemaVersion"] != "geometry-handoff/1.0":
            raise ResearchError("Unsupported geometry handoff schema version")
        producer = packet["producer"]
        if not isinstance(producer, str) or not producer.strip() or len(producer) > 100:
            raise ResearchError("Geometry handoff requires a nonempty producer declaration of at most 100 characters")
        attested = packet["assetSha256"]
        if not isinstance(attested, dict):
            raise ResearchError("Geometry handoff assetSha256 must be an object")
        for asset_id, digest in attested.items():
            validate(asset_id, ID, "handoff.assetSha256 ID")
            if not isinstance(digest, str) or not re.fullmatch(r"[A-Fa-f0-9]{64}", digest):
                raise ResearchError("Geometry handoff requires SHA-256 hexadecimal digests")
        validate(packet["proposal"], PROPOSAL_SCHEMA, "handoff.proposal")
        cited = {asset_id for claim in packet["proposal"]["claims"] for asset_id in claim["assetIds"]}
        if cited - attested.keys():
            raise ResearchError("Geometry handoff claim cites an unattested evidence asset")
        self.producer = producer
        self._attested = {asset_id: digest.lower() for asset_id, digest in attested.items()}
        self._proposal = deepcopy(packet["proposal"])

    def extract(self, prompt, assets, output_schema):
        """Return proposal data only after every attestation matches actual input.

        ``prompt`` is accepted for provider interface compatibility. It is never
        executed or sent to a service; the packet cannot respond to repair text.
        """
        if not isinstance(assets, list):
            raise ResearchError("Geometry handoff requires an evidence asset list")
        actual = {}
        for asset in assets:
            if not isinstance(asset, dict):
                raise ResearchError("Geometry handoff evidence asset must be an object")
            asset_id = asset.get("id")
            validate(asset_id, ID, "handoff evidence ID")
            if asset_id in actual:
                raise ResearchError("Geometry handoff input contains duplicate evidence IDs")
            body = asset.get("body")
            if not isinstance(body, bytes) or not body:
                raise ResearchError("Geometry handoff evidence requires nonempty downloaded bytes")
            actual[asset_id] = body
        if self._attested.keys() - actual.keys():
            raise ResearchError("Geometry handoff attests evidence that was not supplied for inspection")
        for asset_id, digest in self._attested.items():
            if hashlib.sha256(actual[asset_id]).hexdigest() != digest:
                raise ResearchError("Geometry handoff evidence SHA-256 does not match downloaded bytes")
        # The pipeline's current requested schema is checked independently too.
        validate(self._proposal, output_schema, "handoff.proposal")
        return deepcopy(self._proposal)
