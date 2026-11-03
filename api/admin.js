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

async function writeConfig(cfg, sha, message) {
  const put = await gh(FILE, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(cfg, null, 2)).toString("base64"),
      sha,
      branch: "main",
    }),
  });
  if (!put.ok) throw new Error("GitHub save failed (" + put.status + ")");
}

const isEmpty = (v) =>
  v === "" || v === false || v == null ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

// Used only if GHL_TOKEN / GHL_COMPANY_ID are not set, or the GHL call fails
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

// Returns { list, source: "ghl" | "fallback", error }
async function getLocations() {
  const token = process.env.GHL_TOKEN;
  const company = process.env.GHL_COMPANY_ID;
  if (!token || !company) return { list: FALLBACK, source: "fallback", error: "env not set" };
  const out = [];
  let error = "";
  try {
    for (let skip = 0; skip < 2000; skip += 100) {
      const r = await fetch(
        "https://services.leadconnectorhq.com/locations/search?companyId=" +
          encodeURIComponent(company) + "&limit=100&skip=" + skip,
        { headers: ghlHeaders() }
      );
      if (!r.ok) { error = "GHL " + r.status; break; }
      const j = await r.json();
      const list = j.locations || [];
      list.forEach((l) => out.push({ id: l.id, name: l.name }));
      if (list.length < 100) break;
    }
  } catch (e) { error = e.message; }
  return out.length
    ? { list: out, source: "ghl", error: "" }
    : { list: FALLBACK, source: "fallback", error: error || "no sub-accounts returned" };
}

const userName = (u) =>
  (u.name || ((u.firstName || "") + " " + (u.lastName || "")).trim() || u.email || "").trim();

// Returns { list, source: "ghl" | "none", error }
async function getUsers() {
  const token = process.env.GHL_TOKEN;
  const company = process.env.GHL_COMPANY_ID;
  if (!token) return { list: [], source: "none", error: "GHL_TOKEN not set" };
  const map = {};
  const add = (list) =>
    (list || []).forEach((u) => {
      if (u.id) map[u.id] = userName(u) || "User " + u.id;
    });
  let error = "";
  try {
    if (company) {
      for (let skip = 0; skip < 2000; skip += 100) {
        const r = await fetch(
          "https://services.leadconnectorhq.com/users/search?companyId=" +
            encodeURIComponent(company) + "&limit=100&skip=" + skip,
          { headers: ghlHeaders() }
        );
        if (!r.ok) { error = "users/search " + r.status; break; }
        const j = await r.json();
        const list = j.users || [];
        add(list);
        if (list.length < 100) break;
      }
    }
  } catch (e) { error = e.message; }
  // backup: ask each sub-account for its users
  if (!Object.keys(map).length) {
    try {
      const locs = (await getLocations()).list;
      for (const l of locs) {
        const r = await fetch(
          "https://services.leadconnectorhq.com/users/?locationId=" + encodeURIComponent(l.id),
          { headers: ghlHeaders() }
        );
        if (r.ok) add((await r.json()).users);
        else error = error || "users " + r.status;
      }
    } catch (e) { error = error || e.message; }
  }
  const list = Object.keys(map)
    .map((id) => ({ id, name: map[id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return list.length
    ? { list, source: "ghl", error: "" }
    : { list: [], source: "none", error: error || "no users returned" };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {

    const action = req.query.action;

    if (action === "locations") {
      return res.json((await getLocations()).list);
    }

    if (action === "users") {
      return res.json((await getUsers()).list);
    }

    if (action === "status") {
      const [l, u] = await Promise.all([getLocations(), getUsers()]);
      return res.json({
        passwordSet: !!process.env.ADMIN_PASSWORD,
        locations: { source: l.source, count: l.list.length, error: l.error },
        users: { source: u.source, count: u.list.length, error: u.error },
      });
    }

    if (action === "config") {
      const { cfg } = await readConfig();
      return res.json(cfg);
    }

    if (action === "save" && req.method === "POST") {
      const { scope, id, ids, settings } = req.body || {};
      const targets = Array.isArray(ids) && ids.length ? ids : id ? [id] : [];
      if (!["subaccounts", "users", "default"].includes(scope) || !targets.length || !settings) {
        return res.status(400).json({ error: "Missing data" });
      }
      const { cfg, sha } = await readConfig();
      targets.forEach((tid) => {
        let cur;
        if (scope === "default") {
          cur = Object.assign({}, cfg.default);
        } else {
          cfg[scope] = cfg[scope] || {};
          cur = Object.assign({}, cfg[scope][tid]);
        }
        Object.keys(settings).forEach((k) => {
          if (isEmpty(settings[k])) delete cur[k];
          else cur[k] = settings[k];
        });
        if (scope === "default") cfg.default = cur;
        else if (Object.keys(cur).length) cfg[scope][tid] = cur;
        else delete cfg[scope][tid];
      });
      await writeConfig(cfg, sha, "Update " + scope + " " + targets.join(",") + " (admin page)");
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

      await writeConfig(cfg, sha, (mode === "hide" ? "Hide " : "Show ") + title + " for all (admin page)");
      return res.json({ ok: true });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
