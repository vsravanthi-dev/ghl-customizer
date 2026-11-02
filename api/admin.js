const REPO = "vsravanthi-dev/ghl-customizer";
const FILE = "config.json";

const gh = (path, opt = {}) =>
  fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...opt,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghl-customizer-admin",
      ...(opt.headers || {}),
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

async function ghlGet(path) {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new Error("GHL_API_TOKEN is not configured");

  const r = await fetch(
    `https://services.leadconnectorhq.com${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Version: "v3",
      },
    }
  );

  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.message || "GHL API error (" + r.status + ")");
  }
  return data;
}

async function getAllLocations() {
  const companyId = process.env.GHL_COMPANY_ID;
  if (!companyId) throw new Error("GHL_COMPANY_ID is not configured");

  let results = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      companyId,
      skip: String(skip),
      limit: String(limit),
    });

    const data = await ghlGet(`/locations/search?${params}`);
    const items = data.locations || [];

    results.push(...items);
    if (items.length < limit) break;
    skip += limit;
  }

  return results.map((item) => ({
    id: item.id,
    name: item.name,
  }));
}

async function getAllUsers() {
  const companyId = process.env.GHL_COMPANY_ID;
  if (!companyId) throw new Error("GHL_COMPANY_ID is not configured");

  let results = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      companyId,
      skip: String(skip),
      limit: String(limit),
    });

    const data = await ghlGet(`/users/search?${params}`);
    const items = data.users || [];

    results.push(...items);
    if (items.length < limit) break;
    skip += limit;
  }

  return results.map((user) => ({
    id: user.id,
    name: user.name ||
      [user.firstName, user.lastName].filter(Boolean).join(" "),
    email: user.email || "",
  }));
}

module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    if (action === "locations") {
      const locations = await getAllLocations();
      return res.json(locations);
    }

    if (action === "users") {
      const users = await getAllUsers();
      return res.json(users);
    }

    if (action === "config") {
      const { cfg } = await readConfig();
      return res.json(cfg);
    }

    if (action === "save" && req.method === "POST") {
      const { scope, id, settings } = req.body || {};

      if (
        !["subaccounts", "users", "default"].includes(scope) ||
        !id ||
        !settings
      ) {
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

      if (scope === "default") {
        cfg.default = cur;
      } else if (Object.keys(cur).length) {
        cfg[scope][id] = cur;
      } else {
        delete cfg[scope][id];
      }

      const put = await gh(FILE, {
        method: "PUT",
        body: JSON.stringify({
          message: "Update " + scope + " " + id + " (admin page)",
          content: Buffer.from(
            JSON.stringify(cfg, null, 2)
          ).toString("base64"),
          sha,
          branch: "main",
        }),
      });

      if (!put.ok) {
        return res.status(502).json({
          error: "GitHub save failed (" + put.status + ")",
        });
      }

      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
