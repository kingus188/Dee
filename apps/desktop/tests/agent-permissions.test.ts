import test from "node:test";
import assert from "node:assert/strict";
import { parsePermissionParameters, readAgentPermissions } from "../dist/agents/permissions.js";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("权限选项来自原生 CLI，Claude 只保留 SDK 可传递模式，不生成 Dee 模式", () => {
  assert.deepEqual(parsePermissionParameters("claude", '--permission-mode <mode>\n (choices: "acceptEdits", "auto",\n "bypassPermissions", "manual", "dontAsk", "plan")\n --next <x>'), [{ parameter: "permissionMode", values: ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"] }]);
  assert.deepEqual(parsePermissionParameters("codex", '-s, --sandbox <MODE>\n [possible values: read-only, workspace-write, danger-full-access]\n -a, --ask-for-approval <POLICY>\n Possible values:\n - on-request: Ask the model\n - never: Never ask\n --search'), [{ parameter: "sandbox", values: ["read-only", "workspace-write", "danger-full-access"] }, { parameter: "approvalPolicy", values: ["on-request", "never"] }]);
  assert.throws(() => parsePermissionParameters("codex", "unknown CLI"));
  assert.throws(() => parsePermissionParameters("claude", "--permission-mode unsupported"));
  assert.throws(() => parsePermissionParameters("claude", '--permission-mode <mode> (choices: "manual")'));
});

test("权限查询沿用原生 Agent 的同目录解释器，支持 Finder 的精简 PATH", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-permissions-"));
  try {
    await symlink(process.execPath, join(directory, "permission-test-node"));
    const executable = join(directory, "agent");
    await writeFile(executable, '#!/usr/bin/env permission-test-node\nconsole.log(\'--permission-mode <mode> (choices: "plan")\');\n', { mode: 0o700 });
    assert.deepEqual(await readAgentPermissions("claude", { executable, args: [] }, "/usr/bin:/bin", { PATH: "/usr/bin:/bin" }), [{ parameter: "permissionMode", values: ["plan"] }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
