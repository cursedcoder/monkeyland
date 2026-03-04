import { chromium } from 'playwright';
import { createServer } from 'http';
import { URL } from 'url';

let browser = null;
const sessions = new Map();
const screencastClients = new Map();
const lastFrames = new Map();

async function ensureBrowser() {
  if (!browser) {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (err) {
      if (err.message?.includes('Executable doesn\'t exist')) {
        throw new Error(
          'Chromium not installed. Run: npx playwright install chromium'
        );
      }
      throw err;
    }
    browser.on('disconnected', () => { browser = null; });
  }
  return browser;
}

async function createSession(sessionId) {
  const b = await ensureBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  let currentUrl = 'about:blank';
  let currentTitle = '';
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      currentUrl = page.url();
      page.title().then(t => { currentTitle = t; }).catch(() => {});
    }
  });

  let cdpSession = null;
  try {
    cdpSession = await context.newCDPSession(page);
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 50,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
    cdpSession.on('Page.screencastFrame', (frame) => {
      cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      const eventData = JSON.stringify({ data: frame.data, url: currentUrl, title: currentTitle });
      lastFrames.set(sessionId, eventData);
      const clients = screencastClients.get(sessionId);
      if (clients && clients.size > 0) {
        for (const res of clients) {
          try { res.write(`data: ${eventData}\n\n`); } catch { /* client gone */ }
        }
      }
    });
  } catch (err) {
    process.stderr.write(`CDP screencast init failed: ${err.message}\n`);
  }

  const session = { context, page, cdpSession, currentUrl: () => currentUrl, currentTitle: () => currentTitle };
  sessions.set(sessionId, session);
  return sessionId;
}

