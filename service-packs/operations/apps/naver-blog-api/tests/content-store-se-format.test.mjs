import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePost, summarizeFormats } from '../research/content-store/se-format.mjs';

const html = `<div class="se-main-container">
<div class="se-component se-sticker se-l-default"></div>
<div class="se-component se-quotation se-l-quotation_corner"><p class="se-text-paragraph se-text-paragraph-align-center"><span>📍 영업 정보</span></p></div>
<div class="se-component se-imageStrip se-l-default"><img src="a"><img src="b"></div>
<div class="se-component se-text se-l-default"><p class="se-text-paragraph se-text-paragraph-align-center" style="line-height:2.1;"><span class="se-fs-fs16 se-ff-nanumsquare" style="color:#ff0010;">주소 : 서울</span></p>
<p class="se-text-paragraph se-text-paragraph-align-center"><span>​</span></p>
<p class="se-text-paragraph se-text-paragraph-align-center"><b>영업시간 10:30</b></p></div>
<div class="se-component se-table se-l-table_layout4"><table><tr><td>a</td></tr><tr><td>b</td></tr></table></div>
<div class="se-component se-oglink se-l-large_image"></div>
<div class="se-component se-horizontalLine se-l-line1"></div>
</div><div class="comment_area">x</div>`;

test('layout of a post: quotation, divider, table and link-card styles, rhythm, typography and rich components', () => {
  const f = analyzePost(html);
  assert.deepEqual(f.quotationStyles, { quotation_corner: 1 });
  assert.equal(f.quotationEmojiLead, 1);
  assert.deepEqual(f.tableStyles, { table_layout4: 1 });
  assert.deepEqual(f.dividerStyles, { line1: 1 });
  assert.deepEqual(f.oglinkStyles, { large_image: 1 });
  assert.equal(f.images, 2);
  assert.equal(f.lines, 2); assert.equal(f.blankLines, 1);
  assert.equal(f.centered, 1);
  assert.deepEqual(f.fontSizes, ['fs16']); assert.deepEqual(f.fonts, ['nanumsquare']);
  assert.deepEqual(f.lineHeights, ['2.1']); assert.deepEqual(f.accentColors, ['#ff0010']);
  assert.deepEqual(f.rich, { sticker: 1, imageStrip: 1 });
  assert.equal(f.boldRuns, 1);
});

test('genre summary counts posts per style so one heavy post does not dominate', () => {
  const a = analyzePost(html), b = { ...a, quotationStyles: { quotation_line: 3 }, centered: 0, avgLineChars: 50, images: 4 };
  const s = summarizeFormats([a, b, null]);
  assert.equal(s.posts, 2);
  assert.deepEqual(s.quotationStyles, { quotation_corner: 1, quotation_line: 1 });
  assert.equal(s.mostlyCentered, 1);
});
