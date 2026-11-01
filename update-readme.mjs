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

const headers = { Accept: "application/vnd.github+json", "User-Agent": USER };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
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

function featured(repos) {
  const own = repos
    .filter((r) => !r.fork && !r.archived && !r.private && !EXCLUDE.has(r.name))
    .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, FEATURED_LIMIT);
  const rows = own.map((r) => {
    const base = `https://img.shields.io/github`;
    const repo = `${USER}/${r.name}`;
    return `| [**${prettyName(r.name)}**](${r.html_url}) | ${esc(r.description) || "—"} | ${r.language ? `\`${r.language}\`` : "—"} | ![stars](${base}/stars/${repo}?style=flat-square&label=%E2%AD%90&color=36BCF7) ![forks](${base}/forks/${repo}?style=flat-square&label=%F0%9F%8D%B4&color=2c5364) | ${ago(r.pushed_at)} |`;
  });
  return ["| Project | Description | Language | Stats | Last update |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function recent(repos) {
  return repos
    .filter((r) => !r.private && !EXCLUDE.has(r.name))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, RECENT_LIMIT)
    .map((r) => `- [**${r.name}**](${r.html_url})${r.fork ? " 🍴" : ""}${r.language ? ` · \`${r.language}\`` : ""} — updated ${ago(r.pushed_at)}`)
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

const [repos, gistList, events] = await Promise.all([
  gh(`/users/${USER}/repos?per_page=100&type=owner`),
  gh(`/users/${USER}/gists?per_page=${GISTS_LIMIT}`),
  gh(`/users/${USER}/events/public?per_page=50`),
]);

let readme = readFileSync(README, "utf8");
readme = inject(readme, "FEATURED", featured(repos));
readme = inject(readme, "RECENT", recent(repos));
readme = inject(readme, "GISTS", gists(gistList));
readme = inject(readme, "ACTIVITY", activity(events));
readme = inject(readme, "UPDATED", `<p align="center"><sub>🔄 Auto-updated ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST</sub></p>`);
writeFileSync(README, readme);
console.log("README updated");
