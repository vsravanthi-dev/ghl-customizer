const REPO = "vsravanthi-dev/ghl-customizer";
const FILE = "config.json";

const gh = (path, opt = {}) =>
  fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...opt,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghl-customizer-admin",
    },
  });

async function readConfig() {
  const r = await gh(FILE + "?ref=main");
  if (!r.ok) throw new Error("GitHub read failed (" + r.status + ")");
  const j = await r.json();
  return {
    cfg: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")),
    sha: j.sha,
  };
}

const isEmpty = (v) =>
  v === "" || v === false || v == null ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

// Used only if GHL_TOKEN / GHL_COMPANY_ID are not set, or GHL call fails
const FALLBACK = [
  { id: "BUgWVdqLMd3RZYncJ0VV", name: "Sidvin Celeste" },
  { id: "NxLoq60TfQJ0yNAm3tK3", name: "Realtee" },
  { id: "byaCGrVxZtJJwdTAddVM", name: "Sidvin developers" },
  { id: "Zi3agfEBlJBtgFbvGEOp", name: "Elpro360.ai" },
];

const ghlHeaders = () => ({
  Authorization: "Bearer " + process.env.GHL_TOKEN,
  Version: "2021-07-28",
  Accept: "application/json",
});

async function getLocations() {
  const token = process.env.GHL_TOKEN;
  const company = process.env.GHL_COMPANY_ID;
  if (!token || !company) return FALLBACK;
  const out = [];
  try {
    for (let skip = 0; skip < 2000; skip += 100) {
      const r = await fetch(
        "https://services.leadconnectorhq.com/locations/search?companyId=" +
          encodeURIComponent(company) + "&limit=100&skip=" + skip,
        { headers: ghlHeaders() }
      );
      if (!r.ok) return out.length ? out : FALLBACK;
      const j = await r.json();
      const list = j.locations || [];
      list.forEach((l) => out.push({ id: l.id, name: l.name }));
      if (list.length < 100) break;
    }
  } catch (e) {
    return out.length ? out : FALLBACK;
  }
  return out.length ? out : FALLBACK;
}

const userName = (u) =>
  (u.name || ((u.firstName || "") + " " + (u.lastName || "")).trim() || u.email || "").trim();

// Real users from GHL: agency-level search first, then each sub-account as a backup
async function getUsers() {
  const token = process.env.GHL_TOKEN;
  const company = process.env.GHL_COMPANY_ID;
  if (!token) return { users: [], note: "GHL_TOKEN not set" };
  const map = {};
  const add = (list) =>
    (list || []).forEach((u) => {
      if (u.id) map[u.id] = userName(u) || "User " + u.id;
    });
  let note = "";
  try {
    if (company) {
      for (let skip = 0; skip < 2000; skip += 100) {
        const r = await fetch(
          "https://services.leadconnectorhq.com/users/search?companyId=" +
            encodeURIComponent(company) + "&limit=100&skip=" + skip,
          { headers: ghlHeaders() }
        );
        if (!r.ok) { note = "users/search " + r.status; break; }
        const j = await r.json();
        const list = j.users || [];
        add(list);
        if (list.length < 100) break;
      }
    }
  } catch (e) { note = e.message; }
  if (!Object.keys(map).length) {
    try {
      const locs = await getLocations();
      for (const l of locs) {
        const r = await fetch(
          "https://services.leadconnectorhq.com/users/?locationId=" + encodeURIComponent(l.id),
          { headers: ghlHeaders() }
        );
        if (r.ok) add((await r.json()).users);
      }
    } catch (e) { note = note || e.message; }
  }
  const users = Object.keys(map)
    .map((id) => ({ id, name: map[id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { users, note: users.length ? "" : note || "No users returned" };
}

module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    if (action === "locations") {
      return res.json(await getLocations());
    }

    if (action === "users") {
      return res.json(await getUsers());
    }

    if (action === "config") {
      const { cfg } = await readConfig();
      return res.json(cfg);
    }

    if (action === "save" && req.method === "POST") {
      const { scope, id, settings } = req.body || {};
      if (!["subaccounts", "users", "default"].includes(scope) || !id || !settings) {
        return res.status(400).json({ error: "Missing data" });
      }
      const { cfg, sha } = await readConfig();
      let cur;
      if (scope === "default") {
        cur = Object.assign({}, cfg.default);
      } else {
        cfg[scope] = cfg[scope] || {};
        cur = Object.assign({}, cfg[scope][id]);
      }
      Object.keys(settings).forEach((k) => {
        if (isEmpty(settings[k])) delete cur[k];
        else cur[k] = settings[k];
      });
      if (scope === "default") cfg.default = cur;
      else if (Object.keys(cur).length) cfg[scope][id] = cur;
      else delete cfg[scope][id];
      const put = await gh(FILE, {
        method: "PUT",
        body: JSON.stringify({
          message: "Update " + scope + " " + id + " (admin page)",
          content: Buffer.from(JSON.stringify(cfg, null, 2)).toString("base64"),
          sha,
          branch: "main",
        }),
      });
      if (!put.ok) return res.status(502).json({ error: "GitHub save failed (" + put.status + ")" });
      return res.json({ ok: true });
    }

    if (action === "bulk" && req.method === "POST") {
      const { id, title, byTitle, mode } = req.body || {};
      if (!id || !title || !["show", "hide"].includes(mode)) {
        return res.status(400).json({ error: "Missing data" });
      }
      const key = byTitle ? title : id;
      const hideField = byTitle ? "hideMenuTitles" : "hideMenus";
      const without = (arr) => (arr || []).filter((x) => x !== key);
      const { cfg, sha } = await readConfig();

      cfg.default = cfg.default || {};
      cfg.default[hideField] = without(cfg.default[hideField]);
      if (mode === "hide") cfg.default[hideField].push(key);
      cfg.default.showMenus = without(cfg.default.showMenus);
      ["hideMenus", "hideMenuTitles", "showMenus"].forEach((f) => {
        if (!cfg.default[f] || !cfg.default[f].length) delete cfg.default[f];
      });

      ["subaccounts", "users"].forEach((scope) => {
        Object.keys(cfg[scope] || {}).forEach((k) => {
          const o = cfg[scope][k];
          ["hideMenus", "hideMenuTitles", "showMenus"].forEach((f) => {
            if (Array.isArray(o[f])) {
              o[f] = o[f].filter((x) => x !== key);
              if (!o[f].length) delete o[f];
            }
          });
          if (!Object.keys(o).length) delete cfg[scope][k];
        });
      });

      const put = await gh(FILE, {
        method: "PUT",
        body: JSON.stringify({
          message: (mode === "hide" ? "Hide " : "Show ") + title + " for all (admin page)",
          content: Buffer.from(JSON.stringify(cfg, null, 2)).toString("base64"),
          sha,
          branch: "main",
        }),
      });
      if (!put.ok) return res.status(502).json({ error: "GitHub save failed (" + put.status + ")" });
      return res.json({ ok: true });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
