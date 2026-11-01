// Rewrites the dynamic sections of README.md between <!-- NAME:START --> / <!-- NAME:END --> markers.
// Runs in GitHub Actions (see .github/workflows/update-readme.yml); also works locally with GITHUB_TOKEN set.
import { readFileSync, writeFileSync } from "node:fs";

const USER = process.env.GH_USER || "Logappradeep-M";
const README = process.env.README_PATH || "README.md";
const FEATURED_LIMIT = 6;
const RECENT_LIMIT = 5;
const GISTS_LIMIT = 6;
const ACTIVITY_LIMIT = 6;
// Repos that should never show up in the featured table.
const EXCLUDE = new Set([USER]);
// Private repos are listed by name (with 🔒, no link) when a token owned by USER is available.
const SHOW_PRIVATE = process.env.SHOW_PRIVATE !== "false";
// Keep a private repo's description off the README by adding its name here.
const HIDE_PRIVATE_DESCRIPTION = new Set([]);

const headers = { Accept: "application/vnd.github+json", "User-Agent": USER };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
// Needs a personal token (repo scope) belonging to USER; the workflow's GITHUB_TOKEN can't see other repos.
const privateToken = process.env.PRIVATE_REPOS_TOKEN;

// The workflow's GITHUB_TOKEN is scoped to this repo and gets 403 on endpoints like /users/:user/gists,
// so on 401/403 retry with the personal token, then anonymously (public data, 60 req/h is plenty).
async function gh(path, token) {
  const tokens = token ? [token] : [process.env.GITHUB_TOKEN, privateToken, null];
  let last;
  for (const t of [...new Set(tokens)]) {
    if (t === undefined) continue;
    const h = { ...headers };
    if (t) h.Authorization = `Bearer ${t}`;
    else delete h.Authorization;
    const res = await fetch(`https://api.github.com${path}`, { headers: h });
    if (res.ok) return res.json();
    last = new Error(`${path} -> ${res.status} ${await res.text()}`);
    if (token || (res.status !== 401 && res.status !== 403)) break;
  }
  throw last;
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const prettyName = (n) => n.replace(/[-_]/g, " ");

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  for (const [u, n] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    const v = Math.floor(s / n);
    if (v >= 1) return `${v} ${u}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

const repoName = (r, label = r.name) => (r.private ? `🔒 **${label}**` : `[**${label}**](${r.html_url})`);
const repoDescription = (r) => (r.private && HIDE_PRIVATE_DESCRIPTION.has(r.name) ? "_Private project_" : esc(r.description) || "—");

function featured(repos) {
  const own = repos
    .filter((r) => !r.fork && !r.archived && !EXCLUDE.has(r.name))
    .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, FEATURED_LIMIT);
  const rows = own.map((r) => {
    const base = `https://img.shields.io/github`;
    const repo = `${USER}/${r.name}`;
    // shields.io can't read private repos, so those get a static badge instead.
    const stats = r.private
      ? "![private](https://img.shields.io/badge/Private-555?style=flat-square&logo=github)"
      : `![stars](${base}/stars/${repo}?style=flat-square&label=%E2%AD%90&color=36BCF7) ![forks](${base}/forks/${repo}?style=flat-square&label=%F0%9F%8D%B4&color=2c5364)`;
    return `| ${repoName(r, prettyName(r.name))} | ${repoDescription(r)} | ${r.language ? `\`${r.language}\`` : "—"} | ${stats} | ${ago(r.pushed_at)} |`;
  });
  const visible = repos.filter((r) => !EXCLUDE.has(r.name));
  const priv = visible.filter((r) => r.private).length;
  const summary = `<p align="center"><sub>🌐 ${visible.length - priv} public${priv ? ` · 🔒 ${priv} private` : ""} repositories</sub></p>\n`;
  return [summary, "| Project | Description | Language | Stats | Last update |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function recent(repos) {
  return repos
    .filter((r) => !EXCLUDE.has(r.name))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, RECENT_LIMIT)
    .map((r) => `- ${repoName(r)}${r.fork ? " 🍴" : ""}${r.language ? ` · \`${r.language}\`` : ""} — updated ${ago(r.pushed_at)}`)
    .join("\n");
}

function gists(list) {
  if (!list.length) return "_No public gists yet._";
  return list
    .slice(0, GISTS_LIMIT)
    .map((g) => `- [${esc(g.description) || Object.keys(g.files)[0]}](${g.html_url}) · ${day(g.created_at)}`)
    .join("\n");
}

function describe(e) {
  const repo = `[${e.repo.name}](https://github.com/${e.repo.name})`;
  const p = e.payload || {};
  switch (e.type) {
    case "PushEvent": {
      const n = p.size ?? p.commits?.length ?? 1;
      return `⬆️ Pushed ${n} commit${n === 1 ? "" : "s"} to ${repo}`;
    }
    case "CreateEvent": return p.ref_type === "repository" ? `🆕 Created repository ${repo}` : `🌱 Created ${p.ref_type} \`${p.ref}\` in ${repo}`;
    case "WatchEvent": return `⭐ Starred ${repo}`;
    case "ForkEvent": return `🍴 Forked ${repo}`;
    case "PullRequestEvent": return `🔀 ${p.action === "closed" && p.pull_request?.merged ? "Merged" : cap(p.action)} PR [#${p.number}](${p.pull_request?.html_url}) in ${repo}`;
    case "IssuesEvent": return `❗ ${cap(p.action)} issue [#${p.issue?.number}](${p.issue?.html_url}) in ${repo}`;
    case "IssueCommentEvent": return `💬 Commented on [#${p.issue?.number}](${p.comment?.html_url}) in ${repo}`;
    case "ReleaseEvent": return `🚀 Released [${p.release?.tag_name}](${p.release?.html_url}) in ${repo}`;
    case "PublicEvent": return `🔓 Made ${repo} public`;
    default: return null;
  }
}
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);

