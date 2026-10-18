"""Bounded private RGB evidence accompanying an unchanged RoomPlan packet.

No archive extraction or image reprojection occurs here. Camera transforms remain
in the original ARKit frame; the importer separately records its floor translation.
JPEG header screening is not a full image decoder or proof of authentic capture.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
import io
import json
import math
from pathlib import Path
import re
import stat
import struct
import zipfile
import zlib

from reconstruction.capture.bundle import BundleError, _jpeg_dimensions, _read_entry
from .mesh import MAX_MESH_BYTES, validate_mesh

MAX_ZIP_BYTES = 144 * 1024 * 1024
LEGACY_MAX_ZIP_BYTES = 36 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
MAX_SCAN_BYTES = 2 * 1024 * 1024
MAX_PHOTO_BYTES = 2 * 1024 * 1024
MAX_TOTAL_PHOTO_BYTES = 32 * 1024 * 1024
MAX_PHOTOS = 32
_PHOTO_ID = re.compile(r"photo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_PHOTO_PATH = re.compile(r"photos/(photo-[0-9a-f-]{36})\.jpg")
_HASH = re.compile(r"[0-9a-f]{64}")


def _fail(message):
    from .importer import RoomPlanError
    raise RoomPlanError("RoomPlan photo bundle: " + message)


def _json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail("JSON contains duplicate keys")
            result[key] = value
        return result
    def floating(value):
        result = float(value)
        if not math.isfinite(result):
            _fail("JSON contains nonfinite numbers")
        return result
    def constant(_):
        _fail("JSON contains nonfinite numbers")
    return json.loads(body.decode("utf-8"), object_pairs_hook=pairs,
                      parse_float=floating, parse_constant=constant)


def _framing(body):
    if not body.startswith(b"PK\x03\x04"):
        _fail("expected ZIP without a prefixed payload")
    end = body.rfind(b"PK\x05\x06", max(0, len(body) - 65557))
    if end < 0 or end + 22 > len(body):
        _fail("missing complete ZIP end record")
    if end + 22 + int.from_bytes(body[end + 20:end + 22], "little") != len(body):
        _fail("truncated ZIP or trailing payload")
    disk, directory_disk, disk_count, count, size, offset = struct.unpack("<HHHHII", body[end + 4:end + 20])
    if disk or directory_disk or disk_count != count or not 3 <= count <= MAX_PHOTOS + 3:
        _fail("expected one scan, one manifest, optional mesh and 1–32 photos in a single-disk ZIP")
    if offset + size != end:
        _fail("invalid or unsupported ZIP central directory")
    cursor = offset
    actual = 0
    while cursor < end:
        if actual >= MAX_PHOTOS + 3 or cursor + 46 > end or body[cursor:cursor + 4] != b"PK\x01\x02":
            _fail("invalid or oversized ZIP central directory")
        name, extra, comment = struct.unpack("<HHH", body[cursor + 28:cursor + 34])
        cursor += 46 + name + extra + comment
        actual += 1
    if cursor != end or actual != count:
        _fail("inconsistent ZIP directory count")


def _validate_manifest(raw, scan):
    from .importer import _object, _number, _transform
    fields = {"schemaVersion", "projectId", "jobId", "inputRevision", "coordinateSystem", "imageConvention", "scan", "photos"}
    if isinstance(raw, dict) and raw.get("schemaVersion") == "roomplan-photo-bundle/1.1":
        fields.add("mesh")
    manifest = _object(raw, fields, "photo manifest")
    if manifest["schemaVersion"] not in {"roomplan-photo-bundle/1.0", "roomplan-photo-bundle/1.1"}:
        _fail("unsupported manifest version")
    if "mesh" in manifest:
        mesh = _object(manifest["mesh"], {"path", "sha256", "byteLength"}, "photo manifest.mesh")
        if (mesh["path"] != "mesh.json" or not isinstance(mesh["sha256"], str)
                or not _HASH.fullmatch(mesh["sha256"]) or type(mesh["byteLength"]) is not int
                or not 0 < mesh["byteLength"] <= MAX_MESH_BYTES):
            _fail("invalid mesh path, SHA-256 or byte length")
    if manifest["coordinateSystem"] != "arkit-gravity-y-up-metres" or manifest["imageConvention"] != "raw-sensor-top-left":
        _fail("unsupported camera/image convention")
    for key in ("projectId", "jobId", "inputRevision"):
        if type(manifest[key]) is not type(scan[key]) or manifest[key] != scan[key]:
            _fail("manifest identity differs from scan")
    source = _object(manifest["scan"], {"path", "sha256"}, "photo manifest.scan")
    if source["path"] != "roomplan.json" or not isinstance(source["sha256"], str) or not _HASH.fullmatch(source["sha256"]):
        _fail("invalid scan path or SHA-256")
    photos = manifest["photos"]
    if not isinstance(photos, list) or not 1 <= len(photos) <= MAX_PHOTOS:
        _fail("manifest requires 1–32 photos")
    seen = set()
    hashes = set()
    fields = {"id", "path", "sha256", "byteLength", "width", "height", "capturedAt", "arTimestamp", "cameraToWorld", "intrinsics", "trackingState"}
    for photo in photos:
        _object(photo, fields, "photo")
        ident = photo["id"]
        if not isinstance(ident, str) or not _PHOTO_ID.fullmatch(ident) or ident in seen:
            _fail("invalid or duplicate photo identifier")
        seen.add(ident)
        if photo["path"] != f"photos/{ident}.jpg" or not isinstance(photo["sha256"], str) or not _HASH.fullmatch(photo["sha256"]):
            _fail("invalid photo path or SHA-256")
        if photo["sha256"] in hashes:
            _fail("duplicate photo SHA-256")
        hashes.add(photo["sha256"])
        for key, low, high in (("byteLength", 1, MAX_PHOTO_BYTES), ("width", 1, 1600), ("height", 1, 1600)):
            if type(photo[key]) is not int or not low <= photo[key] <= high:
                _fail("invalid photo " + key)
        if photo["trackingState"] != "normal":
            _fail("only normal camera tracking is supported")
        timestamp = photo["capturedAt"]
        if not isinstance(timestamp, str) or len(timestamp) > 64:
            _fail("invalid photo UTC timestamp")
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
                _fail("photo timestamp must be UTC")
        except ValueError:
            _fail("invalid photo UTC timestamp")
        _number(photo["arTimestamp"], 1e-12, 1e12, "photo.arTimestamp")
        _transform(photo["cameraToWorld"], "photo.cameraToWorld", upright=False)
        matrix = photo["intrinsics"]
        if not isinstance(matrix, list) or len(matrix) != 9:
            _fail("expected 9 column-major camera intrinsics")
        values = [_number(value, -100000, 100000, "photo.intrinsics") for value in matrix]
        if (values[0] <= 0 or values[4] <= 0 or any(abs(values[i]) > 1e-6 for i in (1, 2, 3, 5))
                or abs(values[8] - 1) > 1e-6 or not 0 <= values[6] <= photo["width"]
                or not 0 <= values[7] <= photo["height"]):
            _fail("intrinsics must describe the saved image in pixels")
    return manifest


def read_photo_bundle(path):
    """Validate every member and byte before the importer publishes output."""
    from .importer import RoomPlanError, validate_scan
    try:
        with Path(path).open("rb") as stream:
            body = stream.read(MAX_ZIP_BYTES + 1)
        if len(body) > MAX_ZIP_BYTES:
            _fail("ZIP exceeds 144 MiB")
        _framing(body)
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            entries = {}
            total = 0
            for entry in archive.infolist():
                name = entry.filename
                if (name != entry.orig_filename or name in entries or "\\" in name
                        or (name not in {"manifest.json", "roomplan.json", "mesh.json"} and not _PHOTO_PATH.fullmatch(name))):
                    _fail("unexpected, duplicate or unsafe ZIP path")
                mode = entry.external_attr >> 16
                if entry.is_dir() or entry.external_attr & 0x10 or stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                    _fail("links and nonregular members are forbidden")
                if entry.flag_bits & (1 | 32 | 64):
                    _fail("encrypted or patched entries are forbidden")
                if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    _fail("unsupported ZIP compression")
                maximum = (MAX_MANIFEST_BYTES if name == "manifest.json" else MAX_SCAN_BYTES
                           if name == "roomplan.json" else MAX_MESH_BYTES if name == "mesh.json" else MAX_PHOTO_BYTES)
                if not 0 < entry.file_size <= maximum or not 0 <= entry.compress_size <= MAX_ZIP_BYTES:
                    _fail("entry exceeds declared byte limits")
                if entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 200:
                    _fail("unsafe compression ratio")
                if not 0 <= entry.header_offset <= len(body) - 30:
                    _fail("invalid local header offset")
                local = struct.unpack("<IHHHHHIIIHH", body[entry.header_offset:entry.header_offset + 30])
                if local[0] != 0x04034B50 or (local[2], local[3]) != (entry.flag_bits, entry.compress_type):
                    _fail("local and central ZIP headers disagree")
                if not entry.flag_bits & 8 and (local[6], local[7], local[8]) != (entry.CRC, entry.compress_size, entry.file_size):
                    _fail("local and central ZIP sizes or CRC disagree")
                if _PHOTO_PATH.fullmatch(name):
                    total += entry.file_size
                entries[name] = entry
            if total > MAX_TOTAL_PHOTO_BYTES:
                _fail("photos exceed 32 MiB")
            if not {"manifest.json", "roomplan.json"} <= set(entries):
                _fail("missing manifest.json or roomplan.json")
            manifest_bytes = _read_entry(archive, entries["manifest.json"], MAX_MANIFEST_BYTES)
            scan_bytes = _read_entry(archive, entries["roomplan.json"], MAX_SCAN_BYTES)
            raw_scan = _json(scan_bytes)
            scan = validate_scan(raw_scan)
            manifest = _validate_manifest(_json(manifest_bytes), scan)
            if manifest["schemaVersion"] == "roomplan-photo-bundle/1.0" and len(body) > LEGACY_MAX_ZIP_BYTES:
                _fail("legacy ZIP exceeds 36 MiB")
            if hashlib.sha256(scan_bytes).hexdigest() != manifest["scan"]["sha256"]:
                _fail("scan SHA-256 mismatch")
            declared = {"manifest.json", "roomplan.json"} | {photo["path"] for photo in manifest["photos"]}
            if "mesh" in manifest:
                declared.add("mesh.json")
            if set(entries) != declared:
                _fail("archive differs from manifest-declared members")
            files = {}
            mesh = None
            if "mesh" in manifest:
                mesh_bytes = _read_entry(archive, entries["mesh.json"], MAX_MESH_BYTES)
                if (len(mesh_bytes) != manifest["mesh"]["byteLength"]
                        or hashlib.sha256(mesh_bytes).hexdigest() != manifest["mesh"]["sha256"]):
                    _fail("mesh length or SHA-256 mismatch")
                mesh = validate_mesh(_json(mesh_bytes), scan)
                files["mesh.json"] = mesh_bytes
            for photo in manifest["photos"]:
                data = _read_entry(archive, entries[photo["path"]], MAX_PHOTO_BYTES)
                if len(data) != photo["byteLength"] or hashlib.sha256(data).hexdigest() != photo["sha256"]:
                    _fail("photo length or SHA-256 mismatch")
                if not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9"):
                    _fail("photo must contain JPEG bytes")
                if _jpeg_dimensions(data) != (photo["width"], photo["height"]):
                    _fail("JPEG dimensions differ from manifest")
                files[photo["path"]] = data
            return {"scan": raw_scan, "scanBytes": scan_bytes, "manifest": manifest,
                    "manifestBytes": manifest_bytes, "files": files, "archiveBytes": body,
                    **({"mesh": mesh} if mesh is not None else {}),
                    "sha256": hashlib.sha256(body).hexdigest()}
    except RoomPlanError:
        raise
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, RecursionError,
            OverflowError, zipfile.BadZipFile, NotImplementedError, EOFError, BundleError,
            struct.error, zlib.error) as error:
        raise RoomPlanError("RoomPlan photo bundle is unreadable, corrupt or invalid") from error


def representative_photos(photos, maximum=8):
    """Deterministic pose diversity, not a claim of image quality or coverage."""
    if len(photos) <= maximum:
        return list(photos)
    def distance(first, second):
        a, b = first["cameraToWorld"], second["cameraToWorld"]
        position = sum((a[i] - b[i]) ** 2 for i in (12, 13, 14))
        # Optical axis orientation also distinguishes photos taken from one spot.
        axis = max(-1, min(1, sum(a[i] * b[i] for i in (8, 9, 10))))
        return position + 2 * (1 - axis)
    selected = [0]
    while len(selected) < maximum:
        selected.append(max((i for i in range(len(photos)) if i not in selected),
                            key=lambda i: (min(distance(photos[i], photos[j]) for j in selected), -i)))
    return [photos[i] for i in sorted(selected)]
