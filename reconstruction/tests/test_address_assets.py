"""Untrusted property media extraction and public downloader guardrails."""

import io
import http.client
import socket
import struct
import time
import unittest
from unittest.mock import patch

from reconstruction.address.assets import downloadable_asset, extract_page_assets
from reconstruction.address.network import (
    FetchError, FetchResult, PublicFetcher, _PinnedHTTPSConnection, _public_ip,
    _resolve, public_url,
)


def dns(*addresses):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses]


class Response:
    def __init__(self, body=b"example", status=200, headers=None):
        self.body = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}

    def getheader(self, key, default=None):
        return self.headers.get(key, default)

    def read1(self, amount):
        return self.body.read(amount)

    def isclosed(self):
        return False


class Connection:
    responses = []
    calls = []

    def __init__(self, host, port, address, timeout):
        self.sock = None
        self.response = self.responses.pop(0)
        self.calls.append((host, port, address, timeout))

    def request(self, method, target, headers):
        self.calls.append((method, target, headers))

    def getresponse(self):
        return self.response

    def close(self):
        pass


class PublicNetworkTests(unittest.TestCase):
    def setUp(self):
        Connection.responses = []
        Connection.calls = []

    def test_rejects_local_and_non_http_urls(self):
        for url in ("file:///etc/passwd", "ftp://example.com/file", "data:image/png,abc",
                    "https://user:secret@example.com/", "https://example.com:8080/",
                    "http://localhost/", "http://localhost./", "http://printer.local/",
                    "https://example.com/\nHost:evil", "https://example.com\\@localhost/",
                    "https://[fe80::1%25en0]/"):
            with self.subTest(url=url), self.assertRaises(FetchError):
                public_url(url)

    def test_rejects_every_nonpublic_address_in_dns_answer(self):
        for address in ("127.0.0.1", "10.2.3.4", "169.254.169.254", "172.16.0.2",
                        "192.168.1.2", "100.64.0.1", "0.0.0.0", "224.0.0.1",
                        "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "2002:7f00:1::"):
            with self.subTest(address=address):
                self.assertFalse(_public_ip(address))
                with patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8", address)):
                    with self.assertRaises(FetchError):
                        PublicFetcher().fetch("https://example.com/image.jpg")

    def test_dns_failure_and_timeout_are_fetch_errors(self):
        with patch("reconstruction.address.network.socket.getaddrinfo", side_effect=socket.gaierror("no host")):
            with self.assertRaises(FetchError):
                _resolve("example.com", 443)
        def slow_dns(*args, **kwargs):
            time.sleep(0.05)
            return dns("8.8.8.8")
        with patch("reconstruction.address.network.socket.getaddrinfo", side_effect=slow_dns):
            with self.assertRaisesRegex(FetchError, "resolution timed out"):
                _resolve("example.com", 443, 0.001)

    def test_pins_resolved_address_and_keeps_original_host(self):
        Connection.responses = [Response(b"image", headers={"Content-Type": "image/jpeg; charset=binary"})]
        with patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8")), \
             patch("reconstruction.address.network._PinnedHTTPSConnection", Connection):
            result = PublicFetcher().fetch("https://example.com/a?q=1#fragment")
        self.assertEqual(result, FetchResult("https://example.com/a?q=1", "image/jpeg", b"image"))
        self.assertEqual(Connection.calls[0][:3], ("example.com", 443, "8.8.8.8"))
        self.assertEqual(Connection.calls[1][1], "/a?q=1")
        self.assertNotIn("Cookie", Connection.calls[1][2])

    def test_tls_verifies_original_hostname_after_pinned_connect(self):
        context = unittest.mock.Mock()
        sock = unittest.mock.Mock()
        with patch("reconstruction.address.network.socket.create_connection", return_value=sock) as connect, \
             patch("reconstruction.address.network.ssl.create_default_context", return_value=context):
            connection = _PinnedHTTPSConnection("property.example", 443, "8.8.8.8", 5)
            connection.connect()
        connect.assert_called_once_with(("8.8.8.8", 443), 5)
        context.wrap_socket.assert_called_once_with(sock, server_hostname="property.example")

    def test_redirect_revalidates_host_and_credentials(self):
        for target in ("http://127.0.0.1/latest/meta-data/", "https://u:p@example.com/secret"):
            Connection.responses = [Response(status=302, headers={"Location": target})]
            def resolve(host, port, **kwargs):
                return dns("127.0.0.1" if host == "127.0.0.1" else "8.8.8.8")
            with self.subTest(target=target), \
                 patch("reconstruction.address.network.socket.getaddrinfo", side_effect=resolve), \
                 patch("reconstruction.address.network._PinnedHTTPSConnection", Connection):
                with self.assertRaises(FetchError):
                    PublicFetcher().fetch("https://example.com/start")

    def test_relative_redirect_and_four_hop_limit(self):
        Connection.responses = [Response(status=302, headers={"Location": "/final"}), Response(b"done")]
        with patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8")), \
             patch("reconstruction.address.network._PinnedHTTPSConnection", Connection):
            result = PublicFetcher().fetch("https://example.com/start")
        self.assertEqual(result.url, "https://example.com/final")
        Connection.responses = [Response(status=302, headers={"Location": f"/hop-{n}"}) for n in range(5)]
        with patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8")), \
             patch("reconstruction.address.network._PinnedHTTPSConnection", Connection):
            with self.assertRaisesRegex(FetchError, "four redirects"):
                PublicFetcher().fetch("https://example.com/start")

    def test_detects_redirect_loop(self):
        Connection.responses = [Response(status=302, headers={"Location": "/start"})]
        with patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8")), \
             patch("reconstruction.address.network._PinnedHTTPSConnection", Connection):
            with self.assertRaisesRegex(FetchError, "loop"):
                PublicFetcher().fetch("https://example.com/start")

    def test_content_length_and_stream_byte_limits(self):
        cases = [Response(b"too large", headers={"Content-Length": "9"}),
                 Response(b"too large"), Response(b"ab", headers={"Content-Length": "3"}),
                 Response(b"ab", headers={"Content-Length": "invalid"}),
                 Response(b"ab", headers={"Content-Encoding": "gzip"})]
        for response in cases:
            Connection.responses = [response]
            with self.subTest(headers=response.headers), \
                 patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8")), \
                 patch("reconstruction.address.network._PinnedHTTPSConnection", Connection):
                with self.assertRaises(FetchError):
                    PublicFetcher().fetch("https://example.com/a", max_bytes=4)

    def test_final_content_length_chunk_does_not_reuse_closed_socket(self):
        # Use the actual stdlib parser: read1 closes HTTPResponse as soon as its
        # declared body length reaches zero, before another empty read is needed.
        raw_socket = unittest.mock.Mock()
        raw_socket.makefile.return_value = io.BytesIO(
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: image/jpeg\r\n\r\nimage")
        response = http.client.HTTPResponse(raw_socket)
        response.begin()
        stream_socket = unittest.mock.Mock()
        def settimeout(_):
            if response.isclosed():
                raise OSError("Bad file descriptor")
        stream_socket.settimeout.side_effect = settimeout
        class ClosedSocketConnection(Connection):
            def __init__(self, *args):
                super().__init__(*args)
                self.sock = stream_socket
        Connection.responses = [response]
        with patch("reconstruction.address.network.socket.getaddrinfo", return_value=dns("8.8.8.8")), \
             patch("reconstruction.address.network._PinnedHTTPSConnection", ClosedSocketConnection):
            result = PublicFetcher().fetch("https://example.com/photo.jpg")
        self.assertEqual(result.body, b"image")
        self.assertTrue(response.isclosed())
        stream_socket.settimeout.assert_called_once()

    def test_invalid_limits(self):
        for kwargs in ({"max_bytes": 0}, {"max_bytes": True}, {"max_bytes": 2**30},
                       {"timeout": 0}, {"timeout": float("nan")}, {"timeout": True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(FetchError):
                PublicFetcher().fetch("https://example.com/", **kwargs)


class PageAssetTests(unittest.TestCase):
    def test_html_sources_relative_urls_labels_and_jsonld(self):
        html = '''<title>Sample Apartments</title><meta name="description" content="Apartment 4B">
        <meta property="og:image" content="/front.jpg"><img src="/front.jpg">
        <img data-src="../plans/layout.png" alt="Unit 4B floor plan">
        <picture><source srcset="/small.webp 1x, /large.webp 2x"></picture>
        <img data-lazy-src="//cdn.example.com/room.jpg" alt="Living room">
        <script type="application/ld+json">{"@type":"ApartmentComplex","image":["/ld.jpg",{"@type":"ImageObject","contentUrl":"/ld2.jpg","caption":"Bedroom"}],"floorPlan":{"name":"4B","image":"/4b.png"}}</script>
        <a href="/brochure.pdf">Download brochure</a>
        <a href="https://my.matterport.com/show/?m=abc">Virtual tour</a>
        <a href="/floorplans">View floor plans</a>
        <script>secretScript()</script><style>hidden style</style>Visible description'''
        result = extract_page_assets(html, "https://property.example/units/4b")
        assets = {entry["url"]: entry for entry in result["assets"]}
        self.assertEqual(result["title"], "Sample Apartments")
        self.assertEqual(len([entry for entry in result["assets"] if entry["url"].endswith("front.jpg")]), 1)
        self.assertEqual(assets["https://property.example/plans/layout.png"]["kind"], "floor_plan")
        self.assertEqual(assets["https://property.example/brochure.pdf"]["kind"], "document")
        self.assertEqual(assets["https://property.example/4b.png"]["kind"], "floor_plan")
        self.assertIn("https://property.example/large.webp", assets)
        self.assertIn("https://cdn.example.com/room.jpg", assets)
        self.assertIn("https://property.example/ld2.jpg", assets)
        self.assertEqual(assets["https://my.matterport.com/show/?m=abc"]["kind"], "tour")
        self.assertIn("Visible description", result["text"])
        self.assertNotIn("secretScript", result["text"])
        self.assertNotIn("hidden style", result["text"])

    def test_does_not_follow_base_or_extract_unsafe_urls(self):
        html = '''<base href="http://localhost/"><img src="photo.jpg"><img src="data:image/png;base64,abc">
        <img src="/graphic.svg"><img src="javascript:alert(1)"><img src="https://u:p@example.com/secret.jpg">
        <a href="file:///etc/passwd">private</a>'''
        result = extract_page_assets(html, "https://example.com/page")
        self.assertEqual(result["assets"], [{"url": "https://example.com/photo.jpg", "kind": "photo", "label": ""}])
        self.assertEqual(result["links"], [])

    def test_extraction_is_bounded_and_malformed_json_is_ignored(self):
        html = '<script type="application/ld+json">invalid</script>' + "text " * 10_000
        html += "".join(f'<img src="/{index}.png"><a href="/page/{index}">page {index}</a>' for index in range(250))
        result = extract_page_assets(html, "https://example.com/")
        self.assertLessEqual(len(result["assets"]), 80)
        self.assertLessEqual(len(result["links"]), 40)
        self.assertLessEqual(len(result["text"]), 20_000)


class AssetFileTests(unittest.TestCase):
    def check(self, body, expected):
        # MIME is deliberately wrong. Actual bytes determine the output type.
        return self.assertEqual(downloadable_asset(FetchResult("https://example.com/fake.html", "text/html", body)), expected)

    def test_supported_magic_not_server_mime(self):
        png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", 10, 20) + b"\x00" * 9
        self.check(png, {"extension": "png", "mediaType": "image/png"})
        self.check(b"GIF89a" + struct.pack("<HH", 10, 20) + b"\x00" * 3,
                   {"extension": "gif", "mediaType": "image/gif"})
        self.check(b"%PDF-1.7\nexample", {"extension": "pdf", "mediaType": "application/pdf"})
        jpeg = b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", 20, 10) + b"\x00" * 10
        self.check(jpeg, {"extension": "jpg", "mediaType": "image/jpeg"})
        webp = b"RIFF" + b"\x00" * 4 + b"WEBPVP8X" + b"\x00" * 8 + (9).to_bytes(3, "little") + (19).to_bytes(3, "little")
        self.check(webp, {"extension": "webp", "mediaType": "image/webp"})

    def test_rejects_html_svg_unknown_and_malformed_images(self):
        for body in (b"<html>not an image</html>", b"<svg>unsafe</svg>", b"\xff\xd8\xffjunk", b"", b"\x89PNG\r\n\x1a\n"):
            with self.subTest(body=body), self.assertRaises(FetchError):
                downloadable_asset(FetchResult("https://example.com/floorplan.png", "image/png", body))

    def test_rejects_oversized_image_dimensions(self):
        for width, height in ((0, 5), (100_000, 100_000)):
            body = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", width, height) + b"\x00" * 9
            with self.subTest(size=(width, height)), self.assertRaises(FetchError):
                downloadable_asset(FetchResult("https://example.com/image.png", "image/png", body))


if __name__ == "__main__":
    unittest.main()
