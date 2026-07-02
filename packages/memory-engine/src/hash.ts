export async function contentHash(parts: string[]) {
  const bytes = new TextEncoder().encode(parts.join("\u001f").toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

