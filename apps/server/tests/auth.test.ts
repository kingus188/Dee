import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { authorized, sameOrigin, secureMatch } from "../dist/http/auth.js";

test("独立 HTTP 鉴权保留口令与同源保护", () => {
  const req = new IncomingMessage(new Socket());
  assert.equal(authorized(req, "sample"), false);
  req.headers.authorization = "Basic " + Buffer.from("demo:sample").toString("base64");
  assert.equal(authorized(req, "sample"), true);
  req.headers.host = "localhost:3000"; req.headers.origin = "https://another.example";
  assert.equal(sameOrigin(req), false);
  req.headers.origin = "http://localhost:3000"; assert.equal(sameOrigin(req), true);
  assert.equal(secureMatch("", ""), false);
});
