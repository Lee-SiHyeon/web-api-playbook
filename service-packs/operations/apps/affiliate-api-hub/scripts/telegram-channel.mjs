// Telegram channel Bot API client. All Bot API requests are HTTPS calls made by the
// protected notifier; write attempts are journaled before dispatch and never retried.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFragment } from 'parse5';

export const TELEGRAM_CHANNEL_TITLE = '생활이득AI연구소';
export const TELEGRAM_CHANNEL_UPDATE_TYPES = Object.freeze(['message', 'callback_query', 'my_chat_member', 'channel_post', 'edited_channel_post']);
export const TELEGRAM_REQUIRED_RIGHTS = Object.freeze([
  'can_post_messages', 'can_edit_messages', 'can_delete_messages', 'can_invite_users', 'can_change_info', 'can_pin_messages',
]);
export const DEFAULT_TELEGRAM_DAILY_CAP = 15;
export const TELEGRAM_CHANNEL_DESCRIPTION = '앱테크 · 금융 이벤트 · 특가 · 공모주 · AI 소식 | 광고·제휴 포함 게시물은 광고/제휴를 표기합니다. 투자 권유가 아닙니다.';
export const TELEGRAM_CHANNEL_PINNED_MESSAGE = [
  '생활이득AI연구소에 오신 것을 환영합니다.',
  '앱테크, 금융 이벤트, 특가, 공모주, AI 소식을 확인할 수 있습니다.',
  '광고나 제휴가 포함된 게시물은 광고·제휴 사실을 표시합니다.',
  '정보 공유 목적이며 투자 권유가 아닙니다. 금융 상품과 공모주 참여 전 공식 안내와 위험을 직접 확인해 주세요.',
].join('\n\n');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const safeCode = value => /^[A-Z0-9_:-]{1,100}$/.test(String(value ?? '')) ? String(value) : 'TELEGRAM_CHANNEL_FAILED';
const permissionNames = Object.freeze({
  can_post_messages: 'can_post_messages (채널 게시)',
  can_edit_messages: 'can_edit_messages (채널 게시물 수정 및 고정)',
  can_delete_messages: 'can_delete_messages (게시물 삭제)',
  can_invite_users: 'can_invite_users (초대 링크)',
  can_change_info: 'can_change_info (채널 정보·사진 변경)',
  can_pin_messages: 'can_pin_messages (고정; 채널에서는 can_edit_messages로 처리)',
});

export function defaultTelegramChannelFile(env = process.env) {
  if (!env.LOCALAPPDATA) fail('TELEGRAM_CHANNEL_LOCALAPPDATA_REQUIRED');
  return path.join(env.LOCALAPPDATA, 'affiliate-content-operations', 'telegram-channel', 'channel.json');
}

export function defaultTelegramJournalDir(env = process.env) {
  if (!env.LOCALAPPDATA) fail('SNS_JOURNAL_ROOT_MISSING');
  return path.join(env.LOCALAPPDATA, 'affiliate-content-operations', 'sns', 'journal');
}

const chatStatus = value => String(value?.status ?? '');
const clip = (value, limit = 160) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, limit);

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, file);
}

function channelRecordFromUpdate(update, observedAt) {
  const change = update?.my_chat_member;
  const chat = change?.chat;
  const member = change?.new_chat_member;
  if (chat?.type !== 'channel' || chatStatus(member) !== 'administrator') return null;
  const reported = member;
  const notReportedPermissions = TELEGRAM_REQUIRED_RIGHTS.filter(key => typeof reported[key] !== 'boolean');
  const permissions = Object.fromEntries(TELEGRAM_REQUIRED_RIGHTS.map(key => [key, reported[key] === true]));
  // Telegram exposes channel pin authority through can_edit_messages. can_pin_messages
  // is documented for groups/supergroups and may be omitted for channels.
  const missingPermissions = TELEGRAM_REQUIRED_RIGHTS.filter(key => {
    if (key === 'can_pin_messages' && chat.type === 'channel' && reported.can_edit_messages === true) return false;
    return reported[key] === false || (typeof reported[key] !== 'boolean' && key !== 'can_pin_messages');
  });
  const selected = chat.title === TELEGRAM_CHANNEL_TITLE;
  const username = clip(chat.username, 64);
  return {
    id: String(chat.id), title: clip(chat.title, 255), username: /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null,
    type: chat.type, permissions, missingPermissions, notReportedPermissions,
    selected, ready: selected && missingPermissions.length === 0,
    observedAt, botStatus: chatStatus(member),
  };
}

