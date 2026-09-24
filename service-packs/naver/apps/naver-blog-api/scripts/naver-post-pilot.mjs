import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HeadlessAuth } from '../tools/discovery/headless-auth.mjs';
import { BLOG_ID } from './client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'evidence');
const commandPath = path.join(evidenceDir, 'naver-pilot-command.json');
const statePath = path.join(evidenceDir, 'naver-pilot-state.json');
const resultPath = path.join(evidenceDir, 'naver-pilot-result.json');
const editorUrl = `https://blog.naver.com/PostWriteForm.naver?blogId=${BLOG_ID}`;

await mkdir(evidenceDir, { recursive: true });
for (const target of [commandPath, statePath, resultPath]) {
  try { await unlink(target); } catch {}
}

function safeText(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function writeJson(target, value) {
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function inspectFrame(frame) {
  return frame.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    return {
      url: location.origin + location.pathname,
      title: document.title,
      inputs: [...document.querySelectorAll('input')].filter(visible).slice(0, 120).map(e => ({
        id: e.id, name: e.name, type: e.type, placeholder: e.placeholder,
        cls: typeof e.className === 'string' ? e.className.slice(0, 200) : '',
      })),
      textareas: [...document.querySelectorAll('textarea')].filter(visible).slice(0, 120).map(e => ({
        id: e.id, name: e.name, placeholder: e.placeholder,
        cls: typeof e.className === 'string' ? e.className.slice(0, 200) : '',
      })),
      editables: [...document.querySelectorAll('[contenteditable="true"]')].filter(visible).slice(0, 160).map(e => ({
        tag: e.tagName, id: e.id,
        cls: typeof e.className === 'string' ? e.className.slice(0, 220) : '',
        role: e.getAttribute('role'), aria: e.getAttribute('aria-label'),
        dataPlaceholder: e.getAttribute('data-placeholder'),
        text: (e.innerText || '').slice(0, 100),
      })),
      buttons: [...document.querySelectorAll('button,[role="button"],a')].filter(visible).slice(0, 300).map(e => ({
        tag: e.tagName, id: e.id,
        cls: typeof e.className === 'string' ? e.className.slice(0, 220) : '',
        text: (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        aria: e.getAttribute('aria-label'),
      })),
    };
  });
}

async function snapshot(page) {
  const frames = [];
  for (const frame of page.frames()) {
    try {
      const data = await inspectFrame(frame);
      frames.push({ name: frame.name(), ...data });
    } catch {}
  }
  return {
    checkedAt: new Date().toISOString(),
    page: { url: page.url(), title: await page.title().catch(() => '') },
    frames,
    credentialValuesPersisted: false,
  };
}

async function firstVisible(locators) {
  for (const locator of locators) {
    try {
      if (await locator.count() && await locator.first().isVisible()) return locator.first();
    } catch {}
  }
  return null;
}

async function fillInFrame(frame, title, body) {
  const titleLocator = await firstVisible([
    frame.locator('textarea[placeholder*="제목"]'),
    frame.locator('input[placeholder*="제목"]'),
    frame.locator('[contenteditable="true"][data-placeholder*="제목"]'),
    frame.locator('[contenteditable="true"][aria-label*="제목"]'),
    frame.locator('.se-title-text[contenteditable="true"]'),
    frame.locator('[class*="title"] [contenteditable="true"]'),
  ]);

  let bodyLocator = await firstVisible([
    frame.locator('.se-main-container [contenteditable="true"]'),
    frame.locator('.se-component-content [contenteditable="true"]'),
    frame.locator('[contenteditable="true"][data-placeholder*="내용"]'),
    frame.locator('[contenteditable="true"][aria-label*="본문"]'),
    frame.locator('textarea[placeholder*="내용"]'),
  ]);

  if (!bodyLocator) {
    const editables = frame.locator('[contenteditable="true"]');
    const count = await editables.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = editables.nth(i);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (titleLocator && await candidate.evaluate((node, titleNode) => node === titleNode, await titleLocator.elementHandle()).catch(() => false)) continue;
      bodyLocator = candidate;
      break;
    }
  }

  if (!titleLocator || !bodyLocator) return null;

  const setValue = async (locator, value) => {
    const tag = await locator.evaluate(el => el.tagName);
    const editable = await locator.getAttribute('contenteditable');
    if (tag === 'INPUT' || tag === 'TEXTAREA') await locator.fill(value);
    else if (editable === 'true') {
      await locator.click();
      await locator.press('Control+A').catch(() => {});
      await locator.evaluate(el => { el.innerHTML = ''; });
      await locator.pressSequentially(value, { delay: 0 });
    } else throw new Error('unsupported_editor_target');
  };

  await setValue(titleLocator, title);
  await setValue(bodyLocator, body);
  return {
    frameUrl: frame.url(),
    titleTarget: safeText(await titleLocator.evaluate(el => `${el.tagName}#${el.id}.${typeof el.className === 'string' ? el.className : ''}`), 240),
    bodyTarget: safeText(await bodyLocator.evaluate(el => `${el.tagName}#${el.id}.${typeof el.className === 'string' ? el.className : ''}`), 240),
  };
}

