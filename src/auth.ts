async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

/** 恒时字符串比较：先各自 SHA-256 定长，再逐字节 XOR 累计，避免时序侧信道。 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) {
    diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  }
  return diff === 0;
}

export async function isAuthorized(request: Request, tokensCsv: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return false;
  const provided = match[1].trim();
  if (provided.length === 0) return false;

  const tokens = tokensCsv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const token of tokens) {
    if (await constantTimeEquals(provided, token)) return true;
  }
  return false;
}
