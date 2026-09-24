const SERVER = 'http://127.0.0.1:48766';
const BUILD_ID = 'layout-upgrade-publish-v8';
const EDITOR_URLS = [
  'https://blog.naver.com/PostWriteForm.naver*',
  'https://blog.naver.com/PostUpdateForm.naver*',
];

let running = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = (promise, timeout, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(label)), timeout)),
]);
const normalizeText = value => String(value || '')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function sanitizeError(error) {
  return String(error?.message || error || 'unknown_error')
    .replace(/https?:\/\/[^\s]+/g, '[url]')
    .slice(0, 240);
}

async function command(target, method, params = {}) {
  return withTimeout(
    chrome.debugger.sendCommand(target, method, params),
    20000,
    `debugger_command_timeout_${method}`,
  );
}

async function evaluate(target, expression) {
  const response = await command(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response?.exceptionDetails) throw new Error('runtime_evaluation_failed');
  return response?.result?.value;
}

function js(value) {
  return JSON.stringify(value);
}

async function focusSelector(target, selectors, mode = 'first') {
  const result = await evaluate(target, `(() => {
    const selectors = ${js(selectors)};
    const found = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
        found.push(element);
      }
    }
    const element = found.length ? found[${mode === 'last' ? 'found.length - 1' : '0'}] : null;
    if (!element) return null;
    element.scrollIntoView({block: 'center', inline: 'nearest'});
    element.click();
    element.focus();
    const rect = element.getBoundingClientRect();
    return {tag: element.tagName, cls: String(element.className || '').slice(0, 160), x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  })()`);
  if (!result) throw new Error('editor_target_not_found');
  return result;
}

async function key(target, key, code, windowsVirtualKeyCode, modifiers = 0) {
  await command(target, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers,
  });
  await command(target, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers,
  });
}

async function replaceFocusedText(target, text) {
  await key(target, 'a', 'KeyA', 65, 2);
  await key(target, 'Backspace', 'Backspace', 8, 0);
  await insertText(target, text);
}

async function pressEnter(target, count = 1) {
  for (let index = 0; index < count; index++) {
    await key(target, 'Enter', 'Enter', 13, 0);
    await sleep(50);
  }
}

async function toggleBold(target) {
  await key(target, 'b', 'KeyB', 66, 2);
  await sleep(60);
}

async function insertText(target, text) {
  if (!text) return;
  const inserted = await evaluate(target, `(() => {
    const text = ${js(text)};
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    return document.execCommand('insertText', false, text);
  })()`).catch(() => false);
  if (!inserted) await command(target, 'Input.insertText', {text});
}

async function focusLastTextTarget(target) {
  return focusSelector(target, [
    '.se-component.se-text .__se-node',
    '.se-component.se-text .se-text-paragraph',
    '.se-component.se-text',
  ], 'last');
}

async function ensureTrailingTextComponent(target) {
  const state = await evaluate(target, `(() => {
    const components = [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle)')];
    const last = components.at(-1);
    if (!last) return {ready: false, reason: 'no_components'};
    if (last.classList.contains('se-text')) {
      const node = last.querySelector('.__se-node, .se-text-paragraph, [contenteditable="true"]');
      const rect = (node || last).getBoundingClientRect();
      return {ready: true, rect: {x: rect.left, y: rect.top, width: rect.width, height: rect.height}};
    }
    const edge = last.querySelector('.se-component-edge-button-bottom, .se-component-edge-button[data-direction="bottom"], button[data-direction="bottom"]');
    if (edge) {
      edge.scrollIntoView({block: 'center'});
      const rect = edge.getBoundingClientRect();
      return {ready: false, clickEdge: true, rect: {x: rect.left, y: rect.top, width: rect.width, height: rect.height}, cls: last.className};
    }
    // Quotations and some legacy image components do not expose a bottom edge
    // button. Select the component near its lower edge and use native keyboard
    // navigation to ask SmartEditor to create the following text component.
    last.scrollIntoView({block: 'center'});
    const rect = last.getBoundingClientRect();
    return {
      ready: false,
      keyboardFallback: true,
      rect: {x: rect.left + 8, y: rect.bottom - Math.min(12, Math.max(2, rect.height / 4)), width: Math.max(2, rect.width - 16), height: 4},
      cls: last.className,
    };
  })()`);
  if (state?.ready && state?.rect) {
    await physicalClick(target, state.rect);
    return true;
  }
  if ((!state?.clickEdge && !state?.keyboardFallback) || !state?.rect) {
    throw new Error(`trailing_text_edge_missing_${String(state?.reason || state?.cls || 'unknown').replace(/\s+/g, '_')}`);
  }
  const before = Number(await evaluate(target, `document.querySelectorAll('.se-components-wrap > .se-component').length`)) || 0;
  await physicalClick(target, state.rect);
  if (state.keyboardFallback) {
    await key(target, 'ArrowDown', 'ArrowDown', 40, 0);
    await pressEnter(target, 2);
  }
  await waitFor(target, `(() => {
    const components = [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle)')];
    const last = components.at(-1);
    return components.length >= ${before} && Boolean(last?.classList.contains('se-text'));
  })()`, 10000, 300);
  await focusLastTextTarget(target);
  return true;
}

