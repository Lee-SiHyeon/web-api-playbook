import { createHash } from "node:crypto";
import path from "node:path";
import { fingerprint } from "../../../../packages/contracts/src/index.mjs";
import { inspectDuplication } from './content-duplication.mjs';

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
export function documentUnits(document) {
  return (document?.blocks || [])
    .flatMap((block) => {
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
      if (block.type === "image")
        return [
          {
            type: "image",
            value: imageIdentity(block.publishedUrl || block.file),
            assetHash: block.sha256 || null,
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
  documentUnits(document).map(({ type, value }) => ({ type, value }));
export const unitsFingerprint = (units) => fingerprint(units);
export function documentChecks(document) {
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
    disclosureFirst:
      first?.type === "notice" &&
      /쿠팡 파트너스 활동의 일환|제휴.*수수료/.test(text(first?.text)),
    noDuplicateImages: new Set(imageIds).size === imageIds.length,
    noDuplicateImageUrls:
      new Set(images.map((unit) => unit.value)).size === images.length,
    noDuplicateProse: inspectDuplication(units).noDuplicateProse,
    imageHashesPresent: images.every((unit) =>
      /^[a-f0-9]{64}$/.test(unit.assetHash || ""),
    ),
    imageRightsRecorded: (document?.blocks || [])
      .flatMap((b) =>
        b.type === "image" ? [b] : b.type === "imageStrip" ? b.images : [],
      )
      .every(
        (b) =>
          ["generated", "owned", "licensed", "public_domain", "product_listing"].includes(
            b.rights?.basis,
          ) && text(b.rights?.source).length > 0 &&
          (b.rights.basis !== 'product_listing' || /^https:\/\/www\.coupang\.com\/vp\/products\/\d+/.test(b.rights.source) && text(b.rights.attribution).length > 0),
      ),
    noDamagedText: !/[?？]{2,}|\uFFFD/.test(chars),
    noUnsupportedExperience:
      !/(?:내돈내산|직접 써보니|제가 사용해보니|실사용해보니)/.test(chars),
    nonBlankContent: units.filter((unit) => unit.type === "text").length >= 3,
  };
}
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
