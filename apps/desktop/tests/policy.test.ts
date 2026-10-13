import assert from "node:assert/strict";
import test from "node:test";
import { isAppUrl, isExternalUrl } from "../dist/policy.js";

test("desktop credentials and navigation stay on the exact local origin", () => {
  const origin = "http://127.0.0.1:43123";
  assert.equal(isAppUrl(origin + "/api/info", origin), true);
  for (const url of ["http://127.0.0.1:43124/", "http://127.0.0.1.evil.test:43123/", "file:///tmp/test", "invalid"]) {
    assert.equal(isAppUrl(url, origin), false);
  }
});

test("external links only allow HTTP(S) without embedded credentials", () => {
  assert.equal(isExternalUrl("https://example.com/docs"), true);
  for (const url of ["javascript:alert(1)", "file:///tmp/test", "vscode://test", "https://user:password@example.com", "invalid"]) {
    assert.equal(isExternalUrl(url), false);
  }
});
