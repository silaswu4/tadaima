"""Extract bounded, source-linked property media; verify downloaded file bytes."""

from __future__ import annotations

import json
import re
import struct
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlsplit

from .network import FetchError, FetchResult, public_url


MAX_IMAGE_PIXELS = 100_000_000


def _kind(value: str, default: str = "photo") -> str:
    value = unquote(value).lower()
    if any(word in value for word in ("floorplan", "floor-plan", "floor_plan", "floor plan", "layout", "blueprint")):
        return "floor_plan"
    if any(word in value for word in ("matterport", "virtual-tour", "virtualtour", "3d-tour", "3dtour", "360-tour")):
        return "tour"
    if re.search(r"\.pdf(?:[?#\s]|$)", value):
        return "document"
    return default


def _safe_url(value: str, base: str) -> str | None:
    if not value or len(value) > 8192:
        return None
    try:
        url = public_url(urljoin(base, value.strip()))
        if urlsplit(url).path.lower().endswith((".svg", ".svgz")):
            return None
        return url
    except FetchError:
        return None


class _PageParser(HTMLParser):
    def __init__(self, page_url: str):
        super().__init__(convert_charrefs=True)
        self.page_url = page_url
        self.assets: dict[str, dict] = {}
        self.links: dict[str, dict] = {}
        self.parts: list[str] = []
        self.text_length = 0
        self.title_parts: list[str] = []
        self.in_title = False
        self.skip_depth = 0
        self.json_script: list[str] | None = None
        self.anchor: dict | None = None

    def add_asset(self, value: str, label: str = "", kind: str | None = None) -> None:
        url = _safe_url(value, self.page_url)
        if url is None:
            return
        label = " ".join(label.split())[:500]
        entry = {"url": url, "kind": kind or _kind(label + " " + url), "label": label}
        if url in self.assets:
            if entry["kind"] == "floor_plan":
                self.assets[url]["kind"] = "floor_plan"
            if not self.assets[url]["label"] and label:
                self.assets[url]["label"] = label
        elif len(self.assets) < 80:
            self.assets[url] = entry

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "script":
            self.skip_depth += 1
            if attributes.get("type", "").lower().split(";")[0].strip() == "application/ld+json":
                self.json_script = []
            return
        if tag in {"style", "template"}:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        label = attributes.get("alt") or attributes.get("title") or attributes.get("aria-label") or ""
        if tag in {"img", "source"}:
            for key in ("src", "data-src", "data-original", "data-lazy-src", "data-url"):
                value = attributes.get(key)
                if value:
                    self.add_asset(value, label)
            for key in ("srcset", "data-srcset"):
                value = attributes.get(key)
                if value:
                    for candidate in value.split(",")[:24]:
                        words = candidate.strip().split()
                        if words:
                            self.add_asset(words[0], label)
        if tag == "meta":
            name = (attributes.get("property") or attributes.get("name") or "").lower()
            if name in {"og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"}:
                self.add_asset(attributes.get("content") or "", label)
            if name in {"description", "og:description"}:
                self._text(attributes.get("content") or "")
        if tag == "link" and attributes.get("rel", "").lower() == "image_src":
            self.add_asset(attributes.get("href") or "", label)
        if tag == "video" and attributes.get("poster"):
            self.add_asset(attributes["poster"], label)
        if tag in {"iframe", "embed", "object"}:
            value = attributes.get("src") or attributes.get("data") or ""
            kind = _kind(value + " " + label, "unknown")
            if kind in {"tour", "floor_plan", "document"}:
                self.add_asset(value, label, kind)
        if tag == "a":
            self._finish_anchor()
            self.anchor = {"url": attributes.get("href") or "", "parts": [label]}

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag == "script":
            if self.json_script is not None:
                try:
                    self._json_assets(json.loads("".join(self.json_script)))
                except (ValueError, RecursionError):
                    pass
                self.json_script = None
            self.skip_depth = max(0, self.skip_depth - 1)
        elif tag in {"style", "template"}:
            self.skip_depth = max(0, self.skip_depth - 1)
        elif tag == "a":
            self._finish_anchor()

    def handle_data(self, data: str) -> None:
        if self.json_script is not None:
            if sum(map(len, self.json_script)) < 250_000:
                self.json_script.append(data[:250_000])
            return
        if self.skip_depth:
            return
        if self.in_title:
            self.title_parts.append(data[:1000])
        if self.anchor is not None and len(self.anchor["parts"]) < 30:
            self.anchor["parts"].append(data[:500])
        self._text(data)

    def _text(self, data: str) -> None:
        text = " ".join(data.split())
        if text and self.text_length < 20_000:
            part = text[:20_000 - self.text_length]
            self.parts.append(part)
            self.text_length += len(part) + 1

    def _finish_anchor(self) -> None:
        if self.anchor is None:
            return
        label = " ".join(" ".join(self.anchor["parts"]).split())[:500]
        url = _safe_url(self.anchor["url"], self.page_url)
        if url:
            kind = _kind(url + " " + label, "unknown")
            if kind in {"floor_plan", "document", "tour"}:
                self.add_asset(url, label, kind)
            # Keep a bounded discovery pool; final priority favors relevant pages.
            if len(self.links) < 200:
                self.links.setdefault(url, {"url": url, "label": label})
        self.anchor = None

    def _json_assets(self, value: object, context: str = "", depth: int = 0) -> None:
        if depth > 12 or len(self.assets) >= 80:
            return
        if isinstance(value, list):
            for item in value[:100]:
                self._json_assets(item, context, depth + 1)
        elif isinstance(value, dict):
            label = str(value.get("caption") or value.get("name") or value.get("description") or "")[:500]
            media_context = context in {"image", "photo", "floorplan", "floor_plan", "floorplans"}
            image_object = "imageobject" in str(value.get("@type", "")).lower()
            if media_context or image_object:
                for key in ("contentUrl", "url", "thumbnailUrl"):
                    asset = value.get(key)
                    if isinstance(asset, str):
                        self.add_asset(asset, label, "floor_plan" if "floor" in context else None)
            for key, item in list(value.items())[:100]:
                child_context = key.lower() if key.lower() in {"image", "photo", "floorplan", "floor_plan", "floorplans"} else context
                if "floor" in context and child_context in {"image", "photo"}:
                    child_context = context
                if isinstance(item, str) and child_context in {"image", "photo", "floorplan", "floor_plan", "floorplans"} and key.lower() in {"image", "photo", "floorplan", "floor_plan", "floorplans"}:
                    self.add_asset(item, label, "floor_plan" if "floor" in child_context else None)
                elif isinstance(item, (dict, list)):
                    self._json_assets(item, child_context, depth + 1)
        elif isinstance(value, str) and context in {"image", "photo", "floorplan", "floor_plan", "floorplans"}:
            self.add_asset(value, "", "floor_plan" if "floor" in context else None)