async function pushScreenshotFrame(sessionId, session) {
  const buffer = await session.page.screenshot({ type: 'jpeg', quality: 50 });
  const eventData = JSON.stringify({ data: buffer.toString('base64'), url: session.currentUrl(), title: session.currentTitle() });
  lastFrames.set(sessionId, eventData);
  const clients = screencastClients.get(sessionId);
  if (clients && clients.size > 0) {
    for (const r of clients) {
      try { r.write(`data: ${eventData}\n\n`); } catch { /* client gone */ }
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, obj, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (parts[0] === 'health') {
      sendJson(res, { ok: true, sessions: sessions.size });
      return;
    }

    if (req.method === 'POST' && parts[0] === 'session' && parts.length === 1) {
      const body = await readBody(req);
      const sessionId = body.session_id || `browser-${Date.now()}`;
      await createSession(sessionId);
      sendJson(res, { session_id: sessionId, ok: true });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'session' && parts[2] === 'screencast') {
      const sessionId = parts[1];

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n');

      // Send last known frame immediately so late-connecting clients see something
      const cached = lastFrames.get(sessionId);
      if (cached) {
        res.write(`data: ${cached}\n\n`);
      }

      if (!screencastClients.has(sessionId)) screencastClients.set(sessionId, new Set());
      screencastClients.get(sessionId).add(res);
      req.on('close', () => {
        const clients = screencastClients.get(sessionId);
        if (clients) clients.delete(res);
      });
      return;
    }

    if (parts[0] === 'session' && parts.length >= 3) {
      const sessionId = parts[1];
      const action = parts[2];
      const session = sessions.get(sessionId);
      if (!session) { sendJson(res, { error: 'Session not found' }, 404); return; }

      const body = req.method === 'POST' ? await readBody(req) : {};
      const { page } = session;

      switch (action) {
        case 'navigate': {
          await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const title = await page.title();
          let content = '';
          try {
            content = await page.evaluate(() =>
              document.body?.innerText?.slice(0, 8000) || ''
            );
          } catch (_) { /* context destroyed during nav — skip content */ }
          pushScreenshotFrame(sessionId, session).catch(() => {});
          sendJson(res, { title, url: page.url(), content });
          break;
        }
        case 'click': {
          await page.click(body.selector, { timeout: 5000 });
          await page.waitForTimeout(500);
          const title = await page.title();
          sendJson(res, { ok: true, title, url: page.url() });
          break;
        }
        case 'type': {
          await page.fill(body.selector, body.text || '', { timeout: 5000 });
          sendJson(res, { ok: true });
          break;
        }
        case 'screenshot': {
          const buffer = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 15000 });
          sendJson(res, { data: buffer.toString('base64'), format: 'jpeg' });
          break;
        }
        case 'content': {
          let text = '';
          try {
            text = await Promise.race([
              page.evaluate(() => document.body?.innerText?.slice(0, 16000) || ''),
              new Promise((_, reject) => setTimeout(() => reject(new Error('content extraction timed out')), 15000)),
            ]);
          } catch (contentErr) {
            const msg = contentErr?.message || '';
            if (msg.includes('context was destroyed') || msg.includes('navigation')) {
              await page.waitForLoadState('domcontentloaded').catch(() => {});
              try { text = await page.evaluate(() => document.body?.innerText?.slice(0, 16000) || ''); } catch (_) {}
            }
          }
          const title = await page.title();
          sendJson(res, { content: text, title, url: page.url() });
          break;
        }
        case 'mouse-event': {
          const { type: evType, x, y, button: btn } = body;
          const mouseBtn = btn === 2 ? 'right' : btn === 1 ? 'middle' : 'left';
          if (evType === 'click') {
            await page.mouse.click(x, y, { button: mouseBtn });
          } else if (evType === 'dblclick') {
            await page.mouse.dblclick(x, y, { button: mouseBtn });
          } else if (evType === 'mousedown') {
            await page.mouse.move(x, y);
            await page.mouse.down({ button: mouseBtn });
          } else if (evType === 'mouseup') {
            await page.mouse.up({ button: mouseBtn });
          } else if (evType === 'mousemove') {
            await page.mouse.move(x, y);
          } else if (evType === 'wheel') {
            await page.mouse.move(x, y);
            await page.mouse.wheel(body.deltaX || 0, body.deltaY || 0);
          }
          sendJson(res, { ok: true });
          break;
        }
        case 'key-event': {
          const { type: kType, key } = body;
          if (kType === 'keydown') {
            await page.keyboard.down(key);
          } else if (kType === 'keyup') {
            await page.keyboard.up(key);
          } else if (kType === 'keypress') {
            await page.keyboard.press(key);
          } else if (kType === 'type') {
            await page.keyboard.type(key);
          }
          sendJson(res, { ok: true });
          break;
        }
        case 'go-back': {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          pushScreenshotFrame(sessionId, session).catch(() => {});
          sendJson(res, { ok: true, url: page.url(), title: await page.title() });
          break;
        }
        case 'go-forward': {
          await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          pushScreenshotFrame(sessionId, session).catch(() => {});
          sendJson(res, { ok: true, url: page.url(), title: await page.title() });
          break;
        }
        case 'reload': {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          pushScreenshotFrame(sessionId, session).catch(() => {});
          sendJson(res, { ok: true, url: page.url(), title: await page.title() });
          break;
        }
        case 'info': {
          sendJson(res, { url: page.url(), title: await page.title() });
          break;
        }
        case 'set-viewport': {
          let width = Math.min(1920, Math.max(320, Number(body.width) || 1280));
          let height = Math.min(1080, Math.max(200, Number(body.height) || 720));
          await page.setViewportSize({ width, height });
          sendJson(res, { ok: true, width, height });
          break;
        }
        case 'evaluate': {
          let js = body.javascript;
          // Wrap bare `return` statements so page.evaluate doesn't choke:
          // Playwright evaluates expressions, not function bodies.
          if (/\breturn\b/.test(js)) {
            js = `(() => { ${js} })()`;
          }
          try {
            const result = await Promise.race([
              page.evaluate(js),
              new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timed out')), 30000)),
            ]);
            sendJson(res, { result: typeof result === 'string' ? result : JSON.stringify(result) });
          } catch (evalErr) {
            const msg = evalErr?.message || String(evalErr);
            if (msg.includes('context was destroyed') || msg.includes('navigation')) {
              // Page navigated during evaluate — retry once after a brief wait
              await page.waitForLoadState('domcontentloaded').catch(() => {});
              try {
                const retryResult = await page.evaluate(js);
                sendJson(res, { result: typeof retryResult === 'string' ? retryResult : JSON.stringify(retryResult) });
              } catch (retryErr) {
                sendJson(res, { error: `evaluate failed after retry: ${retryErr?.message || retryErr}` }, 500);
              }
            } else {
              sendJson(res, { error: `evaluate error: ${msg}` }, 500);
            }
          }
          break;
        }
        default:
          sendJson(res, { error: `Unknown action: ${action}` }, 400);
      }
      return;
    }

    if (req.method === 'DELETE' && parts[0] === 'session' && parts.length === 2) {
      const sessionId = parts[1];
      const session = sessions.get(sessionId);
      if (session) {
        await session.context.close();
        sessions.delete(sessionId);
        screencastClients.delete(sessionId);
      }
      sendJson(res, { ok: true });
      return;
    }

    sendJson(res, { error: 'Not found' }, 404);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    sendJson(res, { error: err.message || String(err) }, 500);
  }
}

const server = createServer(handleRequest);
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write(JSON.stringify({ port }) + '\n');
});

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
