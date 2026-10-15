const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../backend/worker.mjs';

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
const env = {
 DB: { prepare(sql) {
  const stmt = db.prepare(sql); let args = [];
  const query = {
   bind(...values) { args = values; return query; },
   async first() { return stmt.get(...args) || null; },
   async all() { return { results: stmt.all(...args) }; },
   async run() { return stmt.run(...args); }
  }; return query;
 } },
 MODERATION_SECRET: 'local-browser-test-secret-with-more-than-32-characters',
 SITE_ORIGIN: 'https://homepage.example.test', PUBLIC_API_URL: 'https://community.example.test',
 RESEND_API_KEY: 'not-real', MODERATOR_EMAIL: 'owner@example.test', MAIL_FROM: 'test@example.test'
};
const emails = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
 assert.equal(url, 'https://api.resend.com/emails');
 emails.push(JSON.parse(options.body));
 return Response.json({ id: 'test-only' });
};
const browser = await chromium.launch({ executablePath: process.env.COMMUNITY_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
 const page = await browser.newPage();
 const postOrigins = [];
 await page.route('https://community.example.test/**', async route => {
  const incoming = route.request();
  const headers = await incoming.allHeaders();
  if (incoming.method() === 'POST') {
   postOrigins.push(headers.origin);
   assert.equal(headers.origin, 'https://community.example.test');
   assert.equal(headers.referer, 'https://community.example.test/');
  }
  const response = await worker.fetch(new Request(incoming.url(), {
   method: incoming.method(), headers,
   ...(incoming.postData() ? { body: incoming.postData() } : {})
  }), env);
  await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
 });
 await worker.fetch(new Request('https://community.example.test/api/comments', {
  method: 'POST', headers: { Origin: env.SITE_ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Browser test', message: 'Synthetic comment in memory only' })
 }), env);
 const reviewLink = emails.at(-1).text.match(/https:\/\/community\.example\.test\/moderate\?[^\s]+/)[0];
 await page.goto(reviewLink);
 await page.locator('button[value="approve"]').click();
 await page.locator('a[href="/admin"]').waitFor();
 assert.equal(db.prepare('SELECT status FROM comments WHERE id = 1').get().status, 'approved');
 await page.goto('https://community.example.test/admin');
 await page.locator('form[action="/admin/login"] button').click();
 await page.waitForURL('https://community.example.test/admin/login');
 const loginLink = emails.at(-1).text.match(/https:\/\/community\.example\.test\/admin\/confirm\?[^\s]+/)[0];
 await page.goto(loginLink);
 await page.locator('form[action="/admin/confirm"] button').click();
 await page.locator('form[action="/admin/logout"]').waitFor();
 await page.locator('a[href="/admin/delete?id=1"]').click();
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 1);
 await page.locator('button[value="delete"]').click();
 await page.locator('form[action="/admin/logout"]').waitFor();
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n, 0);
 await page.locator('form[action="/admin/logout"] button').click();
 await page.locator('form[action="/admin/login"]').waitFor();
 assert.equal(postOrigins.length, 5);
 console.log('PASS: actual browser forms approve a comment, email-login, delete after confirmation, and log out. Origins remain valid; referrers contain no private tokens. Only in-memory synthetic data was modified.');
} finally {
 await browser.close();
 globalThis.fetch = originalFetch;
 db.close();
}