async function insertQuotationComponent(target, text) {
  await focusLastTextTarget(target);
  const before = Number(await evaluate(target, `document.querySelectorAll('.se-component.se-quotation').length`)) || 0;
  const clicked = await evaluate(target, `(() => {
    const button = document.querySelector('.se-insert-quotation-default-toolbar-button');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('quotation_toolbar_not_found');
  await waitFor(target, `document.querySelectorAll('.se-component.se-quotation').length > ${before}`, 15000, 400);
  await focusSelector(target, [
    '.se-component.se-quotation .__se-node',
    '.se-component.se-quotation .se-text-paragraph',
    '.se-component.se-quotation [contenteditable="true"]',
    '.se-component.se-quotation',
  ], 'last');
  await insertText(target, String(text || ''));
  await sleep(200);
  await ensureTrailingTextComponent(target);
  return true;
}

async function insertHorizontalLineComponent(target) {
  await focusLastTextTarget(target);
  const before = Number(await evaluate(target, `document.querySelectorAll('.se-component.se-horizontalLine').length`)) || 0;
  const clicked = await evaluate(target, `(() => {
    const button = document.querySelector('.se-insert-horizontal-line-default-toolbar-button');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('horizontal_line_toolbar_not_found');
  await waitFor(target, `document.querySelectorAll('.se-component.se-horizontalLine').length > ${before}`, 15000, 400);
  await sleep(200);
  await ensureTrailingTextComponent(target);
  return true;
}

function matchingEditorTabs(job, tabs = []) {
  const blogId = String(job?.blogId || '');
  const logNo = String(job?.target?.logNo || '');
  return tabs.filter(tab => {
    try {
      const url = new URL(tab.url || '');
      const editorPath = url.hostname === 'blog.naver.com'
        && ['/PostWriteForm.naver', '/PostUpdateForm.naver'].includes(url.pathname);
      return editorPath
        && (!blogId || url.searchParams.get('blogId') === blogId)
        && (!logNo || url.searchParams.get('logNo') === logNo);
    } catch {
      return false;
    }
  });
}

function selectEditorTab(job, tabs = []) {
  const exactTabs = matchingEditorTabs(job, tabs);
  const sortByRecency = values => values.sort((left, right) => {
    const accessed = Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
    return accessed || Number(right.id || 0) - Number(left.id || 0);
  });
  const editorTabs = tabs.filter(tab => {
    try {
      const url = new URL(tab.url || '');
      return url.hostname === 'blog.naver.com'
        && ['/PostWriteForm.naver', '/PostUpdateForm.naver'].includes(url.pathname);
    } catch {
      return false;
    }
  });
  // Naver may remove blogId/logNo from the visible editor URL after the page
  // has hydrated. Prefer any real editor tab over the currently active
  // chrome://extensions tab in that case.
  return sortByRecency(exactTabs)[0]
    || sortByRecency(editorTabs)[0]
    || tabs.find(tab => tab.active)
    || tabs[0]
    || null;
}

async function physicalClick(target, rect) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  const x = rect.x + Math.max(1, rect.width || 1) / 2;
  const y = rect.y + Math.max(1, rect.height || 1) / 2;
  await command(target, 'Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, button: 'none'});
  await command(target, 'Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
  await command(target, 'Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  return true;
}

async function clearEditorDocument(target, {preserveExistingOgLink = false} = {}) {
  await focusSelector(target, [
    '.se-component.se-text .__se-node',
    '.se-component.se-text .se-text-paragraph',
    '.se-component.se-text',
  ]);
  // One Ctrl+A selects the current SmartEditor text component. A second Ctrl+A
  // selects the browser document and makes Backspace a no-op, so do not repeat it.
  await key(target, 'a', 'KeyA', 65, 2);
  await sleep(100);
  await key(target, 'Backspace', 'Backspace', 8, 0);
  await sleep(400);

  // Non-text components need real input events. Synthetic element.click() does
  // not reliably select SmartEditor image/OG components, so the delete toolbar
  // never becomes actionable. Use CDP mouse input against the component and its
  // visible delete control, then fall back to Delete/Backspace.
  for (let attempt = 0; attempt < 80; attempt++) {
    const beforeState = await evaluate(target, `(() => {
      const selector = ${js('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')};
      const preserveOg = ${preserveExistingOgLink ? 'true' : 'false'};
      const components = [...document.querySelectorAll(selector)].filter(component => !(preserveOg && component.classList.contains('se-oglink')));
      const component = components.at(-1);
      if (!component) return {count: 0};
      component.scrollIntoView({block: 'center'});
      const node = component.querySelector('img,video,table,.se-component-content') || component;
      const rect = node.getBoundingClientRect();
      return {
        count: components.length,
        images: component.querySelectorAll('.se-image-resource').length,
        type: [...component.classList].join(' '),
        compid: component.dataset.compid || component.id || null,
        rect: {x: rect.left, y: rect.top, width: rect.width, height: rect.height},
      };
    })()`);
    const before = Number(beforeState?.count) || 0;
    if (before === 0) break;
    await physicalClick(target, beforeState.rect);
    await sleep(350);

    // Prefer the visible delete control owned by the exact component we selected.
    // SmartEditor keeps many hidden delete buttons in the document; choosing
    // the first globally visible one can target a stale toolbar from another
    // component and leave the selected component untouched.
    const componentId = String(beforeState?.compid || '');
    const ownedDeleteRect = await evaluate(target, `(() => {
      const id = ${js(componentId)};
      const component = id
        ? document.getElementById(id) || document.querySelector('[data-compid="' + CSS.escape(id) + '"]')
        : null;
      if (!component) return null;
      component.scrollIntoView({block: 'center'});
      const candidates = [
        ...component.querySelectorAll('.se-context-toolbar .se-delete-toolbar-button'),
        ...component.querySelectorAll('.se-component-toolbar .se-delete-toolbar-button'),
        ...component.querySelectorAll('.se-delete-toolbar-button'),
        ...component.querySelectorAll('.se-image-delete-button'),
        ...component.querySelectorAll('.se-oglink-delete-button'),
        ...component.querySelectorAll('.se-video-delete-button'),
        ...component.querySelectorAll('.se-table-delete-button'),
        ...component.querySelectorAll('button[data-name="delete"],button[class*="delete"]'),
      ];
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const button = candidates.find(visible);
      if (!button) return null;
      let rect = button.getBoundingClientRect();
      if (rect.top < 30) {
        window.scrollBy(0, rect.top - 120);
        rect = button.getBoundingClientRect();
      } else if (rect.bottom > window.innerHeight - 30) {
        window.scrollBy(0, rect.bottom - window.innerHeight + 120);
        rect = button.getBoundingClientRect();
      }
      return {x: rect.left, y: rect.top, width: rect.width, height: rect.height, cls: String(button.className || '')};
    })()`);
    if (ownedDeleteRect) {
      await physicalClick(target, ownedDeleteRect);
      await sleep(700);
      const ownedAfter = await evaluate(target, `(() => {
        const preserveOg = ${preserveExistingOgLink ? 'true' : 'false'};
        const components = [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')]
          .filter(component => !(preserveOg && component.classList.contains('se-oglink')));
        const component = components.at(-1);
        return {count: components.length, images: component?.querySelectorAll('.se-image-resource').length || 0};
      })()`);
      if ((Number(ownedAfter?.count) || 0) < before || (Number(ownedAfter?.images) || 0) < (Number(beforeState?.images) || 0)) continue;
    }

    const deleteRect = await evaluate(target, `(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0
          && rect.height > 0
          && rect.bottom > 0
          && rect.top < window.innerHeight
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      };
      const selectors = [
        '.se-delete-toolbar-button',
        '.se-image-delete-button',
        '.se-oglink-delete-button',
        '.se-video-delete-button',
        '.se-table-delete-button',
        '.se-component-toolbar button[class*="delete"]',
        '.se-component-toolbar button[class*="remove"]',
        '.se-wrap button[aria-label*="삭제"]',
        '.se-wrap button[title*="삭제"]',
      ];
      const contextual = [...document.querySelectorAll('.se-context-toolbar button, .se-component-toolbar button')]
        .filter(element => /삭제|delete|remove/i.test([
          element.innerText,
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.className,
        ].filter(Boolean).join(' ')));
      const button = [
        ...selectors.flatMap(selector => [...document.querySelectorAll(selector)]),
        ...contextual,
      ].find(element => visible(element));
      if (!button) return null;
      let rect = button.getBoundingClientRect();
      // Tall image groups and quotations can leave their floating toolbar
      // partially outside the viewport. Bring the control into a safe click
      // area and measure it again before dispatching the physical mouse event.
      if (rect.top < 20) {
        window.scrollBy(0, rect.top - 100);
        rect = button.getBoundingClientRect();
      } else if (rect.bottom > window.innerHeight - 20) {
        window.scrollBy(0, rect.bottom - window.innerHeight + 100);
        rect = button.getBoundingClientRect();
      }
      return {x: rect.left, y: rect.top, width: rect.width, height: rect.height, cls: button.className};
    })()`);
    let invokedDelete = false;
    if (deleteRect) {
      invokedDelete = await evaluate(target, `(() => {
        const visible = element => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        };
        const button = [...document.querySelectorAll('.se-context-toolbar .se-delete-toolbar-button, .se-component-toolbar .se-delete-toolbar-button, .se-delete-toolbar-button')]
          .find(element => visible(element));
        if (!button) return false;
        button.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, pointerType: 'mouse'}));
        button.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
        button.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true, view: window}));
        button.click();
        return true;
      })()`).catch(() => false);
      if (!invokedDelete) await physicalClick(target, deleteRect);
      await sleep(600);
    } else {
      await key(target, 'Delete', 'Delete', 46, 0);
      await sleep(350);
    }

    let afterState = await evaluate(target, `(() => {
      const preserveOg = ${preserveExistingOgLink ? 'true' : 'false'};
      const components = [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')]
        .filter(component => !(preserveOg && component.classList.contains('se-oglink')));
      const component = components.at(-1);
      return {count: components.length, images: component?.querySelectorAll('.se-image-resource').length || 0};
    })()`);
    if ((Number(afterState?.count) || 0) < before || (Number(afterState?.images) || 0) < (Number(beforeState?.images) || 0)) continue;

    // Some image and OG components expose a visible toolbar but ignore its
    // synthetic/physical click while still honoring the native Delete key once
    // the component itself is selected. Try Delete before the Backspace fallback.
    await key(target, 'Delete', 'Delete', 46, 0);
    await sleep(500);
    afterState = await evaluate(target, `(() => ({
      count: [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')]
        .filter(component => !(${preserveExistingOgLink ? 'true' : 'false'} && component.classList.contains('se-oglink'))).length,
    }))()`);
    if ((Number(afterState?.count) || 0) < before) continue;

    await key(target, 'Backspace', 'Backspace', 8, 0);
    await sleep(350);
    afterState = await evaluate(target, `(() => ({
      count: [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')]
        .filter(component => !(${preserveExistingOgLink ? 'true' : 'false'} && component.classList.contains('se-oglink'))).length,
    }))()`);
    if ((Number(afterState?.count) || 0) >= before) {
      throw new Error(`editor_component_delete_failed_${before}_${String(beforeState?.type || 'unknown').replace(/\s+/g, '_')}`);
    }
  }

  const remaining = await evaluate(target, `(() => ({
    text: document.querySelectorAll('.se-component.se-text').length,
    nonText: [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')]
      .filter(component => !(${preserveExistingOgLink ? 'true' : 'false'} && component.classList.contains('se-oglink'))).length,
    preservedOgLinks: document.querySelectorAll('.se-components-wrap > .se-component.se-oglink').length,
    nonEmpty: [...document.querySelectorAll('.se-component.se-text')].filter(e =>
      [...e.querySelectorAll('.__se-node')].some(node => (node.innerText || node.textContent || '').trim())
    ).length,
  }))()`);
  if ((Number(remaining?.nonText) || 0) > 0) throw new Error('editor_clear_left_non_text_components');
  // A retry may start from a partially rebuilt editor where the previous OG
  // card has already been removed. Zero is safe because the structured link
  // block recreates the affiliate card at the end. More than one is ambiguous
  // and remains a hard failure.
  if (preserveExistingOgLink && (Number(remaining?.preservedOgLinks) || 0) > 1) {
    throw new Error(`editor_preserved_oglink_count_${remaining?.preservedOgLinks || 0}`);
  }
  if ((Number(remaining?.nonEmpty) || 0) > 0) throw new Error('editor_clear_left_text');
}

async function insertStructuredBlocks(target, blocks = []) {
  const stats = {paragraphs: 0, headings: 0, lists: 0, images: 0, imageComponents: 0, quotes: 0, dividers: 0, links: 0};
  for (const block of blocks) {
    if (!block || !block.type) continue;

    if (block.type === 'image' || block.type === 'imageStrip') {
      const files = block.type === 'imageStrip'
        ? (Array.isArray(block.files) ? block.files : [])
        : [block.file].filter(Boolean);
      if (!files.length) throw new Error('structured_image_file_missing');
      const beforeComponents = Number(await evaluate(target, `document.querySelectorAll('.se-component.se-image,.se-component.se-imageStrip,.se-component.se-imageGroup').length`)) || 0;
      const beforeResources = Number(await evaluate(target, `document.querySelectorAll('.se-image-resource').length`)) || 0;
      await uploadFiles(target, files, block.type === 'imageStrip' ? 'slide' : 'single');
      await waitFor(target, `document.querySelectorAll('.se-image-resource').length >= ${beforeResources + files.length}`, 60000, 700);
      await waitFor(target, `document.querySelectorAll('.se-component.se-image,.se-component.se-imageStrip,.se-component.se-imageGroup').length > ${beforeComponents}`, 60000, 700);
      stats.images += files.length;
      stats.imageComponents++;
      await ensureTrailingTextComponent(target);
      continue;
    }

    if (block.type === 'quote') {
      await insertQuotationComponent(target, block.text);
      stats.quotes++;
      stats.paragraphs++;
      await focusLastTextTarget(target);
      continue;
    }

    if (block.type === 'divider') {
      await insertHorizontalLineComponent(target);
      stats.dividers++;
      await focusLastTextTarget(target);
      continue;
    }

    await focusLastTextTarget(target);
    if (block.type === 'heading') {
      await toggleBold(target);
      await insertText(target, String(block.text || ''));
      await toggleBold(target);
      await pressEnter(target, block.after ?? 2);
      stats.paragraphs++;
      stats.headings++;
      continue;
    }
    if (block.type === 'notice') {
      await toggleBold(target);
      await insertText(target, String(block.text || ''));
      await toggleBold(target);
      await pressEnter(target, block.after ?? 2);
      stats.paragraphs++;
      continue;
    }
    if (block.type === 'paragraph') {
      await insertText(target, String(block.text || ''));
      await pressEnter(target, block.after ?? 2);
      stats.paragraphs++;
      continue;
    }
    if (block.type === 'list' || block.type === 'numbered') {
      const items = Array.isArray(block.items) ? block.items : [];
      for (let index = 0; index < items.length; index++) {
        const prefix = block.type === 'numbered' ? `${index + 1}. ` : '• ';
        await insertText(target, prefix + String(items[index] || ''));
        await pressEnter(target, 1);
        stats.paragraphs++;
      }
      await pressEnter(target, block.after ?? 1);
      stats.lists++;
      continue;
    }
    if (block.type === 'link') {
      if (block.label) {
        await toggleBold(target);
        await insertText(target, String(block.label));
        await toggleBold(target);
        await pressEnter(target, 1);
        stats.paragraphs++;
      }
      await insertText(target, String(block.url || ''));
      await pressEnter(target, block.after ?? 2);
      stats.paragraphs++;
      stats.links++;
      continue;
    }
    if (block.type === 'spacer') {
      await pressEnter(target, block.count ?? 1);
      continue;
    }
    throw new Error(`unsupported_structured_block_${block.type}`);
  }
  return stats;
}

async function clickTextButton(target, text, classFragment = '') {
  const result = await evaluate(target, `(() => {
    const wanted = ${js(text)};
    const fragment = ${js(classFragment)};
    const elements = [...document.querySelectorAll('button,[role="button"],a')];
    const element = elements.find(item => {
      const label = (item.innerText || item.textContent || item.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      const cls = String(item.className || '');
      const rect = item.getBoundingClientRect();
      return label === wanted && (!fragment || cls.includes(fragment)) && rect.width > 0 && rect.height > 0;
    });
    if (!element) return false;
    element.scrollIntoView({block: 'center'});
    element.click();
    return true;
  })()`);
  if (!result) throw new Error(`button_not_found_${text}`);
}

async function waitFor(target, expression, timeout = 15000, interval = 400) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(target, expression).catch(() => false)) return true;
    await sleep(interval);
  }
  throw new Error('wait_timeout');
}

async function waitForTabUrl(tabId, predicate, timeout = 30000, interval = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url && predicate(tab.url)) return tab;
    await sleep(interval);
  }
  throw new Error('tab_navigation_timeout');
}