async function fillDraft(page, title, body) {
  for (const frame of page.frames()) {
    const result = await fillInFrame(frame, title, body).catch(() => null);
    if (result) return result;
  }
  throw new Error('editor_targets_not_found');
}

async function publish(page) {
  const patterns = [/^발행$/, /^등록$/, /발행하기/];
  for (const frame of page.frames()) {
    for (const pattern of patterns) {
      const button = frame.getByRole('button', { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await page.waitForTimeout(1500);
        // Naver may show a second publish confirmation layer.
        for (const confirmPattern of patterns) {
          const confirm = frame.getByRole('button', { name: confirmPattern }).last();
          if (await confirm.isVisible().catch(() => false)) {
            await confirm.click().catch(() => {});
            break;
          }
        }
        await page.waitForTimeout(3500);
        return { clicked: true, pageUrl: page.url() };
      }
    }
  }
  throw new Error('publish_button_not_found');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const password = await new Promise(resolve => input.once('line', resolve));
input.close();

const auth = new HeadlessAuth({ headless: false });
try {
  const opened = await auth.open();
  await writeJson(statePath, { stage: 'login_page_open', classification: opened.classification, credentialValuesPersisted: false });
  let login = await auth.login({ username: BLOG_ID, password });
  if (['captcha_required', 'additional_verification_required', 'account_protection'].includes(login.classification)) {
    await writeJson(statePath, {
      stage: 'manual_verification_required',
      classification: login.classification,
      page: login.page,
      instruction: 'Complete the visible Naver verification in the temporary browser. The process will continue automatically.',
      credentialValuesPersisted: false,
    });
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await auth.page.waitForTimeout(1000);
      const current = await auth.status().catch(() => null);
      if (!current) continue;
      if (current.classification === 'session_issued_unverified') {
        login = current;
        auth.cookies = await auth.context.cookies(['https://admin.blog.naver.com', 'https://blog.naver.com', 'https://blog.stat.naver.com']);
        break;
      }
      if (current.classification === 'credentials_rejected') {
        login = current;
        break;
      }
    }
  }

  if (login.classification !== 'session_issued_unverified') {
    await writeJson(statePath, {
      stage: 'login_stopped',
      classification: login.classification,
      page: login.page,
      credentialValuesPersisted: false,
    });
    process.exitCode = 2;
  } else {
    await auth.page.goto(editorUrl, { waitUntil: 'domcontentloaded' });
    await auth.page.waitForTimeout(4500);
    await writeJson(statePath, {
      stage: 'editor_ready',
      editor: await snapshot(auth.page),
      credentialValuesPersisted: false,
    });

    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      if (!existsSync(commandPath)) {
        await new Promise(resolve => setTimeout(resolve, 750));
        continue;
      }
      let command;
      try { command = JSON.parse(await readFile(commandPath, 'utf8')); } catch {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      await unlink(commandPath).catch(() => {});
      if (command.action === 'inspect') {
        await writeJson(resultPath, { ok: true, action: 'inspect', editor: await snapshot(auth.page) });
      } else if (command.action === 'fill') {
        try {
          const targets = await fillDraft(auth.page, String(command.title || ''), String(command.body || ''));
          await auth.page.waitForTimeout(1000);
          await writeJson(resultPath, { ok: true, action: 'fill', targets, editor: await snapshot(auth.page) });
        } catch (error) {
          await writeJson(resultPath, { ok: false, action: 'fill', error: String(error?.message || error).slice(0, 200), editor: await snapshot(auth.page) });
        }
      } else if (command.action === 'publish') {
        try {
          const result = await publish(auth.page);
          await writeJson(resultPath, { ok: true, action: 'publish', result, editor: await snapshot(auth.page) });
        } catch (error) {
          await writeJson(resultPath, { ok: false, action: 'publish', error: String(error?.message || error).slice(0, 200), editor: await snapshot(auth.page) });
        }
      } else if (command.action === 'close') {
        await writeJson(resultPath, { ok: true, action: 'close' });
        break;
      }
    }
  }
} catch (error) {
  await writeJson(statePath, {
    stage: 'failed',
    code: error?.code || error?.name || 'ERROR',
    message: String(error?.message || '').slice(0, 240),
    credentialValuesPersisted: false,
  }).catch(() => {});
  process.exitCode = 1;
} finally {
  await auth.close().catch(() => {});
}
