// Loads the real extension into Chrome for Testing, serves a fake claude.ai
// (network is intercepted, nothing reaches the real site), and screenshots it.
// Run: node chrome-smoke.js
const { chromium } = require('playwright-core');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { IDS, conversation } = require('./fixtures');

const EXT = path.resolve(__dirname, '../extension');
const OUT = path.resolve(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const CONV = '11111111-2222-4333-8444-555555555555';

const fakePage = (mode) => `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>Claude</title>
<style>
 body{margin:0;font:15px/1.6 system-ui;background:${mode === 'dark' ? '#262624' : '#faf9f5'};color:${mode === 'dark' ? '#eee' : '#222'}}
 header{height:52px;display:flex;align-items:center;padding:0 16px;border-bottom:1px solid #8884}
 main{max-width:720px;margin:0 auto;padding:20px}
 [data-testid=user-message]{background:#8882;border-radius:12px;padding:6px 14px;margin:18px 0 4px auto;width:fit-content;max-width:80%}
 .actions{display:flex;gap:4px;align-items:center;font-size:12px;opacity:.7}
 .actions button{background:none;border:1px solid #8886;border-radius:5px;color:inherit;cursor:pointer}
 /* tailwind-ish classes used by the injected toolbar button */
 .h-8{height:2rem}.w-8{width:2rem}.inline-flex{display:inline-flex}.items-center{align-items:center}.justify-center{justify-content:center}
 .flex{display:flex}.flex-1{flex:1}.border-transparent{border-color:transparent}.border{border-width:1px}.rounded-md{border-radius:.375rem}
</style></head><body><div id="root"></div>
<script>
const conv = ${JSON.stringify(conversation())};
const ROOT='00000000-0000-4000-8000-000000000000';
const msgs=new Map(conv.chat_messages.map(m=>[m.uuid,m])); const kids=new Map();
for(const m of conv.chat_messages){(kids.get(m.parent_message_uuid)||kids.set(m.parent_message_uuid,[]).get(m.parent_message_uuid)).push(m.uuid)}
for(const l of kids.values()) l.sort((a,b)=>Date.parse(msgs.get(a).created_at)-Date.parse(msgs.get(b).created_at));
const choice=new Map();
function shown(){const o=[];let p=ROOT;while(kids.has(p)){const l=kids.get(p);p=l[choice.has(p)?choice.get(p):l.length-1];o.push(p)}return o}
function render(){let h='<header><div class="relative flex-1 flex items-center shrink min-w-0"><div class="flex flex-row items-center min-w-0"><b>Trip planning</b></div></div></header><main>';
 for(const u of shown()){const m=msgs.get(u),s=kids.get(m.parent_message_uuid),i=s.indexOf(u),t=m.content[0].text.replace(/\\*\\*/g,'');
  h+='<div class="turn">'+(m.sender==='human'?'<div data-testid="user-message"><p>'+t+'</p></div>':'<div data-is-streaming="false"><div class="standard-markdown"><p>'+t+'</p></div></div>');
  h+='<div class="actions">'+(s.length>1?'<button class="prev" data-p="'+m.parent_message_uuid+'"'+(i?'':' disabled')+'>‹</button><span>'+(i+1)+' / '+s.length+'</span><button class="next" data-p="'+m.parent_message_uuid+'"'+(i<s.length-1?'':' disabled')+'>›</button>':'')+'</div></div>'}
 document.getElementById('root').innerHTML=h+'</main>'}
document.addEventListener('click',e=>{const b=e.target.closest('button.prev,button.next');if(!b||b.disabled)return;const l=kids.get(b.dataset.p);const c=choice.has(b.dataset.p)?choice.get(b.dataset.p):l.length-1;choice.set(b.dataset.p,c+(b.classList.contains('next')?1:-1));setTimeout(render,60)});
render();
window.__shown=()=>shown();
</script></body></html>`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbt-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
  });
  const apiCalls = [];
  let mode = 'dark';
  await ctx.route('https://claude.ai/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/')) {
      apiCalls.push(url);
      if (url.includes('/chat_conversations/')) return route.fulfill({ json: conversation() });
      if (url.endsWith('/api/organizations')) return route.fulfill({ json: [{ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', capabilities: ['chat'] }] });
      return route.fulfill({ status: 404, body: '{}' });
    }
    return route.fulfill({ contentType: 'text/html', body: fakePage(mode) });
  });

  // service worker = extension loaded?
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('extension service worker:', sw.url());

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`https://claude.ai/chat/${CONV}`);
  await page.waitForSelector('#cbt-toolbar-btn', { timeout: 8000 });
  console.log('page hook active:', await page.evaluate(() => document.documentElement.getAttribute('data-cbt-hook')));
  await page.click('#cbt-toolbar-btn');
  await page.waitForSelector('#cbt-host .row', { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '1-dark-open.png') });

  // switch to another branch by clicking its row (playwright CSS pierces open shadow roots)
  await page.click(`#cbt-host .row[data-uuid="${IDS.H3a}"]`);
  await page.waitForTimeout(3500);
  const shown = await page.evaluate(() => window.__shown());
  const name = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));
  console.log('page now shows:', shown.map((u) => name[u]).join(' → '));
  await page.screenshot({ path: path.join(OUT, '2-dark-switched.png') });

  // full mode + search
  await page.click('#cbt-host [data-mode="full"]');
  await page.fill('#cbt-host input[type="search"]', 'japan');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '3-dark-full-search.png') });

  // light theme + diagnostics
  mode = 'light';
  await page.goto(`https://claude.ai/chat/${CONV}`);
  await page.waitForSelector('#cbt-toolbar-btn', { timeout: 8000 });
  await page.keyboard.press('Alt+B'); // extension command
  await page.waitForTimeout(800);
  const openViaShortcut = await page.evaluate(() => document.querySelector('#cbt-host').shadowRoot.querySelector('.panel').classList.contains('open'));
  console.log('Alt+B opened panel:', openViaShortcut);
  if (!openViaShortcut) await page.click('#cbt-toolbar-btn');
  await page.waitForSelector('#cbt-host .row', { timeout: 8000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('#cbt-host').shadowRoot.querySelector('[data-act="intro-ok"]')?.click());
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '4-light.png') });
  await page.click('#cbt-host [data-act="menu"]');
  await page.click('#cbt-host [data-act="diag"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '5-light-diagnostics.png') });

  // options page renders
  const opt = await ctx.newPage();
  await opt.goto(sw.url().replace('src/background.js', 'options/options.html'));
  await opt.waitForTimeout(500);
  await opt.screenshot({ path: path.join(OUT, '6-options.png'), fullPage: true });

  console.log('API calls:', apiCalls.length, '| page errors:', errors.length ? errors : 'none');
  await ctx.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