async function readPublicReceipt(tab, requiredMarkers = []) {
  const url = String(tab?.url || '');
  const parsed = new URL(url);
  let publicStatus = null;
  let publicReadback = null;
  let domReadback = null;
  try {
    const response = await withTimeout(fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
    }), 20000, 'public_readback_timeout');
    const html = await withTimeout(response.text(), 20000, 'public_readback_body_timeout');
    publicStatus = response.status;
    publicReadback = {
      markerPresence: Object.fromEntries(requiredMarkers.map(marker => [marker, html.includes(marker)])),
      affiliateLinkPresent: html.includes('link.coupang.com') || html.includes('hbRiUudndQ'),
      smartEditorBodyPresent: html.includes('se-main-container'),
    };
  } catch (error) {
    publicReadback = {error: sanitizeError(error)};
  }
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !domReadback?.smartEditorBodyPresent) {
      const execution = await withTimeout(chrome.scripting.executeScript({
        target: {tabId: tab.id},
        args: [requiredMarkers],
        func: markers => {
          const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
          const root = document.querySelector('.se-main-container');
          const paragraphTexts = root
            ? [...root.querySelectorAll('.se-text-paragraph')].map(element => normalize(element.innerText)).filter(Boolean)
            : [];
          const bodyText = paragraphTexts.join('\n');
          const componentCounts = {};
          for (const component of root ? root.querySelectorAll('.se-component') : []) {
            const type = ['se-text', 'se-image', 'se-imageStrip', 'se-imageGroup', 'se-oglink', 'se-table', 'se-quotation', 'se-horizontalLine', 'se-video']
              .find(name => component.classList.contains(name)) || 'other';
            componentCounts[type] = (componentCounts[type] || 0) + 1;
          }
          const images = root
            ? [...root.querySelectorAll('img')].map(image => image.currentSrc || image.src).filter(Boolean)
            : [];
          return {
            smartEditorBodyPresent: Boolean(root),
            pageTitle: document.title,
            paragraphCount: paragraphTexts.length,
            maxParagraphLength: Math.max(0, ...paragraphTexts.map(value => value.length)),
            componentCounts,
            uniqueImageCount: new Set(images).size,
            markerPresence: Object.fromEntries(markers.map(marker => [marker, bodyText.includes(normalize(marker))])),
            affiliateLinkPresent: Boolean(root?.querySelector('a[href*="link.coupang.com"]')) || bodyText.includes('link.coupang.com'),
          };
        },
      }), 10000, 'public_dom_readback_timeout');
      domReadback = execution?.[0]?.result || null;
      if (!domReadback?.smartEditorBodyPresent) await sleep(500);
    }
  } catch (error) {
    domReadback = {error: sanitizeError(error)};
  }
  const markerPresence = Object.fromEntries(requiredMarkers.map(marker => [
    marker,
    domReadback?.markerPresence?.[marker] === true || publicReadback?.markerPresence?.[marker] === true,
  ]));
  return {
    url,
    path: parsed.pathname,
    logNo: parsed.searchParams.get('logNo') || (parsed.pathname.match(/\/(\d+)$/) || [])[1] || null,
    pageTitle: domReadback?.pageTitle || tab?.title || null,
    publicStatus,
    paragraphCount: domReadback?.paragraphCount ?? null,
    maxParagraphLength: domReadback?.maxParagraphLength ?? null,
    componentCounts: domReadback?.componentCounts || {},
    uniqueImageCount: domReadback?.uniqueImageCount ?? null,
    publicReadback: {
      ...publicReadback,
      markerPresence,
      affiliateLinkPresent: domReadback?.affiliateLinkPresent === true || publicReadback?.affiliateLinkPresent === true,
      smartEditorBodyPresent: domReadback?.smartEditorBodyPresent === true || publicReadback?.smartEditorBodyPresent === true,
      domReadback,
    },
  };
}

