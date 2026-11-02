const crypto = require("crypto");

const REPO = "vsravanthi-dev/ghl-customizer";
const FILE = "config.json";
const GHL = "https://services.leadconnectorhq.com";

// Used only when the GHL lookup is not set up or fails.
const FALLBACK_LOCATIONS = [
  { id: "BUgWVdqLMd3RZYncJ0VV", name: "Sidvin Celeste" },
  { id: "NxLoq60TfQJ0yNAm3tK3", name: "Realtee" },
  { id: "byaCGrVxZtJJwdTAddVM", name: "Sidvin developers" },
  { id: "Zi3agfEBlJBtgFbvGEOp", name: "Elpro360.ai" },
];

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

// ---------- password (only enforced when ADMIN_PASSWORD is set in Vercel) ----------
function authed(req) {
  const want = process.env.ADMIN_PASSWORD;
  if (!want) return true;
  const got = Buffer.from(String((req.headers && req.headers["x-admin-password"]) || ""));
  const exp = Buffer.from(want);
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// ---------- settings validation: only known keys, safe values ----------
const HEX = /^#[0-9a-f]{6}$/i;
const str = (v, max = 200) => typeof v === "string" && v.length <= max;
const strArr = (v) => Array.isArray(v) && v.length <= 300 && v.every((x) => str(x));
const strMap = (v) =>
  v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length <= 300 &&
  Object.entries(v).every(([k, x]) => str(k) && str(x));
const url = (v) => v === "" || (str(v, 600) && /^https?:\/\/[^\s"'<>]+$/i.test(v));
const color = (v) => v === "" || (typeof v === "string" && HEX.test(v));
const safeSel = (s) => str(s, 300) && !/[{};@\\]|url\(|expression/i.test(s);

const SCHEMA = {
  brandColor: color,
  textColor: color,
  activeTextColor: color,
  settingsLabelColor: color,
  settingsTitleColor: color,
  whiteIcons: (v) => typeof v === "boolean",
  logoUrl: url,
  agencyLogoUrl: url,
  menuNames: strMap,
  textReplace: strMap,
  hideMenus: strArr,
  showMenus: strArr,
  hideMenuTitles: strArr,
  hideHeadings: strArr,
  hideSelectors: (v) => strArr(v) && v.every(safeSel),
  moveMenus: (v) =>
    Array.isArray(v) && v.length <= 60 &&
    v.every((m) => m && typeof m === "object" && str(m.title) && str(m.before)),
};

function validate(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "Missing data";
  for (const k of Object.keys(settings)) {
    if (!SCHEMA[k]) return "Unknown setting: " + k;
    if (!SCHEMA[k](settings[k])) return "Invalid value for " + k;
  }
  return null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- GHL lookups (sub-accounts, users) with fallback ----------
const cache = {};
async function ghlList(path, key) {
  const token = process.env.GHL_TOKEN;
  const company = process.env.GHL_COMPANY_ID;
  if (!token || !company) throw new Error("GHL_TOKEN or GHL_COMPANY_ID is not set");
  const out = [];
  for (let skip = 0; skip < 2000; skip += 100) {
    const qs = new URLSearchParams({ companyId: company, limit: "100", skip: String(skip) });
    const r = await fetch(`${GHL}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`GHL ${path} failed (${r.status})`);
    const j = await r.json();
    const list = Array.isArray(j) ? j : j[key] || j.data || [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

async function cached(name, fn) {
  const c = cache[name];
  if (c && Date.now() - c.t < 60000) return c.v;
  const v = await fn();
  cache[name] = { t: Date.now(), v };
  return v;
}

async function getLocations() {
  try {
    const list = await cached("locations", async () => {
      const raw = await ghlList("/locations/search", "locations");
      return raw
        .map((l) => ({ id: l.id || l._id, name: l.name }))
        .filter((l) => l.id && l.name);
    });
    if (!list.length) throw new Error("GHL returned no sub-accounts");
    return { source: "ghl", list };
  } catch (e) {
    return { source: "fallback", list: FALLBACK_LOCATIONS, error: e.message };
  }
}

async function getUsers() {
  try {
    const list = await cached("users", async () => {
      const raw = await ghlList("/users/search", "users");
      return raw
        .map((u) => ({
          id: u.id || u._id,
          name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
        }))
        .filter((u) => u.id && u.name);
    });
    return { source: "ghl", list };
  } catch (e) {
    return { source: "fallback", list: [], error: e.message };
  }
}

// ---------- save (one commit, many targets) ----------
async function saveSettings(scope, ids, settings) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cfg, sha } = await readConfig();
    ids.forEach((id) => {
      let cur;
      if (scope === "default") cur = Object.assign({}, cfg.default);
      else {
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
    });
    const put = await gh(FILE, {
      method: "PUT",
      body: JSON.stringify({
        message: "Update " + scope + " " + (ids.length > 1 ? ids.length + " items" : ids[0]) + " (admin page)",
        content: Buffer.from(JSON.stringify(cfg, null, 2)).toString("base64"),
        sha,
        branch: "main",
      }),
    });
    if (put.ok) return;
    if (put.status !== 409 || attempt === 1) throw new Error("GitHub save failed (" + put.status + ")");
  }
}

module.exports = async (req, res) => {
  try {
    if (!authed(req)) return res.status(401).json({ error: "Wrong password" });
    const action = req.query.action;

    if (action === "locations") {
      const { list } = await getLocations();
      return res.json(list);
    }

    if (action === "users") {
      const { list } = await getUsers();
      return res.json(list);
    }

    if (action === "status") {
      const l = await getLocations();
      const u = await getUsers();
      return res.json({
        passwordSet: !!process.env.ADMIN_PASSWORD,
        locations: { source: l.source, count: l.list.length, error: l.error || null },
        users: { source: u.source, count: u.list.length, error: u.error || null },
      });
    }

    if (action === "config") {
      const { cfg } = await readConfig();
      return res.json(cfg);
    }

    if (action === "save" && req.method === "POST") {
      const { scope, id, ids, settings } = req.body || {};
      if (!["subaccounts", "users", "default"].includes(scope)) {
        return res.status(400).json({ error: "Missing data" });
      }
      let targets = Array.isArray(ids) ? ids : id ? [id] : [];
      if (scope === "default") targets = ["all"];
      targets = targets.filter((x, i) => targets.indexOf(x) === i);
      if (!targets.length || targets.length > 100 || !targets.every((x) => typeof x === "string" && ID.test(x))) {
        return res.status(400).json({ error: "Missing data" });
      }
      const bad = validate(settings);
      if (bad) return res.status(400).json({ error: bad });
      await saveSettings(scope, targets, settings);
      return res.json({ ok: true, saved: targets.length });
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
