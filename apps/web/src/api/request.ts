export async function request<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let response;
    try { response = await res.json(); } catch { response = {}; }
    if (!res.ok) throw new Error(response.error || "HTTP " + res.status);
    return response as T;
  }
