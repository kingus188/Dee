export async function boundedBytes(response: Response, limit: number) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Teams 附件读取失败（HTTP ${response.status}）`); }
  const tooLarge = () => new Error(`Teams 附件超过 ${limit / 1024 / 1024}MB 大小上限`);
  if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw tooLarge(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(chunk.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  return Buffer.concat(chunks);
}
