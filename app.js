(() => {
  const STORAGE_KEY = "ctf_cap_api_base";

  // Optional: after deploying worker/, you can set DEFAULT_API_BASE to your workers.dev URL.
  const DEFAULT_API_BASE = "https://capcat.wrongaaa.gay";

  const form = document.getElementById("flag-form");
  const flagInput = document.getElementById("flag-input");
  const submitBtn = document.getElementById("submit-btn");
  const statusEl = document.getElementById("status");
  const widgetContainer = document.getElementById("widget-container");
  const configPanel = document.getElementById("config-panel");
  const apiInput = document.getElementById("api-input");
  const saveApiBtn = document.getElementById("save-api-btn");
  const connDot = document.getElementById("conn-dot");

  let capToken = null;
  let apiBase = resolveApiBase();

  function normalizeBase(url) {
    return (url || "").trim().replace(/\/+$/, "");
  }

  function resolveApiBase() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = normalizeBase(params.get("api"));
    if (fromQuery) {
      localStorage.setItem(STORAGE_KEY, fromQuery);
      return fromQuery;
    }

    const fromStorage = normalizeBase(localStorage.getItem(STORAGE_KEY));
    if (fromStorage) return fromStorage;

    if (DEFAULT_API_BASE) return normalizeBase(DEFAULT_API_BASE);

    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://127.0.0.1:8787";
    }
    return "";
  }

  function setStatus(kind, message) {
    if (!message) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.className = `status ${kind}`;
    statusEl.textContent = message;
  }

  function mountWidget() {
    capToken = null;
    submitBtn.disabled = true;
    widgetContainer.innerHTML = "";

    const widget = document.createElement("cap-widget");
    widget.id = "cap-widget";
    widget.setAttribute("required", "");

    if (apiBase) {
      // Cap requires a trailing slash on data-cap-api-endpoint.
      widget.setAttribute("data-cap-api-endpoint", `${apiBase}/cap/`);
    }

    widget.addEventListener("solve", (e) => {
      capToken = e.detail?.token || null;
      submitBtn.disabled = !capToken;
      if (capToken) {
        setStatus("", "");
      }
    });

    widget.addEventListener("reset", () => {
      capToken = null;
      submitBtn.disabled = true;
    });

    widget.addEventListener("error", (e) => {
      capToken = null;
      submitBtn.disabled = true;
      const msg = e.detail?.message || e.detail?.code || "验证失败，请重试";
      setStatus("err", `Cap 验证出错：${msg}`);
    });

    widgetContainer.appendChild(widget);
  }

  async function checkHealth() {
    if (!apiBase) {
      connDot.className = "dot offline";
      connDot.title = "未配置 Worker 地址";
      configPanel.open = true;
      setStatus(
        "info",
        "请先在下方填入已部署的 Cloudflare Worker 地址，或本地运行 wrangler dev。",
      );
      return;
    }

    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) {
        connDot.className = "dot online";
        connDot.title = `已连接 ${apiBase}`;
        setStatus("", "");
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch {
      connDot.className = "dot offline";
      connDot.title = `无法连接 ${apiBase}`;
      setStatus("info", `无法连接到后端 ${apiBase}，请检查 Worker 是否已启动。`);
    }
  }

  saveApiBtn.addEventListener("click", () => {
    apiBase = normalizeBase(apiInput.value);
    if (apiBase) {
      localStorage.setItem(STORAGE_KEY, apiBase);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    mountWidget();
    checkHealth();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const flag = flagInput.value.trim();

    if (!apiBase) {
      setStatus("err", "请先配置 Cloudflare Worker 后端地址。");
      configPanel.open = true;
      return;
    }
    if (!flag) {
      setStatus("err", "请输入 Flag。");
      flagInput.focus();
      return;
    }
    if (!capToken) {
      setStatus("err", "请先完成 Cap 人机验证。");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "校验中...";

    try {
      const res = await fetch(`${apiBase}/api/submit-flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flag,
          "cap-token": capToken,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus("err", data.error || `提交被拒绝 (HTTP ${res.status})`);
      } else if (data.correct) {
        setStatus("ok", data.message || "Flag 正确！");
        flagInput.value = "";
      } else {
        setStatus("err", data.message || "Flag 不正确，请重试。");
      }
    } catch {
      setStatus("err", "请求后端失败，请检查网络或 CORS 配置。");
    } finally {
      submitBtn.textContent = "提交 Flag";
      // Tokens are single-use; remount widget for the next submission.
      mountWidget();
    }
  });

  apiInput.value = apiBase;
  mountWidget();
  checkHealth();
})();
