#!/usr/bin/env node
/**
 * Job Scanner — scans 3 sections for creative director / brand / social roles.
 * Sends email digest via macOS Mail.app to jack@craitve.co
 *
 * Sections:
 *   1. Startups / AI (Remote)
 *   2. Crypto (Remote) — includes top 1000 project career pages from cache
 *   3. Advertising Agency (Sydney)
 *
 * Email is ordered: APAC jobs first, then US/Other within each category.
 *
 * Run: node scan.mjs
 */

import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execSync } from "child_process";
import * as cheerio from "cheerio";
import * as fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = join(__dirname, "seen-jobs.json");
const RESULTS_PATH = join(__dirname, "latest-results.json");
const CACHE_PATH = join(__dirname, "career-cache.json");

const EMAIL_TO = "jack@craitve.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── Title keywords ──
const TITLE_PATTERNS = [
  /creative\s*director/i,
  /head\s+of\s+(brand|social|creative|marketing|content|design|comms|communications)/i,
  /brand\s*(director|lead|manager|head)/i,
  /creative\s*(lead|head|manager)/i,
  /social\s*(media\s*)?(director|lead|head|manager)/i,
  /content\s*(director|lead|head)/i,
  /marketing\s*(director|lead|head)/i,
  /vp\s*(of\s*)?(brand|creative|marketing|social)/i,
  /chief\s*(brand|creative|marketing)\s*officer/i,
  /director\s+of\s+(brand|creative|social|marketing|content|design)/i,
];

function titleMatches(title) {
  if (!title) return false;
  return TITLE_PATTERNS.some(p => p.test(title));
}

// ── APAC detection ──
const APAC_KEYWORDS = [
  "apac", "asia", "pacific", "australia", "sydney", "melbourne", "brisbane",
  "singapore", "tokyo", "japan", "korea", "seoul", "hong kong", "taipei",
  "india", "mumbai", "bangalore", "new zealand", "auckland", "southeast asia",
  "philippines", "vietnam", "thailand", "bangkok", "indonesia", "jakarta",
  "china", "shanghai", "beijing", "shenzhen", "oceania",
];

function isAPAC(location) {
  if (!location) return false;
  const loc = location.toLowerCase();
  return APAC_KEYWORDS.some(k => loc.includes(k));
}

// ── Date filtering ──
const CUTOFF_DAYS = 14;
const CUTOFF_MS = CUTOFF_DAYS * 24 * 60 * 60 * 1000;

/** Return true if the given Date is within the last CUTOFF_DAYS days. */
function isWithinCutoff(date) {
  if (!date || isNaN(date.getTime())) return false;
  return (Date.now() - date.getTime()) <= CUTOFF_MS;
}

/**
 * Parse web3.career relative time strings like "8d", "2mo", "1y", "3h", "5w".
 * Returns estimated number of days, or Infinity if unparseable.
 */
function parseRelativeAge(text) {
  if (!text) return Infinity;
  const t = text.trim().toLowerCase();
  const m = t.match(/^(\d+)\s*(h|d|w|mo|y)/);
  if (!m) return Infinity;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "h": return n / 24;
    case "d": return n;
    case "w": return n * 7;
    case "mo": return n * 30;
    case "y": return n * 365;
    default: return Infinity;
  }
}

// ── Helpers ──
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url, timeout = 15000) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function fetchJSON(url, timeout = 15000) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(timeout),
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf-8")); }
  catch { return fallback; }
}

// ══════════════════════════════════════════════════
//  SOURCE SCANNERS
// ══════════════════════════════════════════════════

// ── LinkedIn (Guest API — returns HTML fragments) ──
async function scanLinkedIn(keywords, location, isRemote = true) {
  console.log(`  LinkedIn: "${keywords}" [${location || "remote"}]...`);
  const jobs = [];

  const params = new URLSearchParams({
    keywords,
    start: "0",
    f_TPR: "r604800", // past week
  });

  if (location && !isRemote) {
    params.set("location", location);
  } else {
    params.set("f_WT", "2"); // remote
  }

  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
  const html = await fetchText(url);
  if (!html) return jobs;

  const $ = cheerio.load(html);
  $("li").each((_, el) => {
    const title = $(el).find("h3.base-search-card__title").text().trim();
    const company = $(el).find("h4.base-search-card__subtitle a").text().trim();
    const loc = $(el).find("span.job-search-card__location").text().trim();
    const link = $(el).find("a.base-card__full-link").attr("href")?.split("?")[0];

    if (title && company && link && titleMatches(title)) {
      jobs.push({ title, company, location: loc || (isRemote ? "Remote" : location), link, source: "LinkedIn" });
    }
  });

  return jobs;
}

