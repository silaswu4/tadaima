import assert from "node:assert/strict";
import { test } from "node:test";
import { productImageResponse, retailerImageURL } from "./product-image";

const image = "https://www.ikea.com/us/en/images/products/chair__123_s5.jpg?f=u";
const request = (url = image) => new Request(`http://localhost/api/product-image?url=${encodeURIComponent(url)}`);

test("only public retailer image hosts and paths are eligible", () => {
  assert.ok(retailerImageURL(image));
  assert.ok(retailerImageURL("https://target.scene7.com/is/image/Target/GUEST_123?wid=500"));
  for (const url of ["http://www.ikea.com/us/en/images/products/x.jpg", "https://localhost/x.jpg", "https://www.ikea.com.evil.test/us/en/images/products/x.jpg", "https://user:pass@www.ikea.com/us/en/images/products/x.jpg", "https://www.ikea.com:8443/us/en/images/products/x.jpg", "https://www.ikea.com/private", "https://www.ikea.com/us/en/images/products/x.svg", "https://target.scene7.com/other/x", "data:image/png,123", "//localhost/x.jpg"]) assert.equal(retailerImageURL(url), null, url);
});

test("invalid input never fetches; valid photos omit credentials and forbid redirects", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++; assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.headers, undefined);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
  };
  assert.equal((await productImageResponse(request("https://127.0.0.1/private"), fetcher)).status, 400);
  assert.equal(calls, 0);
  const response = await productImageResponse(request(), fetcher);
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test("non-images, redirects, failed downloads and oversized streams fail closed", async () => {
  for (const response of [new Response("<html>private</html>", { headers: { "content-type": "text/html" } }), new Response(null, { status: 302, headers: { location: "https://127.0.0.1" } }), new Response("missing", { status: 404 }), new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg", "content-length": "9999999" } })]) {
    assert.ok((await productImageResponse(request(), async () => response)).status >= 400);
  }
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); controller.close(); } });
  assert.equal((await productImageResponse(request(), async () => new Response(stream, { headers: { "content-type": "image/png" } }))).status, 413);
  assert.equal((await productImageResponse(request(), async () => { throw new Error("upstream unavailable"); })).status, 502);
});
