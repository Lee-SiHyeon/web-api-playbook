import { createHash } from "node:crypto";
import path from "node:path";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import { inspectDuplication } from './content-duplication.mjs';
import { frontierOriginalQuotation } from './frontier-model-comparison-contract.mjs';

export const text = (value) =>
  String(value ?? "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
export function imageIdentity(value) {
  if (!value) return "";
  try {
    const u = new URL(value);
    return `${u.origin}${decodeURIComponent(u.pathname)}`;
  } catch {
    return path.basename(String(value).replaceAll("\\", "/"));
  }
}
export function tableRows(block) {
  const columns=block?.columns,rows=block?.rows;
  if(!Array.isArray(columns)||columns.length<2||columns.length>4||!Array.isArray(rows)||rows.length<1||rows.length>30)
    throw Error('INVALID_PUBLICATION_TABLE');
  const matrix=[columns,...rows];
  if(matrix.some(row=>!Array.isArray(row)||row.length!==columns.length||row.some(cell=>typeof cell!=='string'||!text(cell)||/[<>]|https?:\/\//i.test(cell))))
    throw Error('INVALID_PUBLICATION_TABLE');
  if(block.columnWidths!==undefined&&(!Array.isArray(block.columnWidths)||block.columnWidths.length!==columns.length||block.columnWidths.some(w=>!Number.isFinite(w)||w<15)||Math.abs(block.columnWidths.reduce((a,b)=>a+b,0)-100)>0.01))
    throw Error('INVALID_TABLE_WIDTHS');
  return matrix.map(row=>row.map(text));
}
export const documentTables=document=>(document?.blocks||[]).filter(b=>b.type==='table').map(tableRows);
export function documentUnits(document) {
  return (document?.blocks || [])
    .flatMap((block) => {
      if(block.type==='table')return tableRows(block).flatMap(row=>row.map(value=>({type:'text',value})));
      if (["notice", "heading", "paragraph", "quote"].includes(block.type))
        return [
          {
            type: block.type === "quote" || block.type === 'heading' && block.presentation === 'quotation' ? "quote" : "text",
            value: text(block.text),
          },
        ];
      if (["list", "numbered"].includes(block.type))
        return (block.items || []).map((value, index) => ({
          type: "text",
          value: text(
            `${block.type === "numbered" ? `${index + 1}. ` : "• "}${value}`,
          ),
        }));
      if (block.type === "link")
        return block.display === 'label' ? [{type:'text',value:text(block.label)}] : [
          { type: "text", value: text(block.label) },
          { type: "text", value: text(block.url) },
        ];
      if (block.type === "oglink")
        return [{ type: "linkcard", value: text(block.url) }];
      if(block.type==='video') {
        if(!/^[A-F0-9]{36}$/.test(block.videoId||''))throw Error('INVALID_VIDEO_ID');
        return [{type:'video',value:block.videoId,assetHash:block.sha256||null}];
      }
      if (block.type === "image")
        return [
          {
            type: "image",
            value: imageIdentity(block.publishedUrl || block.file),
            assetHash: block.sha256 || null,
            ...(block.href ? {href:block.href} : {}),
          },
        ];
      if (block.type === "imageStrip") {
        if (!Array.isArray(block.images) || block.images.length < 2)
          throw new Error("Image strip asset metadata is required");
        return block.images.map((image) => ({
          type: "image",
          value: imageIdentity(image.publishedUrl || image.file),
          assetHash: image.sha256 || null,
        }));
      }
      if (block.type === "divider") return [{ type: "divider", value: "" }];
      if (block.type === "spacer") return [];
      throw new Error("Unsupported publication block");
    })
    .filter((unit) => unit.value || unit.type === "divider");
}
export function documentFingerprint(document) {
  return fingerprint({
    blogId: document?.blogId,
    logNo: String(document?.logNo || ""),
    title: text(document?.title),
    blocks: document?.blocks,
  });
}
export const renderUnits = (document) =>
  documentUnits(document).map(({ type, value, href }) => ({ type, value, ...(href?{href}:{}) }));
export const unitsFingerprint = (units) => fingerprint(units);
export function aiResearchImageQuotation(block, researchSources, document) {
  const artifact = block?.sourceArtifact;
  if (document?.blogId === 'aicandoanything' && String(document?.logNo) === '224421338326' && block?.rights?.basis === 'editorial_quotation') {
    const official = {
      'images/openai-official-automationbench.png': {
        page: 'https://community.openai.com/t/announcing-gpt-6-sol-and-gpt-6-luna-in-the-api-codex-and-chatgpt/1399925',
        asset: 'https://us1.discourse-cdn.com/openai1/original/4X/8/a/3/8a3e471a9d9e8924a80007e6dac44d5805d5be28.png',
        sourceFile: 'evidence/openai-community-chart-1.png',
        sha256: '4d02e0cc00b1cf78e6b21a64d151a38b20ce3885bfd5b5e504edc22cc4ce2364',
        width: 680, height: 578, method: 'direct_original_png', representation: 'official_original', kind: 'community_forum',
      },
      'images/anthropic-official-terminalbench.png': {
        page: 'https://www.anthropic.com/claude-opus-5-5',
        asset: 'https://www.anthropic.com/claude-opus-5-5',
        sourceFile: 'evidence/anthropic-official-terminalbench.png',
        sha256: '44681653c3f2133f6fba0f1871b5df8f4f04345aa8062b6e320d757d44b19039',
        width: 880, height: 672, method: 'official_page_svg_render', representation: 'official_rendered_capture', kind: 'official_documentation',
      },
    };
    const spec = official[block.file], index = document.blocks?.indexOf(block);
    const caption = document.blocks?.[index + 1], link = document.blocks?.[index + 2];
    return !!spec && artifact?.kind === 'official_benchmark_quotation' &&
      artifact.sourcePageUrl === spec.page && artifact.assetUrl === spec.asset &&
      artifact.sourceFile === spec.sourceFile && artifact.sourceSha256 === spec.sha256 &&
      artifact.sha256 === spec.sha256 && block.sha256 === spec.sha256 &&
      artifact.width === spec.width && artifact.height === spec.height &&
      artifact.captureMethod === spec.method && block.sourceRepresentation === spec.representation &&
      researchSources?.some(source => source.url === spec.page && source.sourceKind === spec.kind) === true &&
      block.rights.source === spec.page && block.rights.attribution === artifact.attribution &&
      text(block.rights.purpose).length > 15 && text(artifact.attribution).length > 8 &&
      caption?.type === 'paragraph' && text(caption.text).startsWith(text(artifact.attribution)) &&
      link?.type === 'link' && link.url === spec.page;
  }
  if (block?.rights?.basis !== 'official_source_reproduced' ||
      block.rights.source !== artifact?.sourcePageUrl ||
      artifact?.kind !== 'official_image_quotation' ||
      !researchSources?.some(source => source?.url === artifact.sourcePageUrl && source.sourceKind === 'official_documentation')) return false;
  try {
    const page = new URL(artifact.sourcePageUrl), asset = new URL(artifact.sourceUrl);
    return page.protocol === 'https:' && page.hostname === 'mimo.mi.com' && !page.username && !page.password && !page.hash &&
      asset.protocol === 'https:' && asset.hostname === 'aistudio-cdn.xiaomimimo.com' && !asset.username && !asset.password && !asset.search && !asset.hash &&
      /^\/xiaomimimo-static\/mimo-docs-figures\/display\/[A-Za-z0-9]+\.png$/.test(asset.pathname) &&
      typeof artifact.sourceFile === 'string' && !path.isAbsolute(artifact.sourceFile) &&
      /^[a-f0-9]{64}$/.test(artifact.sourceSha256 || '') && /^[a-f0-9]{64}$/.test(artifact.decodedPixelSha256 || '') &&
      Number.isInteger(artifact.width) && artifact.width > 0 && Number.isInteger(artifact.height) && artifact.height > 0;
  } catch { return false; }
}

export function documentChecks(document, { contentKind = 'commercial', researchSources = [] } = {}) {
  let units = [];
  try {
    units = documentUnits(document);
  } catch {
    return { supportedBlocks: false };
  }
  const first = (document?.blocks || []).find(
    (block) => block.type !== "spacer",
  );
  const images = units.filter((unit) => unit.type === "image");
  const imageIds = images.map((unit) => unit.assetHash || unit.value);
  const chars = units
    .filter((unit) => unit.type === "text" || unit.type === "quote")
    .map((unit) => unit.value)
    .join("\n");
  return {
    supportedBlocks: true,
    fullDocumentPresent:
      Array.isArray(document?.blocks) && document.blocks.length >= 5,
    ...(contentKind === 'market_analysis_article' ? {
      marketNoticeFirst:first?.type==='notice'&&/기준|확인/.test(text(first.text))&&/\d{4}[.\-/년]/.test(text(first.text))&&/정보|교육/.test(text(first.text))&&/투자\s*(?:권유|조언)(?:가|이)?\s*아(?:니|닙)/.test(text(first.text))&&!/제휴|수수료|파트너스|협찬/.test(text(first.text)),
    } : contentKind === 'ai_research_article' ? {
      researchNoticeFirst:first?.type==='notice'&&/공식|원문/.test(text(first.text))&&/확인|기준/.test(text(first.text))&&/\d{4}[.\-/년]/.test(text(first.text))&&!/제휴|수수료|파트너스|협찬/.test(text(first.text)),
    } : {disclosureFirst:
      first?.type === "notice" &&
      /쿠팡 파트너스 활동의 일환|제휴.*수수료/.test(text(first?.text))}),
    noDuplicateImages: new Set(imageIds).size === imageIds.length,
    noDuplicateImageUrls:
      new Set(images.map((unit) => unit.value)).size === images.length,
    noDuplicateProse: inspectDuplication(units).noDuplicateProse,
    videoHashesPresent:units.filter(u=>u.type==='video').every(u=>/^[a-f0-9]{64}$/.test(u.assetHash||'')),
    noDuplicateVideos:new Set(units.filter(u=>u.type==='video').map(u=>u.value)).size===units.filter(u=>u.type==='video').length,
    videoRightsRecorded:(document?.blocks||[]).filter(b=>b.type==='video').every(b=>
      ['owned','licensed','public_domain','generated'].includes(b.rights?.basis)&&text(b.rights?.source).length>0&&
      (b.rights.basis!=='licensed'||text(b.rights?.attribution).length>0)),
    imageHashesPresent: images.every((unit) =>
      /^[a-f0-9]{64}$/.test(unit.assetHash || ""),
    ),
    imageRightsRecorded: (document?.blocks || [])
      .flatMap((b) =>
        b.type === "image" ? [b] : b.type === "imageStrip" ? b.images : [],
      )
      .every(
        (b) =>
          (["generated", "owned", "licensed", "public_domain", "product_listing"].includes(
            b.rights?.basis,
          ) || contentKind === 'ai_research_article' && (frontierOriginalQuotation(document,b) || aiResearchImageQuotation(b,researchSources,document))) && text(b.rights?.source).length > 0 &&
          (b.rights.basis !== 'product_listing' || /^https:\/\/www\.coupang\.com\/vp\/products\/\d+/.test(b.rights.source) && text(b.rights.attribution).length > 0),
      ),
    noDamagedText: !/[?？]{2,}|\uFFFD/.test(chars),
    noUnsupportedExperience:
      !/(?:내돈내산|직접 써보니|제가 사용해보니|실사용해보니)/.test(chars),
    nonBlankContent: units.filter((unit) => unit.type === "text").length >= 3,
  };
}
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
