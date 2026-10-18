"""Bounded public HTTP downloads for untrusted property evidence URLs.

No credentials, cookies, environment proxies, or local-network access. DNS is
checked once per hop and the socket is pinned to that checked address while TLS
still verifies the original hostname. This is a guardrail, not a process sandbox.
"""

from __future__ import annotations

import http.client
import ipaddress
import math
import queue
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from urllib.parse import quote, urljoin, urlsplit, urlunsplit


class FetchError(ValueError):
    """The requested evidence could not safely be downloaded."""


@dataclass(frozen=True)
class FetchResult:
    url: str
    content_type: str
    body: bytes


def public_url(url: str) -> str:
    """Validate syntax; host DNS/IP policy is additionally checked at fetch time."""
    if not isinstance(url, str) or not url or len(url) > 8192:
        raise FetchError("Evidence URL is missing or too long")
    if any(ord(char) < 33 or ord(char) == 127 for char in url) or "\\" in url:
        raise FetchError("Evidence URL contains unsupported characters")
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise FetchError("Only absolute HTTP(S) evidence URLs are allowed")
        if parsed.username is not None or parsed.password is not None:
            raise FetchError("Credential-bearing evidence URLs are not allowed")
        hostname = parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
        if not hostname or "%" in hostname:
            raise FetchError("Invalid evidence hostname")
        port = parsed.port
        if port is not None and port not in {80, 443}:
            raise FetchError("Only HTTP ports 80 and 443 are allowed")
    except (ValueError, UnicodeError) as exc:
        if isinstance(exc, FetchError):
            raise
        raise FetchError("Invalid evidence URL") from exc
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise FetchError("Local evidence hosts are not allowed")
    # Preserve literal IPv6 brackets; HTTP Host and TLS use their normal forms.
    authority = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None:
        authority += f":{port}"
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~[]")
    return urlunsplit((parsed.scheme.lower(), authority, path, query, ""))


def _public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if isinstance(address, ipaddress.IPv6Address):
            # Do not route through transition encodings with hidden private IPv4.
            if address.sixtofour and not _public_ip(str(address.sixtofour)):
                return False
            if address.teredo and any(not _public_ip(str(item)) for item in address.teredo):
                return False
        return address.is_global and not address.is_multicast and not address.is_reserved
    except ValueError:
        return False


def _resolve(hostname: str, port: int, timeout: float = 20) -> list[str]:
    # getaddrinfo has no portable Python timeout. A daemon resolver prevents a
    # stalled system DNS query from holding the request beyond its deadline.
    answers: queue.Queue = queue.Queue(maxsize=1)
    def resolve() -> None:
        try:
            answers.put(socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM))
        except OSError as exc:
            answers.put(exc)
    threading.Thread(target=resolve, daemon=True).start()
    try:
        records = answers.get(timeout=max(0.001, timeout))
    except queue.Empty as exc:
        raise FetchError("Evidence host resolution timed out") from exc
    if isinstance(records, OSError):
        raise FetchError("Evidence host could not be resolved") from records
    addresses = list(dict.fromkeys(record[4][0] for record in records))
    # Reject the entire answer if any address is unsafe, rather than falling back
    # to a public answer from a mixed public/private DNS record set.
    if not addresses or any(not _public_ip(address) for address in addresses):
        raise FetchError("Evidence host resolves to a nonpublic network address")
    return addresses


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, hostname: str, port: int, address: str, timeout: float):
        super().__init__(hostname, port, timeout=timeout)
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPSConnection(_PinnedHTTPConnection):
    def connect(self) -> None:
        super().connect()
        context = ssl.create_default_context()
        self.sock = context.wrap_socket(self.sock, server_hostname=self.host)


