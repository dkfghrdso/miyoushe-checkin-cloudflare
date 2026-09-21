/* Miyoushe Check-in — theme customizer.
   Applies CSS variables + injects a top "配色" bar. Layout of the app is untouched. */
(function () {
  "use strict";
  var KEY = "miyo-theme";

  var TOKENS = [
    ["bg", "背景"],
    ["card", "卡片"],
    ["ink", "正文"],
    ["muted", "次要文字"],
    ["line", "描边"],
    ["primary", "主色"],
    ["good", "成功"],
    ["bad", "失败"],
    ["warn", "警告"],
  ];

  var PRESETS = {
    活力玫红: { bg: "#FFF1F2", card: "#FFFFFF", ink: "#1F2430", muted: "#6B7280", line: "#FECDD3", primary: "#E11D48", good: "#16A34A", bad: "#DC2626", warn: "#F59E0B" },
    元气橙: { bg: "#FFF7ED", card: "#FFFFFF", ink: "#1F2430", muted: "#6B7280", line: "#FED7AA", primary: "#F97316", good: "#16A34A", bad: "#DC2626", warn: "#D97706" },
    靛蓝紫: { bg: "#EEF2FF", card: "#FFFFFF", ink: "#1E1B4B", muted: "#6B7280", line: "#C7D2FE", primary: "#4F46E5", good: "#16A34A", bad: "#DC2626", warn: "#D97706" },
    薄荷绿: { bg: "#ECFDF5", card: "#FFFFFF", ink: "#064E3B", muted: "#64748B", line: "#A7F3D0", primary: "#059669", good: "#16A34A", bad: "#DC2626", warn: "#D97706" },
    缤纷紫: { bg: "#FAF5FF", card: "#FFFFFF", ink: "#3B0764", muted: "#6B7280", line: "#E9D5FF", primary: "#7C3AED", good: "#16A34A", bad: "#EF4444", warn: "#F59E0B" },
    暗夜: { bg: "#0B1220", card: "#111827", ink: "#E5E7EB", muted: "#94A3B8", line: "#273449", primary: "#2563EB", good: "#22C55E", bad: "#F87171", warn: "#FBBF24" },
  };
  var DEFAULT = "活力玫红";

  function relLum(hex) {
    var h = String(hex || "#000000").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16) / 255;
    var g = parseInt(h.slice(2, 4), 16) / 255;
    var b = parseInt(h.slice(4, 6), 16) / 255;
    function f(c) { return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function bestOn(hex) {
    var L = relLum(hex);
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#FFFFFF" : "#0B1220";
  }

  function apply(theme) {
    if (!theme) return;
    var root = document.documentElement.style;
    for (var i = 0; i < TOKENS.length; i++) {
      var k = TOKENS[i][0];
      if (theme[k]) root.setProperty("--" + k, theme[k]);
    }
    root.setProperty("--on-primary", bestOn(theme.primary || "#2563EB"));
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function save(theme) {
    try { localStorage.setItem(KEY, JSON.stringify(theme)); } catch (e) {}
  }

  var current = load() || Object.assign({}, PRESETS[DEFAULT]);
  apply(current);

  window.MiyoTheme = {
    TOKENS: TOKENS,
    PRESETS: PRESETS,
    apply: apply,
    save: save,
    get: function () { return Object.assign({}, current); },
    set: function (theme) { current = Object.assign({}, theme); apply(current); save(current); },
    reset: function () { current = Object.assign({}, PRESETS[DEFAULT]); apply(current); try { localStorage.removeItem(KEY); } catch (e) {} },
  };

  // Inject the top bar (only on pages that have <main>, i.e. not the login screen).
  function inject() {
    var main = document.querySelector("main");
    if (!main || document.querySelector(".theme-bar")) return;

    var style = document.createElement("style");
    style.textContent =
      ".theme-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:0 0 16px}" +
      ".theme-bar .tt{font-size:12px;font-weight:700;color:var(--muted);margin-right:2px}" +
      ".theme-bar .preset{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px}" +
      ".theme-bar .preset .dot{width:12px;height:12px;border-radius:50%;border:1px solid rgba(0,0,0,.15)}" +
      ".theme-bar .preset.active{border-color:var(--primary);color:var(--primary)}" +
      ".theme-bar .btn2{border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}" +
      ".theme-bar .btn2:hover{border-color:var(--primary);color:var(--primary)}" +
      ".theme-bar .btn2:focus-visible,.theme-bar .preset:focus-visible{outline:2px solid var(--primary);outline-offset:2px}" +
      ".theme-bar .toggle{margin-left:auto}" +
      ".theme-bar.collapsed .presets,.theme-bar.collapsed .custom,.theme-bar.collapsed .reset,.theme-bar.collapsed .theme-panel{display:none}" +
      ".theme-panel{flex-basis:100%;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px 14px;margin-top:6px;padding-top:10px;border-top:1px dashed var(--line)}" +
      ".theme-panel[hidden]{display:none}" +
      ".theme-panel label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;font-size:12px;font-weight:500;color:var(--ink)}" +
      ".theme-panel input[type=color]{width:34px;height:26px;min-height:0;padding:0;border:1px solid var(--line);border-radius:6px;background:none;cursor:pointer}";
    document.head.appendChild(style);

    var bar = document.createElement("div");
    bar.className = "theme-bar";
    bar.innerHTML = '<span class="tt">配色</span><span class="presets"></span>' +
      '<button type="button" class="btn2 custom">自定义颜色</button>' +
      '<button type="button" class="btn2 reset">默认</button>' +
      '<button type="button" class="btn2 toggle" aria-expanded="true">收起</button>' +
      '<div class="theme-panel" hidden></div>';
    var topline = main.querySelector(".topline");
    if (topline) main.insertBefore(bar, topline.nextSibling);
    else main.insertBefore(bar, main.firstChild);

    var presetWrap = bar.querySelector(".presets");
    Object.keys(PRESETS).forEach(function (name) {
      var p = PRESETS[name];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "preset";
      b.innerHTML = '<span class="dot" style="background:' + p.primary + '"></span>' + name;
      b.addEventListener("click", function () { window.MiyoTheme.set(p); mark(); });
      presetWrap.appendChild(b);
    });

    var panel = bar.querySelector(".theme-panel");
    var inputs = {};
    TOKENS.forEach(function (tok) {
      var id = tok[0], label = tok[1];
      var l = document.createElement("label");
      l.textContent = label;
      var inp = document.createElement("input");
      inp.type = "color";
      inp.value = current[id] || "#000000";
      inp.addEventListener("input", function () {
        var t = Object.assign({}, current);
        t[id] = inp.value;
        window.MiyoTheme.set(t);
      });
      inputs[id] = inp;
      l.appendChild(inp);
      panel.appendChild(l);
    });

    function syncInputs() {
      TOKENS.forEach(function (tok) { inputs[tok[0]].value = current[tok[0]] || "#000000"; });
    }
    function mark() {
      syncInputs();
      bar.querySelectorAll(".preset").forEach(function (el, i) {
        var name = Object.keys(PRESETS)[i];
        el.classList.toggle("active", JSON.stringify(PRESETS[name]) === JSON.stringify(current));
      });
    }

    bar.querySelector(".custom").addEventListener("click", function () {
      panel.hidden = !panel.hidden;
    });
    bar.querySelector(".reset").addEventListener("click", function () {
      window.MiyoTheme.reset();
      current = window.MiyoTheme.get();
      panel.hidden = true;
      mark();
    });

    var COLLAPSE_KEY = "miyo-theme-collapsed";
    var toggleBtn = bar.querySelector(".toggle");
    function setCollapsed(collapsed) {
      bar.classList.toggle("collapsed", collapsed);
      toggleBtn.textContent = collapsed ? "展开" : "收起";
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
      try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (e) {}
    }
    toggleBtn.addEventListener("click", function () {
      setCollapsed(!bar.classList.contains("collapsed"));
    });
    var savedCollapsed = null;
    try { savedCollapsed = localStorage.getItem(COLLAPSE_KEY); } catch (e) {}
    setCollapsed(savedCollapsed === "1");

    current = window.MiyoTheme.get();
    mark();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