// ── web3.career (SSR HTML table) ──
async function scanWeb3Career() {
  console.log("  web3.career...");
  const jobs = [];
  const slugs = [
    "creative-director", "head-of-brand", "head-of-social",
    "brand-director", "creative-lead", "head-of-marketing",
    "head-of-content", "head-of-creative",
  ];

  for (const slug of slugs) {
    const html = await fetchText(`https://web3.career/${slug}-jobs`);
    if (!html) { await sleep(1000); continue; }

    const $ = cheerio.load(html);
    $("tr.table_row").each((_, el) => {
      const $el = $(el);
      const $link = $el.find("td:first-child a[href]").first();
      const href = $link.attr("href");
      if (!href) return;

      const title = $el.find("h2").text().trim();
      const company = $el.find("h3").text().trim();
      const loc = $el.find("td span").text().trim() || "Remote";

      // Parse relative age from the table cells (e.g. "8d", "2mo")
      const cells = $el.find("td");
      let ageDays = Infinity;
      cells.each((_, td) => {
        const txt = $(td).text().trim();
        if (/^\d+\s*(h|d|w|mo|y)$/.test(txt)) {
          ageDays = parseRelativeAge(txt);
        }
      });

      if (ageDays > CUTOFF_DAYS) return; // skip jobs older than 14 days

      if (title && titleMatches(title)) {
        jobs.push({
          title, company: company || "Unknown",
          location: loc,
          link: href.startsWith("http") ? href : `https://web3.career${href}`,
          source: "web3.career",
        });
      }
    });
    await sleep(1000);
  }
  return jobs;
}

// ── cryptocurrencyjobs.co (SSR HTML) ──
async function scanCryptoJobs() {
  console.log("  cryptocurrencyjobs.co...");
  const jobs = [];
  // Check marketing category and design category
  for (const cat of ["marketing", "design"]) {
    const html = await fetchText(`https://cryptocurrencyjobs.co/${cat}/`);
    if (!html) { await sleep(1000); continue; }

    const $ = cheerio.load(html);
    $("li.grid").each((_, el) => {
      const $el = $(el);
      const $titleLink = $el.find("h2 a").first();
      const href = $titleLink.attr("href");
      if (!href) return;

      const title = $titleLink.text().trim();
      const company = $el.find("h3").text().trim();
      const loc = $el.find("h4 a").first().text().trim() || "Remote";

      // Check for date via <time> element or relative text like "2d ago", "1w ago"
      const timeEl = $el.find("time").attr("datetime");
      const relText = $el.find("time").text().trim() || $el.text();
      let withinCutoff = true; // default: include if no date info found

      if (timeEl) {
        withinCutoff = isWithinCutoff(new Date(timeEl));
      } else {
        // Look for relative age patterns in the listing text
        const ageMatch = relText.match(/(\d+)\s*(h|d|w|mo|month|y)\w*\s*ago/i);
        if (ageMatch) {
          const ageDays = parseRelativeAge(`${ageMatch[1]}${ageMatch[2]}`);
          withinCutoff = ageDays <= CUTOFF_DAYS;
        }
      }

      if (!withinCutoff) return; // skip jobs older than 14 days

      if (title && titleMatches(title)) {
        jobs.push({
          title, company: company || "Unknown",
          location: loc,
          link: href.startsWith("http") ? href : `https://cryptocurrencyjobs.co${href}`,
          source: "cryptocurrencyjobs.co",
        });
      }
    });
    await sleep(1000);
  }
  return jobs;
}

// ── remote3.co (via RSS feed — site is client-rendered SPA) ──
async function scanRemote3() {
  console.log("  remote3.co...");
  const jobs = [];
  const xml = await fetchText("https://remote3.co/api/rss");
  if (!xml) return jobs;

  const $ = cheerio.load(xml, { xmlMode: true });
  $("item").each((_, el) => {
    const $el = $(el);
    const title = $el.find("title").text().trim();
    const link = $el.find("link").text().trim();
    // Company is usually in the description or dc:creator
    const desc = $el.find("description").text().trim();
    const creator = $el.find("dc\\:creator, creator").text().trim();
    const company = creator || desc.split(/\s*[-–|]\s*/)[0] || "";

    // Filter by pubDate — skip items older than 14 days
    const pubDate = $el.find("pubDate").text().trim();
    if (pubDate && !isWithinCutoff(new Date(pubDate))) return;

    if (title && titleMatches(title)) {
      jobs.push({
        title, company: company || "Unknown",
        location: "Remote",
        link: link || "https://remote3.co",
        source: "remote3.co",
      });
    }
  });
  return jobs;
}

