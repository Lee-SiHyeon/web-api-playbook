import { writeFile } from 'node:fs/promises';

export const TIKTOK_TEST_ACCOUNT = 'lifehack__aibal';
export const TIKTOK_TEST_CAPTION = '업로드 테스트 – 곧 삭제';

const AI_LABEL_NOTE = '이 클립은 AI 생성물이 아니라 FFmpeg로 만든 테스트 슬레이트입니다. YES는 수동 라벨 UI 점검용 테스트 값이며, 실제 게시에서는 실제 영상 제작 방식에 따라 라벨을 다시 판단하세요.';

export function createTikTokManualHandoff({
  file,
  caption = TIKTOK_TEST_CAPTION,
  aiLabel = 'YES',
} = {}) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new TypeError('TIKTOK_HANDOFF_FILE_REQUIRED');
  }
  if (typeof caption !== 'string' || !caption.trim()) {
    throw new TypeError('TIKTOK_HANDOFF_CAPTION_REQUIRED');
  }
  if (aiLabel !== 'YES' && aiLabel !== 'NO') {
    throw new TypeError('TIKTOK_HANDOFF_AI_LABEL_INVALID');
  }

  return {
    schemaVersion: 1,
    platform: 'tiktok',
    accountHandle: TIKTOK_TEST_ACCOUNT,
    postingMode: 'manual_only',
    visibility: 'private_only_me',
    asset: {
      file: file.trim(),
      origin: 'ffmpeg_synthetic_test_slate',
      aiGenerated: false,
    },
    caption: caption.trim(),
    aiLabel: {
      manualSelection: aiLabel,
      testOnly: true,
      note: AI_LABEL_NOTE,
    },
  };
}

export async function writeTikTokManualHandoff({ outputPath, ...handoff }) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new TypeError('TIKTOK_HANDOFF_OUTPUT_PATH_REQUIRED');
  }
  const result = createTikTokManualHandoff(handoff);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return result;
}
