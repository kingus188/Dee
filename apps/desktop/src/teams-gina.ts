import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Gina 的 token 由 digital-gina 自带的 gina_auth 提供，本进程不读取其密钥文件。
export function createGinaTokenProvider(ginaHome: string, env: NodeJS.ProcessEnv) {
  const code = "import sys; sys.path.insert(0, 'core/lib'); from gina_auth import gina_token; print(gina_token())";
  return async function getToken() {
    const { stdout } = await run(join(ginaHome, ".venv/bin/python"), ["-c", code], { cwd: ginaHome, env: { ...env, GINA_HOME: ginaHome }, timeout: 60_000 });
    return stdout.trim();
  };
}
