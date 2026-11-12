const bridge = window.desktopConnection;
const form = document.querySelector("#form");
const connectionStatus = document.querySelector("#status");
const url = document.querySelector("#url");
const lanUrl = document.querySelector("#lan-url");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
bridge.load().then((value) => { if (value) { url.value = value.url || ""; lanUrl.value = value.lanUrl || ""; username.value = value.username || ""; } });
form.addEventListener("submit", async (event) => {
  event.preventDefault(); connectionStatus.textContent = "正在连接…";
  const result = await bridge.save({ url: url.value, lanUrl: lanUrl.value.trim() || undefined, username: username.value || undefined, password: password.value || undefined, rememberPassword: document.querySelector("#remember-password").checked });
  connectionStatus.textContent = result.ok ? result.persistedPassword ? "已保存，正在连接…" : "口令仅用于本次连接…" : result.error;
  if (result.ok) await bridge.retry();
});
document.querySelector("#retry").addEventListener("click", () => bridge.retry());
