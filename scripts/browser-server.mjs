import { chromium } from 'playwright';
import { createServer } from 'http';
import { URL } from 'url';

let browser = null;
const sessions = new Map();
const screencastClients = new Map();

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
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      currentUrl = page.url();
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
      everyNthFrame: 3,
    });
    cdpSession.on('Page.screencastFrame', (frame) => {
      cdpSession.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      const clients = screencastClients.get(sessionId);
      if (clients && clients.size > 0) {
        const data = JSON.stringify({ data: frame.data, url: currentUrl });
        for (const res of clients) {
          try { res.write(`data: ${data}\n\n`); } catch { /* client gone */ }
        }
      }
    });
  } catch (err) {
    process.stderr.write(`CDP screencast init failed: ${err.message}\n`);
  }

  const session = { context, page, cdpSession, currentUrl: () => currentUrl };
  sessions.set(sessionId, session);
  return sessionId;
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
      if (!sessions.has(sessionId)) { sendJson(res, { error: 'Session not found' }, 404); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':\n\n');

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
          const content = await page.evaluate(() =>
            document.body?.innerText?.slice(0, 8000) || ''
          );
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
          const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
          sendJson(res, { data: buffer.toString('base64'), format: 'jpeg' });
          break;
        }
        case 'content': {
          const text = await page.evaluate(() =>
            document.body?.innerText?.slice(0, 16000) || ''
          );
          const title = await page.title();
          sendJson(res, { content: text, title, url: page.url() });
          break;
        }
        case 'evaluate': {
          const result = await page.evaluate(body.javascript);
          sendJson(res, { result: typeof result === 'string' ? result : JSON.stringify(result) });
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
