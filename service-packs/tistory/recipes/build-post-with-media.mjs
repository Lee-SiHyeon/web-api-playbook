// Pure conversion of a Naver publication document into Tistory content with
// already-uploaded Tistory media. Signed attachment URLs remain in memory in
// the returned content and must never be persisted or included in diagnostics.
import { nativeImageMarkup, nativeVideoAttachmentMarkup } from '../lib/media-content.mjs';

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const safeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
};

// These source-log-number and block-index pairs are the only legacy plain
// paragraphs that are known to be media captions. Exact hashes and source
// text guard the mapping against reordered or revised documents.
const LEGACY_IMAGE_CAPTIONS = Object.freeze({
  '224419004923': Object.freeze([
    Object.freeze({ mediaBlockIndex: 1, captionBlockIndex: 2, mediaSha256: 'ef1fabc9326962139370677eaa2b785e272cfe7539126e503d944eabd066ca39', text: 'AI로 제작한 개념 일러스트입니다. Jev의 실제 화면이나 공식 로고가 아닙니다.' }),
    Object.freeze({ mediaBlockIndex: 21, captionBlockIndex: 22, mediaSha256: '6951212fb3e720c749f4da1752f16dac5299b6e5abb4b9aab77cb22c5b96544f', text: 'AI로 제작한 처리 흐름 예시입니다. 질문에 필요한 자료를 주고, 판단 뒤의 처리 규칙은 코드로 연결하는 구상을 그렸습니다.' }),
    Object.freeze({ mediaBlockIndex: 50, captionBlockIndex: 51, mediaSha256: 'cfd7165286637f1c6a673952d8a3459b4bdfc6480d539e3f525bc63ce56de333', text: 'AI로 제작한 도입 체크리스트입니다. 질문의 범위와 코드의 역할, 불확실한 결과의 처리 경로를 함께 확인해보세요.' }),
  ]),
  '224419034040': Object.freeze([
    Object.freeze({ mediaBlockIndex: 1, captionBlockIndex: 2, mediaSha256: 'c5c4867f4522f6a8e40d68a1395888af494fc8589f48ccef74feae3db90d88ae', text: 'AI로 제작한 응용 분야 개념도입니다. 실제 서비스 화면이나 프로젝트의 공식 이미지가 아닙니다.' }),
    Object.freeze({ mediaBlockIndex: 19, captionBlockIndex: 20, mediaSha256: '85549685d1c9966b4086a632a9c5d04e78a22394efdc555420cada78a7498db1', text: 'AI로 제작한 개념 비교 이미지입니다. 분석 결과를 보는 흐름과 주문까지 연결하는 흐름을 구분한 그림이며, 실제 거래 성과를 나타내지 않습니다.' }),
    Object.freeze({ mediaBlockIndex: 35, captionBlockIndex: 36, mediaSha256: 'b1d0d10ebe70155a8b05af35de9e11f16202346cc645c7b179f5eaa110dfe654', text: 'AI로 제작한 기술 응용 개요입니다. 아래 네 사례에서 모델이 판단하도록 설계한 대상을 그렸습니다.' }),
  ]),
  '224419454535': Object.freeze([
    Object.freeze({ mediaBlockIndex: 1, captionBlockIndex: 2, mediaSha256: 'd8286b390d748d475b1b26a456e704bec8113771adffae0f4000995406e782f8', text: '출처: SpaceXAI 공식 X 발표. 작업당 평균 비용과 CursorBench 4.0 점수를 비교한 원본 그래프입니다.' }),
    Object.freeze({ mediaBlockIndex: 15, captionBlockIndex: 16, mediaSha256: 'f2ad782fb2fde0358ffe3fd2ba180391f4886d7f4399c3a961af436d1c6c77a8', text: '출처: SpaceXAI 공식 평가표 원본. 모델 버전과 추론 설정을 함께 확인할 수 있습니다.' }),
    Object.freeze({ mediaBlockIndex: 91, captionBlockIndex: 92, mediaSha256: '4c244169fdae00cffdf325881aaf82fe1621b7f324dc05bbf5c477fc1bf384fb', text: '출처: Google 공식 발표 원본. 아래에 비교 대상과 별도 발표 수치를 정리했습니다.' }),
  ]),
  '224421728060': Object.freeze([
    Object.freeze({ mediaBlockIndex: 1, captionBlockIndex: 2, mediaSha256: '5349d4d0c257028991554f43d12a280664dee3ecb5091f2bf35ada22137eb333', text: '이 글을 위해 만든 설명용 그래픽으로, 실제 작품 화면과는 다릅니다.' }),
  ]),
});

