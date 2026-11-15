import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { PeerArtifactUpload } from "@assistant/contracts";

/** Paths originate only in the native user picker, never from an Agent or renderer. */
async function readFileSelection(path: string, taskId: string, deviceId: string): Promise<PeerArtifactUpload> {
  if (await realpath(path) !== resolve(path)) throw new Error("Select a regular file, not a symbolic link");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 1024 * 1024) throw new Error("Select a regular file up to 1 MiB");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("File changed while reading; select it again");
    const data = bytes.subarray(0, size);
    return { id: randomUUID(), taskId, deviceId, name: basename(path), mimeType: "application/octet-stream", size, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") };
  } finally { await handle.close(); }
}

export async function readSelectedArtifact(path: string, taskId: string, deviceId: string): Promise<PeerArtifactUpload> {
  try { return await readFileSelection(path, taskId, deviceId); }
  catch { throw new Error("Unable to share selected file. Select a readable regular file up to 1 MiB that is not a symbolic link and is no longer being edited."); }
}
