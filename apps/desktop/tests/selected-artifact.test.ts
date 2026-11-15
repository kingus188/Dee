import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readSelectedArtifact } from "../dist/selected-artifact.js";

test("selected artifact reads exactly one bounded regular file, rejects links and directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-artifact-"));
  try {
    const file = join(directory, "result.txt"); await writeFile(file, "result");
    const item = await readSelectedArtifact(file, "task", "device");
    assert.equal(item.name, "result.txt"); assert.equal(item.size, 6);
    assert.equal(item.sha256, createHash("sha256").update("result").digest("hex"));
    assert.equal(Buffer.from(item.data, "base64").toString(), "result");
    const link = join(directory, "link"); await symlink(file, link);
    await assert.rejects(readSelectedArtifact(link, "task", "device"));
    await assert.rejects(readSelectedArtifact(directory, "task", "device"));
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(readSelectedArtifact(file, "task", "device"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