function validateLegacyCaptions(doc, sourceLogNo) {
  if (sourceLogNo === undefined) return new Set();
  const key = String(sourceLogNo);
  if (!/^\d+$/.test(key)) throw new Error('SOURCE_LOGNO_INVALID');
  const mappings = LEGACY_IMAGE_CAPTIONS[key] ?? [];
  const captionIndexes = new Set();
  for (const mapping of mappings) {
    const media = doc.blocks[mapping.mediaBlockIndex];
    const caption = doc.blocks[mapping.captionBlockIndex];
    if (mapping.captionBlockIndex !== mapping.mediaBlockIndex + 1
      || media?.type !== 'image' || media.sha256 !== mapping.mediaSha256
      || caption?.type !== 'paragraph' || caption.text !== mapping.text
      || (caption.presentation && caption.presentation !== 'caption')) {
      throw new Error('MEDIA_CAPTION_MAPPING_MISMATCH');
    }
    captionIndexes.add(mapping.captionBlockIndex);
  }
  return captionIndexes;
}

function resolveAsset(mediaBySha256, block) {
  const hash = block?.sha256;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('MEDIA_HASH_INVALID');
  }

  let media;
  if (mediaBySha256 instanceof Map) media = mediaBySha256.get(hash);
  else if (mediaBySha256 && typeof mediaBySha256 === 'object'
    && Object.hasOwn(mediaBySha256, hash)) media = mediaBySha256[hash];
  if (!media || typeof media !== 'object' || !media.attachment || typeof media.attachment !== 'object') {
    throw new Error('MEDIA_ASSET_MISSING');
  }

  // The map key is the source document digest. Also check any carried digest
  // metadata so a caller cannot accidentally associate a different upload.
  for (const candidate of [media.sha256, media.sourceSha256,
    media.attachment.sha256, media.attachment.sourceSha256]) {
    if (candidate !== undefined && candidate !== hash) throw new Error('MEDIA_HASH_MISMATCH');
  }

  return { media, hash };
}

function captionMarkup(caption) {
  return caption
    ? `<figcaption data-ke-size="size14">${esc(caption)}</figcaption>`
    : '';
}

/**
 * Build Tistory HTML from a source publication document and uploaded media.
 * This function performs no I/O, credential access, or network requests.
 * `mediaBySha256` is keyed by each source block's SHA-256 and contains
 * `{ attachment, width, height }` records. Signed attachment URLs are used
 * only in the returned in-memory `content` value.
 */