class PublicFetcher:
    """Fetch public HTTP evidence with at most four redirect hops."""

    def fetch(self, url: str, *, max_bytes: int = 8 * 1024 * 1024,
              timeout: float = 20) -> FetchResult:
        if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 0 < max_bytes <= 64 * 1024 * 1024:
            raise FetchError("Download byte limit must be between 1 and 64 MiB")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 120:
            raise FetchError("Download timeout must be between 0 and 120 seconds")
        current = public_url(url)
        deadline = time.monotonic() + timeout
        visited: set[str] = set()
        for hop in range(5):
            if current in visited:
                raise FetchError("Evidence redirect loop")
            visited.add(current)
            parsed = urlsplit(current)
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            addresses = _resolve(parsed.hostname or "", port, deadline - time.monotonic())
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FetchError("Evidence download timed out")
            result, location = self._request(current, addresses, max_bytes, deadline)
            if location is None:
                return result
            if hop == 4:
                raise FetchError("Evidence exceeded four redirects")
            current = public_url(urljoin(current, location))
        raise FetchError("Evidence redirect limit exceeded")

    def _request(self, url: str, addresses: list[str], max_bytes: int,
                 deadline: float) -> tuple[FetchResult, str | None]:
        parsed = urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        connection_type = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
        for address in addresses:
            connection = connection_type(parsed.hostname or "", port, address,
                                         max(0.001, deadline - time.monotonic()))
            watchdog: threading.Timer | None = None
            try:
                if time.monotonic() >= deadline:
                    raise FetchError("Evidence download timed out")
                target = parsed.path + ("?" + parsed.query if parsed.query else "")
                connection.request("GET", target, headers={
                    "User-Agent": "Tadaima-EvidenceResearch/1.0",
                    "Accept": "text/html,image/*,application/pdf;q=0.9,*/*;q=0.1",
                    "Accept-Encoding": "identity",
                    "Connection": "close",
                })
                stream_socket = connection.sock
                if stream_socket is not None:
                    # Socket timeouts alone reset across header lines and network
                    # packets. Shutdown at the overall deadline as well.
                    def interrupt_download() -> None:
                        try:
                            stream_socket.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                    watchdog = threading.Timer(max(0.001, deadline - time.monotonic()), interrupt_download)
                    watchdog.daemon = True
                    watchdog.start()
                response = connection.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader("Location")
                    if not location:
                        raise FetchError("Evidence redirect has no destination")
                    return FetchResult(url, "", b""), location
                if not 200 <= response.status < 300:
                    raise FetchError(f"Evidence server returned HTTP {response.status}")
                encoding = response.getheader("Content-Encoding", "identity").lower()
                if encoding not in {"identity", ""}:
                    raise FetchError("Compressed evidence responses are not accepted")
                length = response.getheader("Content-Length")
                if length is not None:
                    try:
                        if int(length) < 0 or int(length) > max_bytes:
                            raise FetchError("Evidence exceeds download byte limit")
                    except ValueError as exc:
                        if isinstance(exc, FetchError):
                            raise
                        raise FetchError("Invalid evidence Content-Length") from exc
                chunks = bytearray()
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise FetchError("Evidence download timed out")
                    if stream_socket is not None:
                        stream_socket.settimeout(remaining)
                    # read1 avoids a single read silently resetting its timeout
                    # across an arbitrary number of slow server packets.
                    chunk = response.read1(min(65536, max_bytes + 1 - len(chunks)))
                    if not chunk:
                        break
                    chunks.extend(chunk)
                    if len(chunks) > max_bytes:
                        raise FetchError("Evidence exceeds download byte limit")
                    # HTTPResponse closes its file/socket immediately when the
                    # final Content-Length chunk is consumed. Do not touch that
                    # closed socket on another iteration merely to discover EOF.
                    if response.isclosed():
                        break
                if length is not None and len(chunks) != int(length):
                    raise FetchError("Evidence download was truncated")
                return FetchResult(url, response.getheader("Content-Type", "").split(";", 1)[0].strip().lower(), bytes(chunks)), None
            except FetchError:
                raise
            except (OSError, http.client.HTTPException) as exc:
                if address == addresses[-1] or time.monotonic() >= deadline:
                    raise FetchError("Evidence connection failed or timed out") from exc
            finally:
                if watchdog is not None:
                    watchdog.cancel()
                connection.close()
        raise FetchError("Evidence connection failed")