// ── Y Combinator (Work at a Startup) ──
async function scanYCombinator() {
  console.log("  workatastartup.com (YC)...");
  const jobs = [];

  // Try the HTML listing pages
  for (const q of ["creative%20director", "head%20of%20brand", "brand%20director", "head%20of%20marketing"]) {
    const html = await fetchText(`https://www.workatastartup.com/jobs?query=${q}&remote=true`);
    if (!html) { await sleep(1500); continue; }

    const $ = cheerio.load(html);

    // Look for job cards
    $("a[href*='/jobs/']").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href");
      if (!href || !href.match(/\/jobs\/\d+/)) return;

      const title = $el.find("[class*='title'], h3, h4").text().trim() || $el.text().trim().split("\n")[0].trim();
      const company = $el.find("[class*='company']").text().trim();

      if (title && titleMatches(title)) {
        jobs.push({
          title, company: company || "YC Startup",
          location: "Remote",
          link: `https://www.workatastartup.com${href}`,
          source: "YC (Work at a Startup)",
        });
      }
    });

    // Also try JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data?.itemListElement) {
          for (const item of data.itemListElement) {
            // Filter by datePosted if available — skip jobs older than 14 days
            if (item?.datePosted && !isWithinCutoff(new Date(item.datePosted))) continue;
            if (item?.name && titleMatches(item.name)) {
              jobs.push({
                title: item.name, company: item.hiringOrganization?.name || "YC Startup",
                location: item.jobLocation?.address?.addressLocality || "Remote",
                link: item.url || "https://www.workatastartup.com",
                source: "YC (Work at a Startup)",
              });
            }
          }
        }
      } catch {}
    });

    await sleep(1500);
  }
  return jobs;
}

// ── BuiltIn (SSR + JSON-LD) ──
async function scanBuiltIn() {
  console.log("  builtin.com...");
  const jobs = [];

  for (const path of [
    "/jobs/design/creative-director",
    "/jobs/marketing/marketing-director",
  ]) {
    // posted=14 limits to last 14 days on BuiltIn
    const html = await fetchText(`https://builtin.com${path}?posted=14`);
    if (!html) { await sleep(1000); continue; }

    const $ = cheerio.load(html);

    // Try JSON-LD first
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = data?.itemListElement || data?.about?.itemListElement || [];
        for (const item of items) {
          const name = item?.item?.name || item?.name;
          const url = item?.item?.url || item?.url;
          // Filter by datePosted if available — skip jobs older than 14 days
          const posted = item?.item?.datePosted || item?.datePosted;
          if (posted && !isWithinCutoff(new Date(posted))) continue;
          if (name && titleMatches(name)) {
            jobs.push({
              title: name, company: "See listing",
              location: "Remote",
              link: url?.startsWith("http") ? url : `https://builtin.com${url}`,
              source: "BuiltIn",
            });
          }
        }
      } catch {}
    });

    // Fallback: HTML job cards
    $("a[href*='/job/']").each((_, el) => {
      const $el = $(el);
      const title = $el.find("[class*='title'], h2").text().trim();
      const company = $el.find("[class*='company']").text().trim();
      const href = $el.attr("href");

      if (title && titleMatches(title)) {
        jobs.push({
          title, company: company || "See listing",
          location: "Remote",
          link: href?.startsWith("http") ? href : `https://builtin.com${href}`,
          source: "BuiltIn",
        });
      }
    });

    await sleep(1000);
  }
  return jobs;
}

// ── Seek.com.au — skipped (returns 403), using LinkedIn Sydney instead ──