function activity(events) {
  const lines = [];
  for (const e of events) {
    const text = describe(e);
    if (!text) continue;
    lines.push(`${lines.length + 1}. ${text} · <sub>${ago(e.created_at)}</sub>`);
    if (lines.length === ACTIVITY_LIMIT) break;
  }
  return lines.length ? lines.join("\n") : "_No recent public activity._";
}

function inject(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(text)) throw new Error(`Marker ${name} not found in ${README}`);
  return text.replace(re, `$1\n${body}\n$2`);
}

async function loadRepos() {
  if (SHOW_PRIVATE && privateToken) {
    // /user/repos lists the token owner's repos, so make sure that owner is USER
    // before trusting it — otherwise another account's private repos would be published.
    const me = await gh("/user", privateToken).catch(() => null);
    if (me?.login?.toLowerCase() === USER.toLowerCase()) {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await gh(`/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}`, privateToken);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      console.log(`Including private repos (${all.filter((r) => r.private).length} found)`);
      return all;
    }
    console.warn(`PRIVATE_REPOS_TOKEN belongs to ${me?.login ?? "nobody (invalid token)"}, not ${USER}; showing public repos only`);
  }
  return gh(`/users/${USER}/repos?per_page=100&type=owner`);
}

// A failed fetch leaves that section as it was instead of failing the whole run.
const settle = (p, what) => p.catch((err) => (console.warn(`Skipping ${what}: ${err.message}`), null));
const [repos, gistList, events] = await Promise.all([
  settle(loadRepos(), "repositories"),
  settle(gh(`/users/${USER}/gists?per_page=${GISTS_LIMIT}`), "gists"),
  settle(gh(`/users/${USER}/events/public?per_page=50`), "activity"),
]);
if (!repos && !gistList && !events) throw new Error("Every GitHub API call failed; README left unchanged");

let readme = readFileSync(README, "utf8");
if (repos) {
  readme = inject(readme, "FEATURED", featured(repos));
  readme = inject(readme, "RECENT", recent(repos));
}
if (gistList) readme = inject(readme, "GISTS", gists(gistList));
if (events) readme = inject(readme, "ACTIVITY", activity(events));
readme = inject(readme, "UPDATED", `<p align="center"><sub>🔄 Auto-updated ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST</sub></p>`);
writeFileSync(README, readme);
console.log("README updated");