async function uploadFiles(target, files, mode = 'single') {
  if (!files?.length) return {requested: 0, observed: 0};
  await command(target, 'Page.setInterceptFileChooserDialog', {enabled: true});
  let resolveChooser;
  let rejectChooser;
  const chooser = new Promise((resolve, reject) => {
    resolveChooser = resolve;
    rejectChooser = reject;
    setTimeout(() => reject(new Error('file_chooser_timeout')), 10000);
  });
  const listener = (source, method, params) => {
    if (source.tabId === target.tabId && method === 'Page.fileChooserOpened') resolveChooser(params);
  };
  chrome.debugger.onEvent.addListener(listener);
  try {
    const clicked = await evaluate(target, `(() => {
      const element = document.querySelector('.se-image-toolbar-button');
      if (!element) return false;
      element.click();
      return true;
    })()`);
    if (!clicked) throw new Error('image_toolbar_not_found');
    // SmartEditor can open a layout picker before the native file chooser.
    // Single images usually go straight to the chooser, while multi-image
    // strips need the slide option selected first. Race both editor variants.
    let opened = await Promise.race([
      chooser,
      sleep(600).then(() => null),
    ]);
    let inputObjectId = null;
    if (!opened) {
      const modeLabel = mode === 'slide' ? '슬라이드' : mode === 'collage' ? '콜라주' : '개별사진';
      // Single-image uploads often create a hidden file input immediately and
      // never show the layout picker. Only multi-image uploads need a layout
      // choice before falling back to the file input element.
      if (mode !== 'single') {
        const modeRect = await evaluate(target, `(() => {
          const label = ${js(mode === 'slide' ? '슬라이드' : '콜라주')};
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const candidates = [...document.querySelectorAll('button,[role="button"],li')];
          const option = candidates.find(element => visible(element) && (element.innerText || element.textContent || '').trim() === label);
          if (!option) return null;
          const rect = option.getBoundingClientRect();
          return {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
        })()`);
        if (!modeRect) throw new Error(`image_mode_not_found_${modeLabel}`);
        await physicalClick(target, modeRect);
        opened = await Promise.race([
          chooser,
          sleep(1200).then(() => null),
        ]);
      }
      if (!opened) {
        const input = await command(target, 'Runtime.evaluate', {
          expression: `(() => {
            const inputs = [...document.querySelectorAll('input[type="file"]')];
            return inputs.find(element => /image/i.test(element.accept || '')) || inputs.at(-1) || null;
          })()`,
          awaitPromise: true,
          returnByValue: false,
          userGesture: true,
        });
        inputObjectId = input?.result?.objectId || null;
        if (!inputObjectId) throw new Error(`image_file_input_not_found_${modeLabel}`);
      }
    }
    await command(target, 'DOM.setFileInputFiles', opened
      ? {files, backendNodeId: opened.backendNodeId}
      : {files, objectId: inputObjectId});
    await sleep(2000);
    await waitFor(target, `(() => {
      const uploading = document.querySelectorAll('[class*="uploading"], [class*="progress"]');
      const images = document.querySelectorAll('.se-component.se-image, .se-component.se-imageStrip, .se-component.se-imageGroup, .se-module-image img');
      return uploading.length === 0 && images.length >= 1;
    })()`, 45000, 700).catch(() => false);
    const observed = await evaluate(target, `document.querySelectorAll('.se-component.se-image, .se-component.se-imageStrip, .se-component.se-imageGroup, .se-module-image img').length`);
    return {requested: files.length, observed: Number(observed) || 0};
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
    await command(target, 'Page.setInterceptFileChooserDialog', {enabled: false}).catch(() => {});
  }
}

