const bridge = window.desktopConnection;
const query = new URLSearchParams(window.location.search);
document.querySelector("#title").textContent = query.get("title") || "正在连接 Dee";
document.querySelector("#message").textContent = query.get("message") || "正在使用已保存的连接，稍后进入你的工作空间。";
document.querySelector("#origin").textContent = query.get("origin") || "";
document.querySelector("#settings").addEventListener("click", () => bridge.openSettings());
document.querySelector("#retry").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在连接…";
  try { await bridge.retry(); }
  finally { button.disabled = false; button.textContent = "重新连接"; }
});
