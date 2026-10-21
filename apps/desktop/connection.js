const bridge = window.desktopConnection;
const form = document.querySelector("#form");
const status = document.querySelector("#status");
const url = document.querySelector("#url");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
bridge.load().then((value) => { if (value) { url.value = value.url || ""; username.value = value.username || ""; } });
form.addEventListener("submit", async (event) => {
  event.preventDefault(); status.textContent = "正在连接…";
  const result = await bridge.save({ url: url.value, username: username.value || undefined, password: password.value || undefined });
  status.textContent = result.ok ? "连接失败或服务离线，请检查地址后重试。" : result.error;
  if (result.ok) await bridge.retry();
});
document.querySelector("#retry").addEventListener("click", () => bridge.retry());