async function inspect(target) {
  return evaluate(target, `(() => ({
    buildId: ${js(BUILD_ID)},
    url: location.origin + location.pathname,
    title: document.title,
    editor: Boolean(document.querySelector('.blog_editor,.se-wrap,.se-title-text')),
    titleSelectors: [...document.querySelectorAll('.se-title-text .se-text-paragraph,.se-title-text .__se-node')].map(e => ({cls:String(e.className||''),text:(e.innerText||'').slice(0,120)})),
    textComponents: [...document.querySelectorAll('.se-component.se-text .se-text-paragraph,.se-component.se-text .__se-node')].map(e => ({cls:String(e.className||''),text:(e.innerText||'').slice(0,120)})).slice(0,20),
    imageCount: document.querySelectorAll('.se-component.se-image,.se-component.se-imageStrip,.se-component.se-imageGroup,.se-module-image img').length,
    imageComponentCount: document.querySelectorAll('.se-component.se-image,.se-component.se-imageStrip,.se-component.se-imageGroup').length,
    imageResourceCount: document.querySelectorAll('.se-image-resource').length,
    quoteComponentCount: document.querySelectorAll('.se-component.se-quotation').length,
    dividerComponentCount: document.querySelectorAll('.se-component.se-horizontalLine').length,
    ogLinkCount: document.querySelectorAll('.se-component.se-oglink').length,
    ogLinkTexts: [...document.querySelectorAll('.se-component.se-oglink')].map(e =>
      (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
    ),
    textComponentCount: document.querySelectorAll('.se-component.se-text').length,
    paragraphCount: document.querySelectorAll('.se-component.se-text .se-text-paragraph').length,
    nonEmptyParagraphs: [...document.querySelectorAll('.se-component.se-text .se-text-paragraph')].map(e =>
      [...e.querySelectorAll('.__se-node')].map(node => node.innerText || node.textContent || '').join('')
    ).filter(value => value.trim()).length,
    maxParagraphLength: Math.max(0, ...[...document.querySelectorAll('.se-component.se-text .se-text-paragraph')].map(e =>
      [...e.querySelectorAll('.__se-node')].map(node => node.innerText || node.textContent || '').join('').trim().length
    )),
    paragraphTexts: [...document.querySelectorAll('.se-component.se-text .se-text-paragraph')].map(e =>
      [...e.querySelectorAll('.__se-node')].map(node => node.innerText || node.textContent || '').join('').replace(/\\s+/g, ' ').trim()
    ).filter(Boolean).slice(0, 100),
    quoteTexts: [...document.querySelectorAll('.se-component.se-quotation')].map(e =>
      (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim()
    ).filter(Boolean).slice(0, 50),
    componentSummary: [...document.querySelectorAll('.se-component')].map((e, index) => ({
      index,
      cls: String(e.className || '').slice(0, 200),
      text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      editableCount: e.querySelectorAll('[contenteditable="true"]').length,
      parentCls: String(e.parentElement?.className || '').slice(0, 160),
      id: e.id || null,
      attrs: Object.fromEntries([...e.attributes].filter(a => /^(data-|id$|role$|tabindex$)/.test(a.name)).map(a => [a.name, a.value]).slice(0, 20)),
      html: e.outerHTML.slice(0, 1600),
    })).slice(0, 120),
    editableSummary: [...document.querySelectorAll('[contenteditable="true"]')].map((e, index) => ({
      index,
      tag: e.tagName,
      cls: String(e.className || '').slice(0, 200),
      text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      parentCls: String(e.parentElement?.className || '').slice(0, 160),
    })).slice(0, 160),
    publishButtons: [...document.querySelectorAll('button')].map(e => (e.innerText||'').trim()).filter(Boolean).filter(v => v.includes('발행')),
  }))()`);
}