// ── Career Cache (Greenhouse, Lever, Ashby, Workable, generic) ──
async function scanCareerCache() {
  const cache = await loadJSON(CACHE_PATH, null);
  if (!cache?.projects?.length) {
    console.log("  No career cache found — run: node build-career-cache.mjs");
    return [];
  }
  console.log(`  Career cache: ${cache.projects.length} crypto projects...`);
  const jobs = [];
  const BATCH = 15;

  for (let i = 0; i < cache.projects.length; i += BATCH) {
    const batch = cache.projects.slice(i, i + BATCH);
    if (i % 100 === 0 && i > 0) console.log(`    ${i}/${cache.projects.length}...`);

    const batchJobs = await Promise.all(batch.map(async (proj) => {
      const found = [];
      try {
        if (proj.atsType === "greenhouse" && proj.atsId) {
          const data = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${proj.atsId}/jobs`);
          if (data?.jobs) {
            for (const job of data.jobs) {
              // Filter by updated_at — skip jobs older than 14 days
              if (job.updated_at && !isWithinCutoff(new Date(job.updated_at))) continue;
              if (titleMatches(job.title)) {
                found.push({
                  title: job.title, company: proj.name,
                  location: job.location?.name || "Remote",
                  link: job.absolute_url || `https://boards.greenhouse.io/${proj.atsId}/jobs/${job.id}`,
                  source: `${proj.name} (Greenhouse)`,
                });
              }
            }
          }
        } else if (proj.atsType === "lever" && proj.atsId) {
          const data = await fetchJSON(`https://api.lever.co/v0/postings/${proj.atsId}?mode=json`);
          if (Array.isArray(data)) {
            for (const job of data) {
              // Filter by createdAt (epoch ms) — skip jobs older than 14 days
              if (job.createdAt && !isWithinCutoff(new Date(job.createdAt))) continue;
              if (titleMatches(job.text)) {
                found.push({
                  title: job.text, company: proj.name,
                  location: job.categories?.location || "Remote",
                  link: job.hostedUrl || job.applyUrl,
                  source: `${proj.name} (Lever)`,
                });
              }
            }
          }
        } else if ((proj.atsType === "ashby" || proj.atsType === "workable") && proj.atsId) {
          const url = proj.atsType === "ashby"
            ? `https://jobs.ashbyhq.com/${proj.atsId}`
            : `https://apply.workable.com/${proj.atsId}/`;
          const html = await fetchText(url);
          if (html) {
            const $ = cheerio.load(html);
            $("a[href*='/j/'], a[href]").each((_, el) => {
              const text = $(el).text().trim();
              const href = $(el).attr("href");
              if (text && titleMatches(text)) {
                found.push({
                  title: text, company: proj.name,
                  location: "Remote",
                  link: href?.startsWith("http") ? href : new URL(href, url).href,
                  source: `${proj.name} (${proj.atsType})`,
                });
              }
            });
          }
        } else if (proj.careerUrl) {
          const html = await fetchText(proj.careerUrl);
          if (html) {
            const $ = cheerio.load(html);
            $("a").each((_, el) => {
              const text = $(el).text().trim();
              const href = $(el).attr("href");
              if (text && text.length > 8 && text.length < 100 && titleMatches(text)) {
                found.push({
                  title: text, company: proj.name,
                  location: "Remote",
                  link: href?.startsWith("http") ? href : new URL(href, proj.careerUrl).href,
                  source: `${proj.name} (Career Page)`,
                });
              }
            });
          }
        }
      } catch {}
      return found;
    }));

    jobs.push(...batchJobs.flat());
    await sleep(500);
  }

  console.log(`    Found ${jobs.length} matching from career cache`);
  return jobs;
}

// ══════════════════════════════════════════════════
//  DEDUP
// ══════════════════════════════════════════════════
function dedup(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const key = `${j.title.toLowerCase().trim()}|${j.company.toLowerCase().trim()}`;
    if (!seen.has(key)) seen.set(key, j);
  }
  return [...seen.values()];
}

// ══════════════════════════════════════════════════
//  EMAIL
// ══════════════════════════════════════════════════
function formatSection(title, jobs) {
  if (!jobs.length) return `\n${"=".repeat(50)}\n  ${title}\n${"=".repeat(50)}\n\n  No new jobs found.\n`;

  const apac = jobs.filter(j => isAPAC(j.location));
  const other = jobs.filter(j => !isAPAC(j.location));

  let text = `\n${"=".repeat(50)}\n  ${title}\n${"=".repeat(50)}\n`;

  if (apac.length) {
    text += `\n  APAC (${apac.length})\n  ${"-".repeat(40)}\n`;
    for (const j of apac) {
      text += `\n  > ${j.title}\n    ${j.company} | ${j.location}\n    ${j.link}\n    Source: ${j.source}\n`;
    }
  }

  if (other.length) {
    text += `\n  US / Other (${other.length})\n  ${"-".repeat(40)}\n`;
    for (const j of other) {
      text += `\n  > ${j.title}\n    ${j.company} | ${j.location}\n    ${j.link}\n    Source: ${j.source}\n`;
    }
  }

  return text;
}

