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

module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    if (action === "locations") {
      return res.json([
        { id: "BUgWVdqLMd3RZYncJ0VV", name: "Sidvin Celeste" },
        { id: "NxLoq60TfQJ0yNAm3tK3", name: "Realtee" },
        { id: "byaCGrVxZtJJwdTAddVM", name: "Sidvin developers" },
      ]);
    }

    if (action === "config") {
      const { cfg } = await readConfig();
      return res.json(cfg);
    }

    if (action === "save" && req.method === "POST") {
      const { scope, id, settings } = req.body || {};
      if (!["subaccounts", "users"].includes(scope) || !id || !settings) {
        return res.status(400).json({ error: "Missing data" });
      }
      const { cfg, sha } = await readConfig();
      cfg[scope] = cfg[scope] || {};
      const cur = Object.assign({}, cfg[scope][id]);
      Object.keys(settings).forEach((k) => {
        if (isEmpty(settings[k])) delete cur[k];
        else cur[k] = settings[k];
      });
      if (Object.keys(cur).length) cfg[scope][id] = cur;
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

    res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
