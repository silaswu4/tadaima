"""Read a bounded guided-capture ZIP entirely in memory, without extraction.

The bundle proves which bytes accompany a manifest. It does not prove that the
photos show the stated walls, that their measurements are correct, or that a
camera was used. JPEG screening is not a full image decoder or malware scanner.
"""

from __future__ import annotations

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

from reconstruction.address.assets import downloadable_asset
from reconstruction.address.network import FetchError, FetchResult


MAX_ZIP_BYTES = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
MAX_PHOTO_BYTES = 4 * 1024 * 1024
MAX_TOTAL_PHOTO_BYTES = 24 * 1024 * 1024
MAX_PHOTOS = 16
_PHOTO_PATH = re.compile(r"photos/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.jpg")


class BundleError(ValueError):
    """Capture archive is invalid, unsafe, or outside the supported limits."""


def _validate_manifest(value: object) -> dict:
    # Runtime import lets the geometry module remain the canonical metadata
    # validator without making this reader a competing room schema.
    from .geometry import validate_manifest
    return validate_manifest(value)


def _json(body: bytes) -> object:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise BundleError("capture.json contains duplicate keys")
            result[key] = value
        return result
    def number(value):
        converted = float(value)
        if not math.isfinite(converted):
            raise BundleError("capture.json contains a nonfinite number")
        return converted
    def constant(_):
        raise BundleError("capture.json contains a nonfinite number")
    try:
        return json.loads(body.decode("utf-8"), object_pairs_hook=pairs,
                          parse_float=number, parse_constant=constant)
    except BundleError:
        raise
    except (ValueError, UnicodeError, RecursionError) as error:
        raise BundleError("capture.json is not valid bounded UTF-8 JSON") from error


def _jpeg_dimensions(body: bytes) -> tuple[int, int]:
    """Read JPEG SOF dimensions without decoding untrusted image pixels."""
    cursor = 2
    while cursor + 4 <= len(body):
        if body[cursor] != 0xFF:
            cursor += 1
            continue
        while cursor < len(body) and body[cursor] == 0xFF:
            cursor += 1
        if cursor >= len(body):
            break
        marker = body[cursor]
        cursor += 1
        if marker in {0xD8, 0xD9, 0x00} or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xDA:
            break
        if cursor + 2 > len(body):
            break
        length = int.from_bytes(body[cursor:cursor + 2], "big")
        if length < 2 or cursor + length > len(body):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 7:
            height, width = struct.unpack(">HH", body[cursor + 3:cursor + 7])
            return width, height
        cursor += length
    raise BundleError("Capture JPEG has no readable dimensions")


def _read_entry(archive: zipfile.ZipFile, entry: zipfile.ZipInfo, limit: int) -> bytes:
    if not 0 <= entry.file_size <= limit:
        raise BundleError("Capture entry exceeds its declared byte limit")
    with archive.open(entry, "r") as stream:
        body = stream.read(limit + 1)
        if len(body) > limit or len(body) != entry.file_size:
            raise BundleError("Capture entry exceeds its actual byte limit or is truncated")
        if entry.compress_type == zipfile.ZIP_DEFLATED:
            # ZipExtFile verifies CRC, but a forged declared size/CRC must not
            # make an unfinished raw-deflate stream look like a complete file.
            decoder = getattr(stream, "_decompressor", None)
            if decoder is None or not decoder.eof or decoder.unused_data:
                raise BundleError("Capture entry has a truncated or padded deflate stream")
    return body


