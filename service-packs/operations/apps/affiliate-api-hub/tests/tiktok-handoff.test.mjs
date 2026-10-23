import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createTikTokManualHandoff,
  TIKTOK_TEST_ACCOUNT,
  TIKTOK_TEST_CAPTION,
  writeTikTokManualHandoff,
} from '../scripts/sns/video-upload/tiktok-handoff.mjs';

test('TikTok handoff fixes the test account, private visibility, and test-only AI label', () => {
  const handoff = createTikTokManualHandoff({ file: 'C:/temp/upload-test-6s.mp4' });

  assert.equal(handoff.platform, 'tiktok');
  assert.equal(handoff.accountHandle, TIKTOK_TEST_ACCOUNT);
  assert.equal(handoff.postingMode, 'manual_only');
  assert.equal(handoff.visibility, 'private_only_me');
  assert.equal(handoff.asset.file, 'C:/temp/upload-test-6s.mp4');
  assert.equal(handoff.asset.aiGenerated, false);
  assert.equal(handoff.caption, TIKTOK_TEST_CAPTION);
  assert.equal(handoff.aiLabel.manualSelection, 'YES');
  assert.equal(handoff.aiLabel.testOnly, true);
  assert.match(handoff.aiLabel.note, /FFmpeg로 만든 테스트 슬레이트/);
});

test('TikTok handoff rejects incomplete or unrecognized input without side effects', () => {
  assert.throws(() => createTikTokManualHandoff(), { message: 'TIKTOK_HANDOFF_FILE_REQUIRED' });
  assert.throws(() => createTikTokManualHandoff({ file: 'clip.mp4', caption: '   ' }),
    { message: 'TIKTOK_HANDOFF_CAPTION_REQUIRED' });
  assert.throws(() => createTikTokManualHandoff({ file: 'clip.mp4', aiLabel: 'MAYBE' }),
    { message: 'TIKTOK_HANDOFF_AI_LABEL_INVALID' });
});

test('TikTok handoff writes one private manual manifest and refuses to overwrite it', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tiktok-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'handoff.json');
  const input = { outputPath, file: 'C:/temp/upload-test-6s.mp4' };

  const handoff = await writeTikTokManualHandoff(input);
  const saved = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(saved, handoff);
  await assert.rejects(writeTikTokManualHandoff(input), { code: 'EEXIST' });
});
