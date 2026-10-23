import { readXMedia } from './x-media-reader.mjs';
try {
  const result = await readXMedia(process.argv[2] || 'lifehack__ailab');
  console.log(JSON.stringify({ ...result, items: result.items.map(item => ({ id: item.id, url: item.url,
    media: item.media.map(({ url, variants, ...media }) => ({ ...media, hasDownloadUrl: Boolean(url), variants: variants.map(({ url, ...variant }) => variant) })),
    quotedMedia: item.quotedMedia.map(({ url, variants, ...media }) => ({ ...media, hasDownloadUrl: Boolean(url), variants: variants.map(({ url, ...variant }) => variant) })) })) }));
} catch (error) {
  console.log(JSON.stringify({ code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'X_MEDIA_READ_FAILED', receipt: error.receipt, socialWrites: 0 }));
  process.exitCode = 2;
}