def _check_archive_framing(body: bytes) -> None:
    if not body.startswith(b"PK\x03\x04"):
        raise BundleError("Capture bundle must be a ZIP without a prefixed payload")
    # Reject trailing payloads rather than relying on ZipFile's permissive search
    # for an end record. ZIP comments are permitted, up to the format's 64 KiB.
    start = max(0, len(body) - 65557)
    end = body.rfind(b"PK\x05\x06", start)
    if end < 0 or end + 22 > len(body):
        raise BundleError("Capture ZIP has no complete end record")
    comment_length = int.from_bytes(body[end + 20:end + 22], "little")
    if end + 22 + comment_length != len(body):
        raise BundleError("Capture ZIP is truncated or has a trailing payload")
    disk, directory_disk, disk_entries, total_entries = struct.unpack("<HHHH", body[end + 4:end + 12])
    if disk or directory_disk or disk_entries != total_entries:
        raise BundleError("Multipart capture ZIPs are not supported")
    # ZipFile allocates ZipInfo objects while constructing the archive. Bound
    # both the claimed and actual directory count before invoking that parser.
    if not 1 <= total_entries <= MAX_PHOTOS + 1:
        raise BundleError("Capture ZIP must contain capture.json and at most 16 photos")
    directory_size, directory_offset = struct.unpack("<II", body[end + 12:end + 20])
    if directory_offset + directory_size != end:
        raise BundleError("Capture ZIP central directory is invalid or unsupported")
    cursor = directory_offset
    count = 0
    while cursor < end:
        if count >= MAX_PHOTOS + 1 or cursor + 46 > end or body[cursor:cursor + 4] != b"PK\x01\x02":
            raise BundleError("Capture ZIP central directory exceeds its entry limit or is corrupt")
        name_size, extra_size, entry_comment_size = struct.unpack("<HHH", body[cursor + 28:cursor + 34])
        cursor += 46 + name_size + extra_size + entry_comment_size
        count += 1
    if cursor != end or count != total_entries:
        raise BundleError("Capture ZIP central directory count or length is inconsistent")