async function probeNonTextComponent(target) {
  const component = await evaluate(target, `(() => {
    const component = [...document.querySelectorAll('.se-components-wrap > .se-component:not(.se-documentTitle):not(.se-text)')].at(-1);
    if (!component) return {clicked: false};
    component.scrollIntoView({block: 'center'});
    const node = component.querySelector('.se-oglink-frame,.se-image-frame,img,video,table,a,.se-component-content') || component;
    const rect = node.getBoundingClientRect();
    return {
      clicked: true,
      compid: component.dataset.compid || component.id || null,
      cls: component.className,
      html: component.outerHTML.slice(0, 8000),
      anchors: [...component.querySelectorAll('a[href]')].map(a => ({
        href: a.href,
        cls: String(a.className || ''),
        text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      })),
      rect: {x: rect.left, y: rect.top, width: rect.width, height: rect.height},
    };
  })()`);
  if (component?.rect) await physicalClick(target, component.rect);
  await sleep(700);
  const state = await evaluate(target, `(() => ({
    active: {tag: document.activeElement?.tagName || null, cls: String(document.activeElement?.className || ''), id: document.activeElement?.id || null},
    selectedComponents: [...document.querySelectorAll('.se-component')].filter(e => /selected|focused|active/.test(String(e.className))).map(e => ({id:e.id, cls:String(e.className), title:e.dataset.a11yTitle || null})),
    controls: [...document.querySelectorAll('button,[role="button"],[title],[aria-label]')].map(e => {
      const rect = e.getBoundingClientRect();
      return {
        tag:e.tagName,
        text:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,100),
        title:e.getAttribute('title'),
        aria:e.getAttribute('aria-label'),
        cls:String(e.className||'').slice(0,200),
        hidden:!(e.offsetWidth||e.offsetHeight||e.getClientRects().length),
        rect:{x:rect.left,y:rect.top,width:rect.width,height:rect.height},
      };
    }).filter(e => /remove|delete|image|photo|group|align|size|original|edit|link/i.test([e.text,e.title,e.aria,e.cls].filter(Boolean).join(' '))).slice(0,240),
  }))()`);
  return {click: component, state};
}

