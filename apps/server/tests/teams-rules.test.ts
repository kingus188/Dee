import assert from "node:assert/strict";
import test from "node:test";
import { isImportant } from "../dist/teams-rules.js";

const base = { chatType: "group", text: "hello", mentionsMe: false };

test("default rules only forward direct chats", () => {
  assert.equal(isImportant(undefined, { ...base, chatType: "oneOnOne" }), true);
  assert.equal(isImportant(undefined, base), false);
});

test("mention, sender and keyword rules each match independently", () => {
  assert.equal(isImportant({ mention: true }, { ...base, mentionsMe: true }), true);
  assert.equal(isImportant({ senders: ["Boss@x.com"] }, { ...base, senderName: "boss@x.com" }), true);
  assert.equal(isImportant({ keywords: ["紧急"] }, { ...base, text: "这个很紧急" }), true);
  assert.equal(isImportant({ keywords: ["紧急"], senders: ["a"] }, base), false);
});