function sendEmail(subject, body) {
  console.log("Sending email via Mail.app...");

  // Write body to temp file to avoid escaping issues
  const tmpFile = join(__dirname, ".tmp-email-body.txt");
  fs.writeFileSync(tmpFile, body, "utf-8");

  const escapedSubject = subject.replace(/"/g, '\\"');
  const script = `
set bodyText to read POSIX file "${tmpFile}" as «class utf8»
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"${escapedSubject}", content:bodyText, visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"${EMAIL_TO}"}
  end tell
  send newMessage
end tell
  `.trim();

  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 30000 });
    console.log(`  Email sent to ${EMAIL_TO}`);
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}
    return true;
  } catch (e) {
    console.error("  Failed to send email:", e.message);
    const fallbackPath = join(__dirname, "latest-email.txt");
    fs.writeFileSync(fallbackPath, `Subject: ${subject}\n\n${body}`);
    console.log(`  Saved email to ${fallbackPath}`);
    try { fs.unlinkSync(tmpFile); } catch {}
    return false;
  }
}

// ══════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════
async function main() {
  console.log(`Job Scanner — ${new Date().toISOString()}\n`);
  const seen = await loadJSON(SEEN_PATH, {});

  // ── Section 1: Startups / AI (Remote) ──
  console.log("Section 1: Startups / AI");
  const aiJobs = dedup([
    ...await scanYCombinator(),
    ...await scanBuiltIn(),
    ...await scanLinkedIn("creative director AI startup", null, true),
    ...await scanLinkedIn("head of brand AI", null, true),
    ...await scanLinkedIn("head of social startup", null, true),
    ...await scanLinkedIn("creative director startup", null, true),
  ]);

  // ── Section 2: Crypto (Remote) ──
  console.log("\nSection 2: Crypto");
  const cryptoJobs = dedup([
    ...await scanWeb3Career(),
    ...await scanCryptoJobs(),
    ...await scanRemote3(),
    ...await scanCareerCache(),
    ...await scanLinkedIn("creative director crypto web3", null, true),
    ...await scanLinkedIn("head of brand crypto blockchain", null, true),
    ...await scanLinkedIn("head of marketing web3 crypto", null, true),
    ...await scanLinkedIn("head of social crypto", null, true),
  ]);

  // ── Section 3: Advertising Agency (Sydney) ──
  console.log("\nSection 3: Advertising Agency (Sydney)");
  const adJobs = dedup([
    // LinkedIn Sydney — not remote, targeting ad agencies
    ...await scanLinkedIn("creative director advertising agency", "Sydney, Australia", false),
    ...await scanLinkedIn("head of brand advertising agency", "Sydney, Australia", false),
    ...await scanLinkedIn("head of social advertising agency", "Sydney, Australia", false),
    ...await scanLinkedIn("creative director agency", "Sydney, Australia", false),
    ...await scanLinkedIn("brand director agency", "Sydney, Australia", false),
  ]);

  // ── Filter new ──
  const filterNew = (jobs) => jobs.filter(j => {
    const key = `${j.title.toLowerCase().trim()}|${j.company.toLowerCase().trim()}`;
    return !seen[key];
  });

  const newAI = filterNew(aiJobs);
  const newCrypto = filterNew(cryptoJobs);
  const newAd = filterNew(adJobs);
  const totalNew = newAI.length + newCrypto.length + newAd.length;

  console.log(`\nResults: AI=${newAI.length}, Crypto=${newCrypto.length}, Ad=${newAd.length} (total new: ${totalNew})`);

  // ── Mark seen ──
  for (const j of [...aiJobs, ...cryptoJobs, ...adJobs]) {
    const key = `${j.title.toLowerCase().trim()}|${j.company.toLowerCase().trim()}`;
    if (!seen[key]) seen[key] = { first: new Date().toISOString(), link: j.link };
  }
  await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2));
  await writeFile(RESULTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ai: newAI, crypto: newCrypto, advertising: newAd }, null, 2));

  // ── Email ──
  const date = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  let emailBody = `Job Scanner Report - ${date}\n`;
  emailBody += `Found ${totalNew} new job${totalNew !== 1 ? "s" : ""}\n`;
  emailBody += formatSection("STARTUPS / AI (Remote)", newAI);
  emailBody += formatSection("CRYPTO (Remote)", newCrypto);
  emailBody += formatSection("ADVERTISING AGENCY (Sydney)", newAd);
  emailBody += `\n${"=".repeat(50)}\nTotal jobs tracked: ${Object.keys(seen).length}\nNext scan in 2 days.\n`;

  const subject = totalNew > 0
    ? `${totalNew} New Creative/Brand Jobs - ${date}`
    : `Job Scan Complete - No New Matches - ${date}`;

  sendEmail(subject, emailBody);
  console.log("\nDone.");
}

main().catch(console.error);