function verifyStructure(job, draft) {
  const problems = [];
  if (job.minParagraphs && Number(draft?.nonEmptyParagraphs || 0) < Number(job.minParagraphs)) {
    problems.push(`paragraphs_${draft?.nonEmptyParagraphs || 0}_lt_${job.minParagraphs}`);
  }
  if (job.maxParagraphLength && Number(draft?.maxParagraphLength || 0) > Number(job.maxParagraphLength)) {
    problems.push(`max_paragraph_${draft?.maxParagraphLength || 0}_gt_${job.maxParagraphLength}`);
  }
  if (job.minImageComponents && Number(draft?.imageComponentCount || 0) < Number(job.minImageComponents)) {
    problems.push(`image_components_${draft?.imageComponentCount || 0}_lt_${job.minImageComponents}`);
  }
  if (job.minImageCount && Number(draft?.imageResourceCount || 0) < Number(job.minImageCount)) {
    problems.push(`image_count_${draft?.imageResourceCount || 0}_lt_${job.minImageCount}`);
  }
  if (job.minQuoteComponents && Number(draft?.quoteComponentCount || 0) < Number(job.minQuoteComponents)) {
    problems.push(`quote_components_${draft?.quoteComponentCount || 0}_lt_${job.minQuoteComponents}`);
  }
  if (job.minDividerComponents && Number(draft?.dividerComponentCount || 0) < Number(job.minDividerComponents)) {
    problems.push(`divider_components_${draft?.dividerComponentCount || 0}_lt_${job.minDividerComponents}`);
  }
  const separate = Array.isArray(job.requiredSeparateParagraphs) ? job.requiredSeparateParagraphs : [];
  const paragraphs = [
    ...(Array.isArray(draft?.paragraphTexts) ? draft.paragraphTexts : []),
    ...(Array.isArray(draft?.quoteTexts) ? draft.quoteTexts : []),
  ];
  for (const marker of separate) {
    if (!paragraphs.some(value => value.includes(marker))) problems.push(`separate_marker_missing_${marker}`);
  }
  if (problems.length) throw new Error(`draft_structure_failed_${problems.join('|')}`);
}

async function publishJob(target, job) {
  await waitFor(target, `Boolean(document.querySelector('.se-title-text .__se-node[contenteditable="true"], .se-title-text .se-text-paragraph')) && document.querySelectorAll('.se-component').length > 0`, 45000);

  if (job.skipTitleUpdate !== true) {
    await focusSelector(target, ['.se-title-text .__se-node[contenteditable="true"]', '.se-title-text .se-text-paragraph', '.se-title-text']);
    await replaceFocusedText(target, job.title);
    await sleep(500);
  }

  let structured = null;
  let upload = {requested: 0, observed: 0};
  if (Array.isArray(job.blocks) && job.blocks.length) {
    if (job.appendExistingDraft === true) {
      await ensureTrailingTextComponent(target);
    } else {
      await clearEditorDocument(target, {preserveExistingOgLink: job.preserveExistingOgLink === true});
    }
    structured = await insertStructuredBlocks(target, job.blocks);
    upload = {requested: structured.images, observed: structured.images};
  } else if (job.verifyExistingDraftOnly === true) {
    structured = {verifiedExistingDraft: true};
    upload = {requested: 0, observed: 0};
  } else {
    await focusSelector(target, ['.se-component.se-text .__se-node[contenteditable="true"]', '.se-component.se-text .se-text-paragraph', '.se-component.se-text']);
    await replaceFocusedText(target, job.body);
    await sleep(800);
    upload = await uploadFiles(target, job.assets || []);
  }
  const draft = await inspect(target);
  const titleText = normalizeText(await evaluate(target, `(
    document.querySelector('.se-title-text .se-text-paragraph')?.innerText
    || document.querySelector('.se-title-text')?.innerText
    || ''
  )`));
  const required = job.requiredMarkers || [];
  const normalizedBody = normalizeText([
    ...(draft?.paragraphTexts || []),
    ...(draft?.quoteTexts || []),
    ...(draft?.ogLinkTexts || []),
].join('\n'));
  const normalizedTitle = normalizeText(job.expectedExistingTitle || job.title);
  const missing = required.filter(marker => !normalizedBody.includes(normalizeText(marker)));
  const titleMatches = titleText === normalizedTitle;
  if (!titleMatches || missing.length) {
    throw new Error(`draft_verification_failed_title_${titleMatches}_markers_${missing.length}`);
  }
  verifyStructure(job, draft);
  if (job.dryRun) return {published: false, draft, upload, structured, titleText, missing};

  const actionLabel = job.actionLabel || '발행';
  await clickTextButton(target, actionLabel, job.actionClass || 'publish_btn');
  await waitFor(target, `Boolean([...document.querySelectorAll('button')].find(e => (e.innerText||'').trim()===${js(actionLabel)} && String(e.className||'').includes('confirm_btn')))`, 10000);
  const publishSettings = await evaluate(target, `(() => ({
    category: [...document.querySelectorAll('[class*="selectbox"],button')].map(e => (e.innerText||'').trim()).find(v => v && !v.includes('카테고리 목록')) || null,
    publicSelected: [...document.querySelectorAll('input[type="radio"], [role="radio"]')].some(e => ((e.labels?.[0]?.innerText || e.parentElement?.innerText || '').includes('전체공개')) && (e.checked || e.getAttribute('aria-checked') === 'true')),
    currentSelected: [...document.querySelectorAll('input[type="radio"], [role="radio"]')].some(e => ((e.labels?.[0]?.innerText || e.parentElement?.innerText || '').includes('현재')) && (e.checked || e.getAttribute('aria-checked') === 'true')),
  }))()`);
  const expectedSettings = job.publishSettings || {};
  if (expectedSettings.visibility === 'public' && publishSettings.publicSelected !== true) {
    throw new Error('publish_visibility_not_public');
  }
  if (expectedSettings.timing === 'current' && publishSettings.currentSelected !== true) {
    throw new Error('publish_timing_not_current');
  }
  await clickTextButton(target, actionLabel, 'confirm_btn');
  // Do not use the debugger execution context after the final navigation. Chrome
  // may replace the renderer process and leave Runtime.evaluate unresolved even
  // though the post was already published. Observe the tab URL through the tabs
  // API instead, then perform a public HTTP read-back.
  const finalTab = await waitForTabUrl(
    target.tabId,
    url => url.includes('PostView.naver') || /\/\d+(?:[?#]|$)/.test(url),
    30000,
    500,
  );
  await sleep(1200);
  const receipt = await readPublicReceipt(finalTab, required);
  return {published: true, publishSettings, upload, structured, draft, receipt};
}

async function postResult(payload) {
  const response = await withTimeout(fetch(`${SERVER}/result`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload),
    cache: 'no-store',
  }), 10000, 'result_post_timeout');
  if (!response.ok) throw new Error(`result_post_http_${response.status}`);
}