export function telegramChannelRegistrationNotice(record) {
  const lines = [
    'Telegram 채널 관리자 등록 감지',
    `채널: ${record.title || '(제목 없음)'}`,
    `ID: ${record.id}`,
    `username: ${record.username ? `@${record.username}` : '(없음)'}`,
    record.selected ? `운영 대상: ${TELEGRAM_CHANNEL_TITLE}로 자동 선택` : `운영 대상 아님: 제목이 ${TELEGRAM_CHANNEL_TITLE}와 다릅니다. 확인이 필요합니다.`,
  ];
  const missing = record.missingPermissions.map(key => permissionNames[key] ?? key);
  if (missing.length) lines.push(`빠진 권한: ${missing.join(', ')}`);
  if (record.notReportedPermissions.includes('can_pin_messages') || (record.permissions.can_pin_messages === false && record.permissions.can_edit_messages)) {
    lines.push('참고: Telegram 채널 권한 응답에는 can_pin_messages가 없을 수 있으며, 고정은 can_edit_messages 권한으로 확인합니다.');
  }
  if (record.selected && !record.ready) lines.push('필요 권한을 확인하기 전까지 게시 기능은 보류됩니다.');
  return lines.join('\n');
}

// Handles only administrator updates for channels. It stores other channel registrations
// without changing an already selected target and sends the owner a private-chat notice.
export async function registerTelegramChannelUpdate(update, { filePath = defaultTelegramChannelFile(), notify = async () => ({ sent: false }) } = {}) {
  const record = channelRecordFromUpdate(update, new Date().toISOString());
  if (!record) return { handled: false, reason: 'NOT_CHANNEL_ADMIN_UPDATE' };
  let state = { version: 1, updatedAt: record.observedAt, selectedChatId: null, channels: [] };
  try {
    state = JSON.parse(await readFile(filePath, 'utf8'));
    if (state?.version !== 1 || !Array.isArray(state.channels)) fail('TELEGRAM_CHANNEL_REGISTRY_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const channels = state.channels.filter(channel => String(channel.id) !== record.id);
  channels.push(record);
  const selectedChatId = record.selected ? record.id : (state.selectedChatId ?? null);
  const saved = { version: 1, updatedAt: record.observedAt, selectedChatId, channels };
  await atomicJson(filePath, saved);
  const notice = telegramChannelRegistrationNotice(record);
  let notification = { sent: false, reason: 'NOT_CONFIGURED' };
  try { notification = await notify(notice); } catch (error) { notification = { sent: false, code: safeCode(error?.code) }; }
  return { handled: true, record, selectedChatId, notification };
}

export function previewTelegramChannelDefaults() {
  return {
    title: TELEGRAM_CHANNEL_TITLE,
    description: TELEGRAM_CHANNEL_DESCRIPTION,
    pinnedMessage: TELEGRAM_CHANNEL_PINNED_MESSAGE,
    operations: ['setChatDescription', 'sendMessage', 'pinChatMessage'],
    dryRun: true,
  };
}

function validateRunKey(runKey) {
  if (typeof runKey !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(runKey)) fail('TELEGRAM_RUN_KEY_INVALID');
  return runKey;
}

function validParseMode(mode) {
  if (mode === undefined || mode === null || mode === '') return undefined;
  if (!['HTML', 'MarkdownV2'].includes(mode)) fail('TELEGRAM_PARSE_MODE_INVALID');
  return mode;
}

function ensureText(text, limit, code) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > limit) fail(code);
  return text;
}

function safeFilename(runKey, method) {
  const key = validateRunKey(runKey);
  return `telegram.${key}.${method}.jsonl`;
}

