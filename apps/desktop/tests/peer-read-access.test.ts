import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { PeerJob } from "@assistant/runtime";
import { peerReadAllowed, peerWorkspaceRoot, peerPathWithin } from "../dist/peer-read-access.js";

test("peer file reads stay within the approved canonical workspace and reject replacement or symlink escape", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dee-peer-root-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "approved"), outside = join(directory, "outside");
  await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, "ok.txt"), "ok"); await writeFile(join(outside, "secret.txt"), "outside"); await symlink(outside, join(workspace, "escape"));
  const job = { workspace, readScope: { resourceRoot: peerWorkspaceRoot(workspace) } } as PeerJob;
  const call = (path: string) => ({ name: "read", arguments: { path } });
  assert.equal(await peerReadAllowed(job, call("ok.txt"), workspace), true);
  for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "escape/secret.txt"]) assert.equal(await peerReadAllowed(job, call(path), workspace), false);
  assert.equal(await peerReadAllowed(job, call("secret.txt"), outside), false);
  assert.equal(await peerReadAllowed({ ...job, workspace: outside }, call("ok.txt"), workspace), false);
  assert.equal(await peerReadAllowed({ ...job, readScope: undefined }, call("ok.txt"), workspace), false);
});

test("Windows containment rejects parent and cross-drive paths", () => {
  assert.equal(peerPathWithin("C:\\approved", "C:\\approved\\ok.txt", win32), true);
  assert.equal(peerPathWithin("C:\\approved", "C:\\outside\\secret.txt", win32), false);
  assert.equal(peerPathWithin("C:\\approved", "D:\\outside\\secret.txt", win32), false);
});