def read_bundle(path) -> dict:
    """Return validated manifest, filename-to-photo-byte mapping, and warnings.

    Accept only capture.json and exactly its declared photos/<safe-id>.jpg files.
    Both stored ZIPs emitted by the mobile web client and bounded raw-deflate ZIPs
    are supported. Archive paths are compared as data and never written to disk.
    """
    try:
        with Path(path).open("rb") as source:
            body = source.read(MAX_ZIP_BYTES + 1)
        if len(body) > MAX_ZIP_BYTES:
            raise BundleError("Capture ZIP exceeds 32 MiB")
        _check_archive_framing(body)
        with zipfile.ZipFile(io.BytesIO(body), "r") as archive:
            entries = archive.infolist()
            if not 1 <= len(entries) <= MAX_PHOTOS + 1:
                raise BundleError("Capture ZIP must contain capture.json and at most 16 photos")
            names = set()
            total = 0
            by_name = {}
            for entry in entries:
                name = entry.filename
                if name != entry.orig_filename or "\\" in name or name in names:
                    raise BundleError("Capture ZIP contains duplicate or invalid paths")
                if name != "capture.json" and not _PHOTO_PATH.fullmatch(name):
                    raise BundleError("Capture ZIP contains an unexpected or unsafe path")
                names.add(name)
                by_name[name] = entry
                mode = entry.external_attr >> 16
                if entry.is_dir() or (entry.external_attr & 0x10) or stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                    raise BundleError("Capture ZIP links and nonregular entries are not allowed")
                if entry.flag_bits & (1 | 32 | 64):
                    raise BundleError("Encrypted or patched capture ZIP entries are not allowed")
                if not 0 <= entry.header_offset <= len(body) - 30:
                    raise BundleError("Capture ZIP has an invalid local entry offset")
                local = struct.unpack("<IHHHHHIIIHH", body[entry.header_offset:entry.header_offset + 30])
                if local[0] != 0x04034B50 or local[2] != entry.flag_bits or local[3] != entry.compress_type:
                    raise BundleError("Capture ZIP local and central entry headers disagree")
                if not (entry.flag_bits & 8) and (local[6], local[7], local[8]) != (entry.CRC, entry.compress_size, entry.file_size):
                    raise BundleError("Capture ZIP local and central sizes or CRC disagree")
                if entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise BundleError("Capture ZIP uses an unsupported compression method")
                if not 0 <= entry.compress_size <= MAX_ZIP_BYTES:
                    raise BundleError("Capture entry exceeds its compressed byte limit")
                maximum = MAX_MANIFEST_BYTES if name == "capture.json" else MAX_PHOTO_BYTES
                if not 0 <= entry.file_size <= maximum:
                    raise BundleError("Capture entry exceeds its declared byte limit")
                if name != "capture.json":
                    total += entry.file_size
                if entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 200:
                    raise BundleError("Capture ZIP has an unsafe compression ratio")
            if "capture.json" not in by_name:
                raise BundleError("Capture ZIP is missing capture.json")
            if total > MAX_TOTAL_PHOTO_BYTES:
                raise BundleError("Capture photos exceed 24 MiB")
            raw_manifest = _json(_read_entry(archive, by_name["capture.json"], MAX_MANIFEST_BYTES))
            try:
                manifest = _validate_manifest(raw_manifest)
            except (ValueError, TypeError, KeyError) as error:
                raise BundleError(f"Capture manifest is invalid: {error}") from error
            photos = manifest["photos"]
            if len(photos) > MAX_PHOTOS:
                raise BundleError("Capture manifest exceeds 16 photos")
            expected = {"capture.json"}
            for photo in photos:
                name = photo["fileName"]
                if name != f"photos/{photo['id']}.jpg" or not _PHOTO_PATH.fullmatch(name) or name in expected:
                    raise BundleError("Manifest photo filenames must be unique photos/<id>.jpg paths")
                expected.add(name)
            if names != expected:
                raise BundleError("Capture ZIP files differ from the manifest's declared photos")
            files = {}
            actual_total = 0
            hashes = set()
            walls = set()
            warnings = []
            for photo in photos:
                data = _read_entry(archive, by_name[photo["fileName"]], MAX_PHOTO_BYTES)
                actual_total += len(data)
                if actual_total > MAX_TOTAL_PHOTO_BYTES:
                    raise BundleError("Capture photos exceed 24 MiB in actual bytes")
                digest = hashlib.sha256(data).hexdigest()
                if digest != photo["sha256"]:
                    raise BundleError("Capture photo SHA-256 does not match its manifest")
                media = downloadable_asset(FetchResult("https://capture.invalid/photo.jpg", "image/jpeg", data))
                if media["mediaType"] != "image/jpeg" or photo["mediaType"] != "image/jpeg":
                    raise BundleError("Capture photos must contain JPEG bytes")
                width, height = _jpeg_dimensions(data)
                if not 320 <= width <= 4096 or not 320 <= height <= 4096:
                    raise BundleError("Capture JPEG dimensions must be between 320 and 4096 pixels")
                if (width, height) != (photo["width"], photo["height"]):
                    raise BundleError("Capture JPEG dimensions do not match its manifest")
                if digest in hashes:
                    warnings.append(f"Photo {photo['id']} duplicates another image; repeated bytes do not prove wall coverage.")
                hashes.add(digest)
                walls.add(photo["wall"])
                files[photo["fileName"]] = data
            missing = sorted({"a", "b", "c", "d"} - walls)
            if missing:
                warnings.append("Missing labeled wall photos: " + ", ".join(wall.upper() for wall in missing) + ".")
            warnings.append("Photo labels and browser quality observations do not verify camera use, wall coverage, or physical measurements.")
            return {"manifest": manifest, "files": files, "warnings": warnings,
                    "sha256": hashlib.sha256(body).hexdigest()}
    except BundleError:
        raise
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile,
            NotImplementedError, EOFError, FetchError, struct.error, zlib.error) as error:
        raise BundleError("Capture ZIP is unreadable, corrupt, or contains invalid media") from error
