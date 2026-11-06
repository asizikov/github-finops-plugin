import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResponse, rateLimitDeadline } from "./github.mjs";

test("parses gh response headers and honors the later Retry-After/reset deadline", () => {
    const now = Date.parse("2025-01-01T00:00:00Z");
    const response = parseResponse(`HTTP/2.0 403 Forbidden\r\nRetry-After: 30\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${now / 1000 + 90}\r\n\r\n{"message":"API rate limit exceeded"}`);
    assert.equal(response.status, 403);
    assert.equal(rateLimitDeadline(response, now), "2025-01-01T00:01:30.000Z");
    assert.match(response.body, /rate limit/);
});

test("honors HTTP-date Retry-After and uses a bounded fallback only for rate limits", () => {
    const now = Date.parse("2025-01-01T00:00:00Z");
    const response = (status, headers = [], body = "") => ({ status, headers: new Map(headers), body });
    assert.equal(rateLimitDeadline(response(429, [["retry-after", "Wed, 01 Jan 2025 00:02:00 GMT"]]), now), "2025-01-01T00:02:00.000Z");
    assert.equal(rateLimitDeadline(response(429), now), "2025-01-01T00:01:00.000Z");
    assert.equal(rateLimitDeadline(response(403, [], "secondary rate limit"), now), "2025-01-01T00:01:00.000Z");
    assert.equal(rateLimitDeadline(response(403, [], "Permission denied"), now), null);
    assert.equal(rateLimitDeadline(response(200, [
        ["x-ratelimit-remaining", "0"], ["x-ratelimit-reset", String(now / 1000 + 120)],
    ]), now), "2025-01-01T00:02:00.000Z");
});
