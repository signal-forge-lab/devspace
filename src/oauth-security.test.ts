import assert from "node:assert/strict";
import {
  AuthorizationAttemptLimiter,
  isAllowedOAuthRedirectUri,
  requestAddress,
} from "./oauth-security.js";

assert.equal(isAllowedOAuthRedirectUri("https://chatgpt.com/callback", ["chatgpt.com"]), true);
assert.equal(isAllowedOAuthRedirectUri("http://chatgpt.com/callback", ["chatgpt.com"]), false);
assert.equal(isAllowedOAuthRedirectUri("https://evil.example/callback", ["chatgpt.com"]), false);
assert.equal(isAllowedOAuthRedirectUri("http://localhost:3000/callback", ["chatgpt.com"]), true);
assert.equal(isAllowedOAuthRedirectUri("http://127.0.0.1:3000/callback", ["chatgpt.com"]), true);
assert.equal(isAllowedOAuthRedirectUri("http://[::1]:3000/callback", ["chatgpt.com"]), true);
assert.equal(isAllowedOAuthRedirectUri("https://user:pass@chatgpt.com/callback", ["chatgpt.com"]), false);
assert.equal(isAllowedOAuthRedirectUri("https://chatgpt.com/callback#fragment", ["chatgpt.com"]), false);

const limiter = new AuthorizationAttemptLimiter({
  maxFailures: 3,
  failureWindowMs: 1_000,
  blockDurationMs: 5_000,
  failureDelayMs: 0,
});
assert.equal(limiter.recordFailure("ip", 1_000), 0);
assert.equal(limiter.recordFailure("ip", 1_100), 0);
assert.equal(limiter.recordFailure("ip", 1_200), 5_000);
assert.equal(limiter.retryAfterMs("ip", 2_200), 4_000);
assert.equal(limiter.retryAfterMs("ip", 6_201), 0);
limiter.recordFailure("success", 10_000);
limiter.recordSuccess("success");
assert.equal(limiter.retryAfterMs("success", 10_001), 0);

assert.equal(requestAddress({ ip: "203.0.113.10" }), "203.0.113.10");
assert.equal(requestAddress({ socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
assert.equal(requestAddress({}), "unknown");