def extract_page_assets(html: str, page_url: str) -> dict:
    """Extract candidates, not verified unit identities or dimensional truth."""
    parser = _PageParser(public_url(page_url))
    try:
        parser.feed(html[:2 * 1024 * 1024])
        parser.close()
        parser._finish_anchor()
    except (ValueError, RecursionError):
        pass
    links = sorted(parser.links.values(), key=lambda entry: (
        _kind(entry["url"] + " " + entry["label"], "unknown") == "unknown",
        not any(word in (entry["url"] + " " + entry["label"]).lower() for word in ("apartment", "unit", "photo", "gallery", "residen")),
    ))[:40]
    return {"title": " ".join(" ".join(parser.title_parts).split())[:1000],
            "text": " ".join(parser.parts)[:20_000],
            "assets": list(parser.assets.values()), "links": links}


def _jpeg_size(body: bytes) -> tuple[int, int] | None:
    position = 2
    while position + 4 <= len(body):
        if body[position] != 0xFF:
            position += 1
            continue
        while position < len(body) and body[position] == 0xFF:
            position += 1
        if position >= len(body):
            break
        marker = body[position]
        position += 1
        if marker in {0xD8, 0xD9, 0x00} or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xDA:  # Image payload begins after dimensions.
            break
        if position + 2 > len(body):
            break
        length = int.from_bytes(body[position:position + 2], "big")
        if length < 2 or position + length > len(body):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and length >= 7:
            height, width = struct.unpack(">HH", body[position + 3:position + 7])
            return width, height
        position += length
    return None


def downloadable_asset(response: FetchResult) -> dict:
    """Sniff accepted media independently of extension or server MIME claims.

    This is file-type screening, not antivirus or full codec validation. Downstream
    decoders must still run with memory/time limits and treat files as untrusted.
    """
    body = response.body
    if not body or len(body) > 8 * 1024 * 1024:
        raise FetchError("Evidence asset is empty or exceeds 8 MiB")
    size = None
    if body.startswith(b"\x89PNG\r\n\x1a\n") and len(body) >= 33 and body[12:16] == b"IHDR":
        extension, media_type = "png", "image/png"
        size = struct.unpack(">II", body[16:24])
    elif body.startswith(b"\xff\xd8\xff"):
        extension, media_type = "jpg", "image/jpeg"
        size = _jpeg_size(body)
        if size is None:
            raise FetchError("JPEG evidence has no readable dimensions")
    elif body[:6] in {b"GIF87a", b"GIF89a"} and len(body) >= 13:
        extension, media_type = "gif", "image/gif"
        size = struct.unpack("<HH", body[6:10])
    elif len(body) >= 30 and body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        extension, media_type = "webp", "image/webp"
        chunk = body[12:16]
        if chunk == b"VP8X":
            size = (int.from_bytes(body[24:27], "little") + 1, int.from_bytes(body[27:30], "little") + 1)
        elif chunk == b"VP8 " and len(body) >= 30 and body[23:26] == b"\x9d\x01\x2a":
            width, height = struct.unpack("<HH", body[26:30])
            size = (width & 0x3FFF, height & 0x3FFF)
        elif chunk == b"VP8L" and body[20] == 0x2F:
            bits = int.from_bytes(body[21:25], "little")
            size = ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        if size is None:
            raise FetchError("WebP evidence has no readable dimensions")
    elif re.match(rb"%PDF-\d\.\d", body[:8]):
        extension, media_type = "pdf", "application/pdf"
    else:
        raise FetchError("Evidence is not a supported PNG/JPEG/WebP/GIF/PDF file")
    if size is not None and (size[0] <= 0 or size[1] <= 0 or size[0] * size[1] > MAX_IMAGE_PIXELS):
        raise FetchError("Evidence image dimensions exceed the pixel limit")
    return {"extension": extension, "mediaType": media_type}
