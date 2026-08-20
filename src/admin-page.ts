/**
 * /admin 管理页：静态登录壳 + token 列表/新建/启停/删除。
 * 无外部 JS/CSS 依赖；本字符串不含任何密钥或数据，数据全部经 /admin/api/*（Bearer ADMIN_TOKEN）获取。
 */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Providers 管理后台</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; color: #1f2933; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; font-size: 14px; }
  button { margin: 2px 4px 2px 0; padding: 4px 10px; cursor: pointer; }
  input { padding: 4px 6px; }
  code { background: #f3f4f6; padding: 1px 4px; }
  .muted { color: #6b7280; font-size: 12px; }
  #token-result { background: #f3f4f6; padding: 8px; font-family: monospace; word-break: break-all; margin-top: 8px; }
</style>
</head>
<body>
<h2>Providers 管理后台</h2>
<div id="login">
  <p>输入管理密钥（ADMIN_TOKEN）：</p>
  <input type="password" id="admin-key" style="width: 320px">
  <button id="btn-login">登录</button>
</div>
<div id="main" hidden>
  <h3>Token 列表</h3>
  <table id="tokens"><thead><tr><th>ID</th><th>名称</th><th>掩码</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody></tbody></table>
  <h3>新建 Token</h3>
  <p>前缀：<input id="prefix" placeholder="如 sk_ 或 infility_agent_（可留空）" style="width: 280px"></p>
  <p>随机串：<input id="random" style="width: 380px"> <button id="btn-gen">生成</button></p>
  <p>名称：<input id="label" placeholder="用途备注" style="width: 280px"></p>
  <button id="btn-create">创建</button>
  <p class="muted">完整 token 仅创建后展示一次，请立即复制保存。随机串可手改（至少 8 位）；复用旧 token 时前缀留空、随机串贴完整旧值。</p>
  <div id="token-result" hidden></div>
</div>
<script>
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function hdr() {
  return { "authorization": "Bearer " + sessionStorage.getItem("admin_token"), "content-type": "application/json" };
}
function showLogin() {
  document.getElementById("login").hidden = false;
  document.getElementById("main").hidden = true;
}
function api(path, options) {
  return fetch(path, Object.assign({}, options, { headers: hdr() })).then(function (res) {
    if (res.status === 401) { sessionStorage.removeItem("admin_token"); showLogin(); throw new Error("unauthorized"); }
    return res;
  });
}
function render(data) {
  var tb = document.querySelector("#tokens tbody");
  tb.innerHTML = "";
  (data.tokens || []).forEach(function (t) {
    var tr = document.createElement("tr");
    tr.innerHTML = "<td>" + t.id + "</td><td>" + esc(t.label) + "</td><td><code>" + esc(t.token_mask) + "</code></td>" +
      "<td>" + (t.enabled ? "启用" : "禁用") + "</td><td>" + esc(t.created_at) + "</td>" +
      "<td><button data-act='toggle' data-id='" + t.id + "' data-next='" + (t.enabled ? 0 : 1) + "'>" + (t.enabled ? "禁用" : "启用") + "</button>" +
      "<button data-act='del' data-id='" + t.id + "'>删除</button></td>";
    tb.appendChild(tr);
  });
}
function load() {
  return api("/admin/api/tokens").then(function (res) {
    if (!res.ok) { showLogin(); return; }
    document.getElementById("login").hidden = true;
    document.getElementById("main").hidden = false;
    return res.json().then(render);
  }).catch(function () {});
}
document.getElementById("btn-login").addEventListener("click", function () {
  var v = document.getElementById("admin-key").value.trim();
  if (!v) return;
  sessionStorage.setItem("admin_token", v);
  load();
});
document.getElementById("btn-gen").addEventListener("click", function () {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  var out = "";
  for (var i = 0; i < bytes.length; i++) out += chars.charAt(bytes[i] % chars.length);
  document.getElementById("random").value = out;
});
document.getElementById("btn-create").addEventListener("click", function () {
  var body = {
    prefix: document.getElementById("prefix").value,
    random: document.getElementById("random").value,
    label: document.getElementById("label").value,
  };
  api("/admin/api/tokens", { method: "POST", body: JSON.stringify(body) }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) { alert((data.error && data.error.message) || "创建失败"); return; }
      var box = document.getElementById("token-result");
      box.hidden = false;
      box.textContent = "完整 token（仅此一次，请立即复制）：" + data.token;
      load();
    });
  }).catch(function () {});
});
document.getElementById("tokens").addEventListener("click", function (ev) {
  var btn = ev.target;
  if (!btn || btn.tagName !== "BUTTON") return;
  var id = btn.getAttribute("data-id");
  if (btn.getAttribute("data-act") === "toggle") {
    var next = btn.getAttribute("data-next") === "1";
    api("/admin/api/tokens/" + id, { method: "PATCH", body: JSON.stringify({ enabled: next }) })
      .then(load).catch(function () {});
  } else if (btn.getAttribute("data-act") === "del") {
    if (!confirm("确认删除该 token？")) return;
    api("/admin/api/tokens/" + id, { method: "DELETE" }).then(load).catch(function () {});
  }
});
load();
</script>
</body>
</html>
`;
