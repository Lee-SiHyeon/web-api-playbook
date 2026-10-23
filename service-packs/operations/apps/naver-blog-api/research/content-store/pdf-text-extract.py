import json
import sys

MAX_INPUT_BYTES = 12_000_000
MAX_PAGES = 300
MAX_TEXT_CHARS = 2_000_000


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def title_from_first_page(page):
    try:
        blocks = page.get_text("dict", sort=True).get("blocks", [])
        spans = []
        for block in blocks:
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = " ".join(str(span.get("text", "")).split())
                    box = span.get("bbox", (0, 0, 0, 0))
                    if text and len(text) >= 2 and box[1] <= page.rect.height * 0.55:
                        spans.append({"text": text, "size": float(span.get("size", 0)), "y": float(box[1]), "x": float(box[0])})
        if not spans:
            return ""
        largest = max(row["size"] for row in spans)
        chosen = [row for row in spans if row["size"] >= max(14, largest * 0.9)]
        chosen.sort(key=lambda row: (row["y"], row["x"]))
        if chosen:
            title_lines = [chosen[0]]
            for row in chosen[1:]:
                if row["y"] - title_lines[-1]["y"] > max(36, largest * 2.5):
                    break
                title_lines.append(row)
            chosen = title_lines
        candidate = " ".join(row["text"] for row in chosen)
        return " ".join(candidate.split())[:300]
    except Exception:
        return ""


def main():
    payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(payload) > MAX_INPUT_BYTES:
        emit({"ok": False, "code": "WEB_PDF_TOO_LARGE"})
        return 2
    if b"%PDF-" not in payload[:1024]:
        emit({"ok": False, "code": "WEB_PDF_SIGNATURE"})
        return 2
    try:
        import pymupdf
    except ImportError:
        emit({"ok": False, "code": "WEB_PDF_EXTRACTOR_MISSING"})
        return 2
    try:
        document = pymupdf.open(stream=payload, filetype="pdf")
        if document.needs_pass:
            emit({"ok": False, "code": "WEB_PDF_ENCRYPTED"})
            return 2
        page_count = len(document)
        if page_count < 1 or page_count > MAX_PAGES:
            emit({"ok": False, "code": "WEB_PDF_PAGE_LIMIT"})
            return 2
        text_parts = []
        text_size = 0
        for page in document:
            value = page.get_text("text", sort=True)
            text_size += len(value)
            if text_size > MAX_TEXT_CHARS:
                emit({"ok": False, "code": "WEB_PDF_TEXT_TOO_LARGE"})
                return 2
            text_parts.append(value)
        text = "\n".join(text_parts).strip()
        metadata = document.metadata or {}
        title = " ".join(str(metadata.get("title") or "").split())
        if len(title) < 12:
            title = title_from_first_page(document[0])
        if len(text) < 300 or len(title) < 12:
            emit({"ok": False, "code": "WEB_PDF_CONTENT_UNVERIFIED"})
            return 2
        emit({"ok": True, "title": title[:300], "text": text, "pageCount": page_count,
              "parserVersion": str(pymupdf.VersionBind)})
        return 0
    except Exception:
        emit({"ok": False, "code": "WEB_PDF_PARSE_FAILED"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