async function payloadSummary(body) {
  if (!(body instanceof FormData)) {
    const raw = JSON.stringify(body ?? {});
    return { bodyBytes: Buffer.byteLength(raw), bodySha256: digest(raw) };
  }
  const fields = [];
  const imageSha256s = [];
  for (const [key, value] of body.entries()) {
    if (value instanceof Blob) {
      const bytes = Buffer.from(await value.arrayBuffer());
      const hash = digest(bytes);
      fields.push([key, value.name ?? '', value.type, value.size, hash]);
      if (String(value.type).startsWith('image/')) imageSha256s.push(hash);
    } else fields.push([key, String(value)]);
  }
  const raw = JSON.stringify(fields);
  return { bodyBytes: Buffer.byteLength(raw), bodySha256: digest(raw), ...(imageSha256s.length ? { imageSha256s } : {}) };
}

async function appendJournal(file, event, { create = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, create ? 'wx' : 'a');
  try { await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

async function uploadInput(input, { maxBytes, extensions = null } = {}) {
  let bytes, filename, mimeType;
  if (typeof input === 'string' && input.trim()) return { reference: input.trim() };
  if (input instanceof Blob) {
    bytes = Buffer.from(await input.arrayBuffer()); filename = input.name || 'upload.bin'; mimeType = input.type || 'application/octet-stream';
  } else if (input && typeof input === 'object' && typeof input.filePath === 'string') {
    const filePath = path.resolve(input.filePath);
    filename = path.basename(filePath);
    if (extensions && !extensions.test(filename)) fail('TELEGRAM_FILE_TYPE_INVALID');
    bytes = await readFile(filePath);
    mimeType = input.mimeType || (/\.png$/i.test(filename) ? 'image/png' : /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'application/octet-stream');
  } else if (input && typeof input === 'object' && (Buffer.isBuffer(input.bytes) || input.bytes instanceof Uint8Array)) {
    bytes = Buffer.from(input.bytes); filename = path.basename(String(input.filename || 'upload.bin'));
    mimeType = String(input.mimeType || 'application/octet-stream');
  } else fail('TELEGRAM_FILE_INPUT_INVALID');
  if (!bytes.length || bytes.length > maxBytes) fail('TELEGRAM_FILE_SIZE_INVALID');
  return { blob: new Blob([bytes], { type: mimeType }), bytes, filename, mimeType };
}

function formFields(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return form;
}

function publicMessageUrl(username, messageId) {
  return username && /^[A-Za-z0-9_]{5,32}$/.test(username) && /^\d{1,25}$/.test(String(messageId))
    ? `https://t.me/${username}/${messageId}` : null;
}

export function createTelegramChannelClient({ api, channelFile = defaultTelegramChannelFile(), journalDir = defaultTelegramJournalDir(), now = () => new Date().toISOString() } = {}) {
  if (typeof api !== 'function') fail('TELEGRAM_API_CALL_REQUIRED');

  async function selectedChannel() {
    let state;
    try { state = JSON.parse(await readFile(channelFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail('TELEGRAM_CHANNEL_NOT_REGISTERED'); throw error; }
    const channel = state?.channels?.find(item => String(item.id) === String(state.selectedChatId));
    if (!channel || !channel.selected || channel.title !== TELEGRAM_CHANNEL_TITLE || !/^-?\d+$/.test(String(channel.id))
      || (channel.username && !/^[A-Za-z0-9_]{5,32}$/.test(channel.username))) fail('TELEGRAM_CHANNEL_TARGET_NOT_SELECTED');
    if (!channel.ready) fail('TELEGRAM_CHANNEL_PERMISSIONS_MISSING');
    return channel;
  }

  async function journaledWrite(method, body, { runKey, timeoutMs = 30000, fileLabel = null } = {}) {
    const key = validateRunKey(runKey);
    const label = fileLabel || method;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(label)) fail('TELEGRAM_JOURNAL_LABEL_INVALID');
    const file = path.join(journalDir, safeFilename(key, label));
    const summary = await payloadSummary(body);
    const intent = { type: 'intent', channel: 'telegram', runKey: key, at: now(), method,
      request: { method: 'POST', url: `https://api.telegram.org/${method}`, ...summary } };
    try { await appendJournal(file, intent, { create: true }); }
    catch (error) { if (error.code === 'EEXIST') fail('TELEGRAM_WRITE_ALREADY_ATTEMPTED'); throw error; }

    let result;
    try { result = await api(method, body, timeoutMs); }
    catch (error) {
      await appendJournal(file, { type: 'result', at: now(), outcome: 'uncertain', code: safeCode(error?.code) }).catch(() => {});
      throw Object.assign(new Error(safeCode(error?.code)), { code: safeCode(error?.code), writeOutcome: 'uncertain' });
    }
    await appendJournal(file, { type: 'result', at: now(), outcome: 'response', ok: true });
    const messages = Array.isArray(result) ? result : (Number.isInteger(result?.message_id) ? [result] : []);
    if (['sendMessage', 'sendPhoto', 'sendMediaGroup'].includes(method)
      && (!messages.length || messages.some(message => !/^\d{1,25}$/.test(String(message?.message_id ?? ''))))) {
      fail('TELEGRAM_MESSAGE_ID_MISSING');
    }
    if (method === 'createChatInviteLink' && typeof result?.invite_link !== 'string') fail('TELEGRAM_INVITE_LINK_MISSING');
    if (result === false) fail('TELEGRAM_WRITE_NOT_CONFIRMED');
    if (messages.length) {
      const ids = messages.map(message => String(message.message_id));
      const channel = await selectedChannel();
      const urls = ids.map(id => publicMessageUrl(channel.username, id));
      await appendJournal(file, { type: 'checkpoint', at: now(), checkpoint: { kind: 'telegram_message_created', messageIds: ids, publicUrls: urls } });
      return { result, messageIds: ids, publicUrls: urls, messageId: ids[0], publicUrl: urls[0] };
    }
    const checkpoint = method === 'createChatInviteLink'
      ? { kind: 'telegram_invite_created', inviteUrlSha256: digest(String(result?.invite_link ?? '')) }
      : { kind: 'telegram_write_completed', method };
    await appendJournal(file, { type: 'checkpoint', at: now(), checkpoint });
    return { result };
  }

  async function targetBody(extra = {}) {
    const channel = await selectedChannel();
    return { channel, body: { chat_id: channel.id, ...extra } };
  }

  return Object.freeze({
    async channel() { return selectedChannel(); },
    async sendMessage(text, { runKey, parseMode = null, linkPreview = true, linkPreviewUrl, timeoutMs = 30000 } = {}) {
      ensureText(text, 4096, 'TELEGRAM_TEXT_INVALID');
      const mode = validParseMode(parseMode);
      const { channel, body } = await targetBody({ text,
        ...(mode ? { parse_mode: mode } : {}),
        link_preview_options: { is_disabled: linkPreview !== true, ...(linkPreviewUrl ? { url: String(linkPreviewUrl) } : {}) },
      });
      const write = await journaledWrite('sendMessage', body, { runKey, timeoutMs });
      return { ...write, messageId: write.messageId ?? String(write.result?.message_id ?? ''),
        publicUrl: write.publicUrl ?? publicMessageUrl(channel.username, write.result?.message_id) };
    },
    async sendPhoto(photo, { runKey, caption = '', parseMode = null, showCaptionAboveMedia = false } = {}) {
      const mode = validParseMode(parseMode);
      ensureText(String(caption || ' '), 1024, 'TELEGRAM_CAPTION_INVALID');
      const { channel } = await targetBody();
      const upload = await uploadInput(photo, { maxBytes: 10 * 1024 * 1024, extensions: /\.(png|jpe?g|webp)$/i });
      let body;
      if (upload.reference) body = { chat_id: channel.id, photo: upload.reference, ...(caption ? { caption } : {}), ...(mode ? { parse_mode: mode } : {}), ...(showCaptionAboveMedia ? { show_caption_above_media: true } : {}) };
      else {
        body = formFields({ chat_id: channel.id, caption: caption || undefined, parse_mode: mode, show_caption_above_media: showCaptionAboveMedia || undefined });
        body.set('photo', upload.blob, upload.filename);
      }
      return journaledWrite('sendPhoto', body, { runKey, timeoutMs: 60000 });
    },
    async sendMediaGroup(media, { runKey, disableNotification = false } = {}) {
      if (!Array.isArray(media) || media.length < 2 || media.length > 10) fail('TELEGRAM_MEDIA_GROUP_INVALID');
      const { channel } = await targetBody();
      const items = [];
      const files = [];
      for (let i = 0; i < media.length; i++) {
        const item = media[i];
        if (!item || !['photo', 'video'].includes(item.type)) fail('TELEGRAM_MEDIA_GROUP_INVALID');
        const upload = await uploadInput(item.media, { maxBytes: item.type === 'photo' ? 10 * 1024 * 1024 : 50 * 1024 * 1024 });
        const mediaRef = upload.reference || `attach://media${i}`;
        items.push({ type: item.type, media: mediaRef, ...(item.caption ? { caption: String(item.caption) } : {}), ...(item.parse_mode ? { parse_mode: validParseMode(item.parse_mode) } : {}) });
        if (!upload.reference) files.push({ key: `media${i}`, upload });
      }
      let body;
      if (!files.length) body = { chat_id: channel.id, media: items, ...(disableNotification ? { disable_notification: true } : {}) };
      else {
        body = formFields({ chat_id: channel.id, media: items, disable_notification: disableNotification || undefined });
        for (const { key, upload } of files) body.set(key, upload.blob, upload.filename);
      }
      return journaledWrite('sendMediaGroup', body, { runKey, timeoutMs: 120000 });
    },
    async editMessageText(messageId, text, { runKey, parseMode = null, linkPreview = true, linkPreviewUrl } = {}) {
      ensureText(text, 4096, 'TELEGRAM_TEXT_INVALID');
      const mode = validParseMode(parseMode);
      const { body } = await targetBody({ message_id: String(messageId), text,
        ...(mode ? { parse_mode: mode } : {}),
        link_preview_options: { is_disabled: linkPreview !== true, ...(linkPreviewUrl ? { url: String(linkPreviewUrl) } : {}) },
      });
      return journaledWrite('editMessageText', body, { runKey });
    },
    async deleteMessage(messageId, { runKey } = {}) {
      const { body } = await targetBody({ message_id: String(messageId) });
      return journaledWrite('deleteMessage', body, { runKey });
    },
    async pinChatMessage(messageId, { runKey, disableNotification = false } = {}) {
      const { body } = await targetBody({ message_id: String(messageId), ...(disableNotification ? { disable_notification: true } : {}) });
      return journaledWrite('pinChatMessage', body, { runKey });
    },
    async setChatDescription(description, { runKey } = {}) {
      if (typeof description !== 'string' || [...description].length > 255) fail('TELEGRAM_DESCRIPTION_INVALID');
      const { body } = await targetBody({ description });
      return journaledWrite('setChatDescription', body, { runKey });
    },
    async setChatTitle(title, { runKey } = {}) {
      if (typeof title !== 'string' || !title.trim() || [...title].length > 128) fail('TELEGRAM_TITLE_INVALID');
      const { body } = await targetBody({ title: title.trim() });
      return journaledWrite('setChatTitle', body, { runKey });
    },
    async setChatPhoto(photo, { runKey } = {}) {
      const { channel } = await targetBody();
      const upload = await uploadInput(photo, { maxBytes: 10 * 1024 * 1024, extensions: /\.(png|jpe?g|webp)$/i });
      if (upload.reference) fail('TELEGRAM_CHAT_PHOTO_REQUIRES_UPLOAD');
      const body = formFields({ chat_id: channel.id });
      body.set('photo', upload.blob, upload.filename);
      return journaledWrite('setChatPhoto', body, { runKey, timeoutMs: 60000 });
    },
    async createChatInviteLink({ runKey, name, expireDate, memberLimit, createsJoinRequest } = {}) {
      const fields = { ...(name ? { name: String(name).slice(0, 32) } : {}),
        ...(Number.isInteger(expireDate) ? { expire_date: expireDate } : {}),
        ...(Number.isInteger(memberLimit) ? { member_limit: memberLimit } : {}),
        ...(typeof createsJoinRequest === 'boolean' ? { creates_join_request: createsJoinRequest } : {}) };
      if (memberLimit !== undefined && (memberLimit < 1 || memberLimit > 99999)) fail('TELEGRAM_INVITE_LIMIT_INVALID');
      const { body } = await targetBody(fields);
      return journaledWrite('createChatInviteLink', body, { runKey });
    },
    async getChat() {
      const { body } = await targetBody();
      return api('getChat', body);
    },
    async getChatMemberCount() {
      const { body } = await targetBody();
      return api('getChatMemberCount', { chat_id: body.chat_id });
    },
  });
}

export async function createDefaultTelegramChannelClient(options = {}) {
  const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify.mjs');
  const { defaultNotifier } = await import(pathToFileURL(modulePath).href);
  const notifier = await defaultNotifier();
  return createTelegramChannelClient({ api: notifier.api.bind(notifier), ...options });
}

export async function reconcileTelegramIntent({ file, outcome, evidence, url = null, now = () => new Date().toISOString() }) {
  if (!['posted', 'not_posted'].includes(outcome)) fail('TELEGRAM_RECONCILE_OUTCOME_INVALID');
  if (typeof evidence !== 'string' || evidence.trim().length < 10) fail('TELEGRAM_RECONCILE_EVIDENCE_REQUIRED');
  let events;
  try { events = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') fail('TELEGRAM_JOURNAL_INTENT_MISSING'); throw error; }
  const intent = events.find(event => event.type === 'intent' && event.channel === 'telegram');
  if (!intent) fail('TELEGRAM_JOURNAL_INTENT_MISSING');
  if (events.some(event => event.type === 'reconciled')) fail('TELEGRAM_JOURNAL_ALREADY_RESOLVED');
  const priorCheckpoint = events.find(event => event.type === 'checkpoint');
  if (priorCheckpoint) {
    if (outcome === 'not_posted') fail('TELEGRAM_JOURNAL_ALREADY_RESOLVED');
    return { type: 'checkpoint_confirmed', checkpoint: priorCheckpoint.checkpoint };
  }
  let checkpoint = null;
  if (outcome === 'posted') {
    let parsed;
    try { parsed = new URL(url); } catch { fail('TELEGRAM_RECONCILE_PUBLIC_URL_REQUIRED'); }
    const match = /^\/([A-Za-z0-9_]{5,32})\/(\d{1,25})\/?$/.exec(parsed.pathname);
    if (parsed.origin !== 'https://t.me' || !match || parsed.search || parsed.hash) fail('TELEGRAM_RECONCILE_PUBLIC_URL_INVALID');
    checkpoint = { type: 'checkpoint', at: now(), checkpoint: { kind: 'telegram_message_created', messageIds: [match[2]], publicUrls: [`https://t.me/${match[1]}/${match[2]}`] } };
    await appendJournal(file, checkpoint);
  }
  const event = { type: 'reconciled', channel: 'telegram', runKey: intent.runKey, at: now(), outcome,
    evidence: evidence.trim(), ...(checkpoint ? { messageId: checkpoint.checkpoint.messageIds[0], publicUrl: checkpoint.checkpoint.publicUrls[0] } : {}) };
  await appendJournal(file, event);
  return event;
}

export async function setupTelegramChannelDefaults({ client, dryRun = true } = {}) {
  if (!client) fail('TELEGRAM_CHANNEL_CLIENT_REQUIRED');
  if (dryRun) return previewTelegramChannelDefaults();
  const description = await client.setChatDescription(TELEGRAM_CHANNEL_DESCRIPTION, { runKey: 'channel-default-description-v1' });
  const post = await client.sendMessage(TELEGRAM_CHANNEL_PINNED_MESSAGE, { runKey: 'channel-default-welcome-v1', parseMode: 'HTML', linkPreview: false });
  const messageId = post.messageId || post.result?.message_id;
  if (!messageId) fail('TELEGRAM_PINNED_MESSAGE_ID_MISSING');
  const pin = await client.pinChatMessage(messageId, { runKey: 'channel-default-welcome-pin-v1' });
  return { dryRun: false, description, post, pin };
}

function textContent(node) {
  if (node.nodeName === '#text') return node.value || '';
  return (node.childNodes || []).map(textContent).join('');
}

function attr(node, name) { return node.attrs?.find(item => item.name === name)?.value ?? null; }
function classHas(node, name) { return (attr(node, 'class') || '').split(/\s+/).includes(name); }

export function parseTelegramViewCount(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
  const match = /^(\d+(?:[.,]\d+)?)([KMB]?)$/.exec(text);
  if (!match) return null;
  const rawNumber = match[1];
  const normalized = !match[2] && /^\d{1,3}(?:,\d{3})+$/.test(rawNumber) ? rawNumber.replace(/,/g, '') : rawNumber.replace(',', '.');
  const number = Number(normalized);
  const scale = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[match[2]];
  return Number.isFinite(number) ? Math.round(number * scale) : null;
}

async function readPublicHtml(response, maxBytes = 2 * 1024 * 1024) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail('TELEGRAM_PUBLIC_READ_TOO_LARGE');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) fail('TELEGRAM_PUBLIC_READ_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail('TELEGRAM_PUBLIC_READ_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error.code === 'TELEGRAM_PUBLIC_READ_TOO_LARGE') throw error;
    fail('TELEGRAM_PUBLIC_READ_BODY');
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export async function readTelegramPublicViews(username, { fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const handle = String(username ?? '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(handle)) fail('TELEGRAM_PUBLIC_USERNAME_INVALID');
  const pageUrl = `https://t.me/s/${handle}`;
  let response;
  try { response = await fetchImpl(pageUrl, { method: 'GET', headers: { accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { fail('TELEGRAM_PUBLIC_READ_TRANSPORT'); }
  if (response.status !== 200 || !String(response.headers.get('content-type') || '').includes('text/html')) fail('TELEGRAM_PUBLIC_READ_HTTP');
  if (response.url && new URL(response.url).origin !== 'https://t.me') fail('TELEGRAM_PUBLIC_READ_REDIRECTED');
  const html = await readPublicHtml(response);
  const root = parseFragment(html);
  const posts = [];
  const visit = node => {
    if (classHas(node, 'tgme_widget_message')) {
      const dataPost = attr(node, 'data-post');
      const messageId = dataPost?.split('/').at(-1);
      if (/^\d{1,25}$/.test(messageId || '')) {
        let viewsText = null;
        const findViews = child => {
          if (classHas(child, 'tgme_widget_message_views')) viewsText = textContent(child).trim();
          for (const nested of child.childNodes || []) findViews(nested);
        };
        findViews(node);
        const views = parseTelegramViewCount(viewsText);
        posts.push({ messageId, views, viewsText, viewsApproximate: /[KMB]$/i.test(viewsText || ''), url: `https://t.me/${handle}/${messageId}` });
      }
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(root);
  const unique = [...new Map(posts.map(post => [post.messageId, post])).values()];
  return { username: handle, fetchedAt: now(), sourceUrl: pageUrl, loginUsed: false, coverage: 'latest_public_page', posts: unique };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'preview-defaults';
  if (command === 'preview-defaults' || args.includes('--dry-run')) {
    console.log(JSON.stringify(previewTelegramChannelDefaults(), null, 2));
    return;
  }
  if (command === 'preview-views') {
    const username = args[1];
    if (!username) fail('TELEGRAM_PUBLIC_USERNAME_REQUIRED');
    console.log(JSON.stringify({ username, url: `https://t.me/s/${String(username).replace(/^@/, '')}`, request: 'GET', login: false, parser: 'telegram-public-view-counts' }, null, 2));
    return;
  }
  fail('TELEGRAM_CHANNEL_COMMAND_INVALID');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.log(JSON.stringify({ ok: false, code: safeCode(error?.code) })); process.exitCode = 2; });
}