export function buildPostWithMedia(doc, {
  sourceUrl,
  sourceLabel = '네이버 블로그 원문',
  mediaBySha256 = new Map(),
  renderVideo,
  sourceLogNo,
} = {}) {
  if (!doc || typeof doc.title !== 'string' || !Array.isArray(doc.blocks)) {
    throw new Error('DOCUMENT_INVALID');
  }
  const originalUrl = safeUrl(sourceUrl);
  if (!originalUrl) throw new Error('SOURCE_URL_INVALID');
  if (!(mediaBySha256 instanceof Map) && (!mediaBySha256 || typeof mediaBySha256 !== 'object')) {
    throw new Error('MEDIA_INDEX_INVALID');
  }
  if (renderVideo !== undefined && typeof renderVideo !== 'function') {
    throw new Error('VIDEO_RENDERER_INVALID');
  }
  const legacyCaptionIndexes = validateLegacyCaptions(doc, sourceLogNo);

  const out = [];
  const mediaCounts = { images: 0, videos: 0 };
  let captionCount = 0;
  out.push(`<p data-ke-size="size16"><em>이 글은 <a href="${esc(originalUrl)}" target="_blank" rel="noopener">${esc(sourceLabel)}</a>에 먼저 게시한 글을 옮긴 것입니다.</em></p>`);

  for (let index = 0; index < doc.blocks.length; index++) {
    const block = doc.blocks[index];
    const next = doc.blocks[index + 1];
    const hasFollowingCaption = (block?.type === 'image' || block?.type === 'video')
      && next?.type === 'paragraph'
      && (next.presentation === 'caption' || legacyCaptionIndexes.has(index + 1));
    const caption = hasFollowingCaption ? String(next.text ?? '') : '';
    if (hasFollowingCaption) captionCount++;

    switch (block?.type) {
      case 'notice':
        out.push(`<blockquote data-ke-style="style2">${esc(block.text)}</blockquote>`);
        break;
      case 'heading':
        out.push(`<h2 data-ke-size="size26">${esc(block.text)}</h2>`);
        break;
      case 'paragraph':
        // The immediately preceding media renderer owns this source caption.
        if (block.presentation !== 'caption' || index === 0
          || !['image', 'video'].includes(doc.blocks[index - 1]?.type)) {
          out.push(`<p data-ke-size="size16">${esc(block.text)}</p>`);
        }
        break;
      case 'link': {
        const url = safeUrl(block.url);
        if (url) out.push(`<p data-ke-size="size16">🔗 <a href="${esc(url)}" target="_blank" rel="noopener">${esc(block.label || url)}</a></p>`);
        break;
      }
      case 'numbered':
        out.push(`<ol data-ke-list-type="decimal">${block.items.map(item => `<li>${esc(item)}</li>`).join('')}</ol>`);
        break;
      case 'bulleted':
        out.push(`<ul data-ke-list-type="disc">${block.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`);
        break;
      case 'table': {
        const head = `<thead><tr>${block.columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead>`;
        const body = `<tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        out.push(`<table data-ke-align="alignLeft" border="1" style="border-collapse:collapse;width:100%">${head}${body}</table>`);
        break;
      }
      case 'image': {
        const { media } = resolveAsset(mediaBySha256, block);
        if (!Number.isSafeInteger(media.width) || !Number.isSafeInteger(media.height)) {
          throw new Error('MEDIA_DIMENSIONS_INVALID');
        }
        out.push(nativeImageMarkup(media.attachment, {
          width: media.width,
          height: media.height,
          caption,
        }));
        mediaCounts.images++;
        break;
      }
      case 'video': {
        const { media, hash } = resolveAsset(mediaBySha256, block);
        let markup;
        if (renderVideo) {
          markup = renderVideo({
            block,
            attachment: media.attachment,
            caption,
            width: media.width,
            height: media.height,
            sourceSha256: hash,
          });
          if (typeof markup !== 'string') throw new Error('VIDEO_RENDERER_RESULT_INVALID');
        } else {
          markup = nativeVideoAttachmentMarkup(media.attachment);
          if (caption) markup += `\n<figure>${captionMarkup(caption)}</figure>`;
        }
        out.push(markup);
        mediaCounts.videos++;
        break;
      }
      case 'spacer':
        break;
      default:
        throw new Error(`BLOCK_UNSUPPORTED:${block?.type}`);
    }

    if (hasFollowingCaption) index++;
  }

  return {
    title: doc.title,
    content: out.join('\n'),
    mediaCounts,
    captionCount,
    blocks: doc.blocks.length,
  };
}