async function maybeRun() {
  if (running) return;
  running = true;
  let target = null;
  let currentJobId = null;
  try {
    const response = await fetch(`${SERVER}/job`, {cache: 'no-store'});
    if (!response.ok) return;
    const job = await response.json();
    if (!job?.jobId) return;
    currentJobId = job.jobId;
    const state = await chrome.storage.local.get(['lastJobId', 'lastResult']);
    if (state.lastJobId === job.jobId) {
      if (state.lastResult?.jobId === job.jobId) await postResult(state.lastResult).catch(() => {});
      return;
    }
    if (job.mode === 'tab_probe') {
      const tabs = await chrome.tabs.query({});
      const payload = {
        jobId: job.jobId,
        ok: true,
        mode: 'tab_probe',
        data: tabs.map(tab => ({
          id: tab.id,
          windowId: tab.windowId,
          active: tab.active,
          discarded: tab.discarded,
          title: tab.title || null,
          url: tab.url || null,
          lastAccessed: tab.lastAccessed || null,
        })),
      };
      await chrome.storage.local.set({lastJobId: job.jobId, lastResult: payload});
      await postResult(payload);
      await chrome.action.setBadgeText({text: 'OK'});
      await chrome.action.setBadgeBackgroundColor({color: '#25833d'});
      return;
    }
    // Query all tabs and apply the exact editor-path predicate ourselves.
    // Chrome's URL-pattern query can intermittently omit an already-loaded
    // PostUpdateForm tab after renderer recovery or memory discard.
    let tabs = [];
    let tab = null;
    const editorDeadline = Date.now() + 45000;
    while (Date.now() < editorDeadline && !tab?.id) {
      tabs = await chrome.tabs.query({});
      tab = selectEditorTab(job, tabs);
      if (!tab?.id) await sleep(500);
    }
    if (!tab?.id) throw new Error('naver_editor_tab_not_found');
    // Never close duplicate editor tabs by default. An unsaved SmartEditor tab
    // can raise a native "leave site" dialog, which blocks the extension worker
    // and may strand a successful partial edit without a receipt. Duplicate-tab
    // cleanup is therefore opt-in and must only be used when the caller has
    // separately proved that the other tabs contain no unsaved changes.
    if (job.closeDuplicateEditorTabs === true) {
      const duplicateIds = matchingEditorTabs(job, tabs)
        .filter(item => item.id !== tab.id)
        .map(item => item.id)
        .filter(Number.isInteger);
      if (duplicateIds.length) {
        await chrome.tabs.remove(duplicateIds);
        await sleep(300);
      }
    }
    await chrome.tabs.update(tab.id, {active: true}).catch(() => {});
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, {focused: true}).catch(() => {});
    if (tab.discarded) await chrome.tabs.reload(tab.id);
    await sleep(tab.discarded ? 1500 : 500);
    target = {tabId: tab.id};
    await chrome.debugger.attach(target, '1.3');
    await sleep(350);
    let result;
    if (job.mode === 'inspect') {
      await waitFor(target, `Boolean(document.querySelector('.se-title-text .__se-node[contenteditable="true"], .se-title-text .se-text-paragraph')) && document.querySelectorAll('.se-component').length > 0`, 45000);
      result = {mode: 'inspect', data: await inspect(target)};
    } else if (job.mode === 'component_probe') {
      await waitFor(target, `Boolean(document.querySelector('.se-title-text .__se-node[contenteditable="true"], .se-title-text .se-text-paragraph')) && document.querySelectorAll('.se-component').length > 0`, 45000);
      result = {mode: 'component_probe', data: await probeNonTextComponent(target)};
    } else if (job.mode === 'clear_probe') {
      await waitFor(target, `Boolean(document.querySelector('.se-title-text .__se-node[contenteditable="true"], .se-title-text .se-text-paragraph')) && document.querySelectorAll('.se-component').length > 0`, 45000);
      const before = await inspect(target);
      await clearEditorDocument(target, {preserveExistingOgLink: job.preserveExistingOgLink === true});
      const after = await inspect(target);
      result = {mode: 'clear_probe', before, after};
    } else if (job.mode === 'publish') {
      result = {mode: 'publish', data: await publishJob(target, job)};
    } else {
      throw new Error('unsupported_job_mode');
    }
    const payload = {jobId: job.jobId, ok: true, ...result};
    // Persist the terminal result before sending it to localhost. If localhost
    // disappears after an irreversible publish, a later extension wake can
    // replay the receipt without repeating the publish operation.
    await chrome.storage.local.set({lastJobId: job.jobId, lastResult: payload});
    await postResult(payload);
    await chrome.action.setBadgeText({text: 'OK'});
    await chrome.action.setBadgeBackgroundColor({color: '#25833d'});
  } catch (error) {
    await postResult({jobId: currentJobId, ok: false, error: sanitizeError(error)}).catch(() => {});
    await chrome.action.setBadgeText({text: 'ERR'});
    await chrome.action.setBadgeBackgroundColor({color: '#a52020'});
  } finally {
    if (target) await chrome.debugger.detach(target).catch(() => {});
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => void maybeRun());
chrome.runtime.onStartup.addListener(() => void maybeRun());
chrome.action.onClicked.addListener(() => void maybeRun());
// Expose a narrow manual trigger in the service-worker DevTools context. This
// is useful when Chrome suspends the worker between a local job becoming
// available and the extension action being clicked. It does not expose any
// credentials or accept arbitrary job payloads; the job is still fetched from
// localhost and must pass the publisher server's deterministic gate.
globalThis.__naverPublisherRun = () => maybeRun();
globalThis.__naverPublisherState = () => ({running});
void maybeRun();
