import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(
  new URL('../tools/naver-publisher-extension/background.js', import.meta.url),
  'utf8',
);

test('publisher extension reuses the current browser session without exporting credentials', () => {
  assert.match(source, /chrome\.debugger\.attach/);
  assert.doesNotMatch(source, /chrome\.cookies|document\.cookie|Authorization|NID_AUT|NID_SES/);
  assert.match(source, /job\.dryRun/);
  assert.match(source, /publishJob/);
  assert.match(source, /affiliateLinkPresent/);
});

test('publisher extension verifies draft markers before final publish', () => {
  assert.match(source, /requiredMarkers/);
  assert.match(source, /normalizeText/);
  assert.match(source, /replace\(\/\\u00a0\/g, ' '\)/);
  assert.match(source, /draft_verification_failed/);
  assert.match(source, /confirm_btn/);
  assert.match(source, /PostView\.naver/);
});

test('publisher extension preserves the job id in failure receipts', () => {
  assert.match(source, /let currentJobId = null/);
  assert.match(source, /currentJobId = job\.jobId/);
  assert.match(source, /postResult\(\{jobId: currentJobId/);
});

test('publisher extension supports structured paragraphs and update forms', () => {
  assert.match(source, /PostUpdateForm\.naver/);
  assert.match(source, /insertStructuredBlocks/);
  assert.match(source, /clearEditorDocument/);
  assert.match(source, /requiredSeparateParagraphs/);
  assert.match(source, /maxParagraphLength/);
  assert.match(source, /minImageComponents/);
});

test('structured publishing fails closed when text collapses into a giant paragraph', () => {
  assert.match(source, /draft_structure_failed/);
  assert.match(source, /max_paragraph_/);
  assert.match(source, /paragraphs_/);
  assert.match(source, /separate_marker_missing_/);
});

test('final publish verification survives renderer replacement after navigation', () => {
  assert.match(source, /waitForTabUrl/);
  assert.match(source, /readPublicReceipt/);
  assert.match(source, /Do not use the debugger execution context after the final navigation/);
  assert.doesNotMatch(source, /await waitFor\(target, `location\.pathname\.includes\('PostView\.naver'\)/);
});

test('terminal results are persisted before localhost receipt delivery', () => {
  assert.match(source, /lastResult/);
  assert.match(source, /Persist the terminal result before sending it to localhost/);
  assert.match(source, /result_post_timeout/);
  assert.match(source, /debugger_command_timeout_/);
});

test('publish settings are checked before the irreversible confirmation click', () => {
  assert.match(source, /publish_visibility_not_public/);
  assert.match(source, /publish_timing_not_current/);
  const settingsCheck = source.indexOf('publish_visibility_not_public');
  const finalClick = source.indexOf("await clickTextButton(target, actionLabel, 'confirm_btn')");
  assert.ok(settingsCheck > -1 && finalClick > settingsCheck);
});

test('post-navigation public read-back verifies SmartEditor structure through the current tab', async () => {
  const manifest = JSON.parse(await readFile(new URL('../tools/naver-publisher-extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /paragraphCount/);
  assert.match(source, /maxParagraphLength/);
  assert.match(source, /componentCounts/);
  assert.match(source, /uniqueImageCount/);
});

test('duplicate editor tabs are never closed unless the job explicitly opts in', () => {
  assert.match(source, /job\.closeDuplicateEditorTabs === true/);
  assert.match(source, /Never close duplicate editor tabs by default/);
});

test('editor tab selection never falls back to chrome extensions before a real editor tab', () => {
  assert.match(source, /const editorTabs = tabs\.filter/);
  assert.match(source, /sortByRecency\(editorTabs\)\[0\]/);
  const editorFallback = source.indexOf('sortByRecency(editorTabs)[0]');
  const activeFallback = source.indexOf('tabs.find(tab => tab.active)');
  assert.ok(editorFallback > -1 && activeFallback > editorFallback);
});

test('an existing OG affiliate card can be preserved while rebuilding the document', () => {
  assert.match(source, /preserveExistingOgLink/);
  assert.match(source, /editor_preserved_oglink_count_/);
  assert.match(source, /component\.classList\.contains\('se-oglink'\)/);
  assert.match(source, /Zero is safe because the structured link/);
});

test('diagnostic probe modes remain narrow and read their job from localhost', async () => {
  const serverSource = await readFile(new URL('../scripts/naver-publisher-server.mjs', import.meta.url), 'utf8');
  assert.match(serverSource, /diagnosticModes/);
  assert.match(serverSource, /component_probe/);
  assert.match(serverSource, /clear_probe/);
  assert.match(serverSource, /tab_probe/);
  assert.match(source, /probeNonTextComponent/);
  assert.match(source, /job\.mode === 'tab_probe'/);
});


test('structured publisher supports native quotations, dividers, and image strips', () => {
  assert.match(source, /insertQuotationComponent/);
  assert.match(source, /insertHorizontalLineComponent/);
  assert.match(source, /block\.type === 'imageStrip'/);
  assert.match(source, /quoteComponentCount/);
  assert.match(source, /dividerComponentCount/);
  assert.match(source, /minQuoteComponents/);
  assert.match(source, /minDividerComponents/);
  assert.match(source, /image_mode_not_found_/);
  assert.match(source, /슬라이드/);
  assert.match(source, /await physicalClick\(target, modeRect\)/);
});

test('editor cleanup handles floating delete toolbars for OG and other components', () => {
  assert.match(source, /se-delete-toolbar-button/);
  assert.match(source, /se-oglink-delete-button/);
  assert.match(source, /se-component-toolbar button\[class\*="delete"\]/);
  assert.match(source, /physicalClick/);
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /deleteRect/);
  assert.match(source, /se-context-toolbar button/);
  assert.match(source, /삭제\|delete\|remove/i);
  assert.match(source, /window\.scrollBy\(0, rect\.top - 100\)/);
});

test('service-worker debug trigger only reuses the gated localhost job path', () => {
  assert.match(source, /globalThis\.__naverPublisherRun/);
  assert.match(source, /globalThis\.__naverPublisherState/);
  assert.match(source, /job is still fetched from/);
  assert.doesNotMatch(source, /__naverPublisherRun\s*=\s*job/);
});

test('duplicate Chrome windows cannot redirect a job to the wrong editor tab', () => {
  assert.match(source, /function matchingEditorTabs/);
  assert.match(source, /function selectEditorTab/);
  assert.match(source, /url\.searchParams\.get\('blogId'\) === blogId/);
  assert.match(source, /url\.searchParams\.get\('logNo'\) === logNo/);
  assert.match(source, /tab = selectEditorTab\(job, tabs\)/);
  assert.match(source, /tabs = await chrome\.tabs\.query\(\{\}\)/);
  assert.match(source, /PostUpdateForm\.naver/);
  assert.match(source, /chrome\.tabs\.update\(tab\.id, \{active: true\}\)/);
  assert.match(source, /chrome\.windows\.update\(tab\.windowId, \{focused: true\}\)/);
  assert.match(source, /if \(tab\.discarded\) await chrome\.tabs\.reload/);
  assert.match(source, /chrome\.tabs\.remove\(duplicateIds\)/);
});

test('publisher evaluates the editor without requiring explicit domain enable commands', () => {
  assert.doesNotMatch(source, /command\(target, 'Runtime\.enable'\)/);
  assert.doesNotMatch(source, /command\(target, 'Page\.enable'\)/);
  assert.doesNotMatch(source, /command\(target, 'DOM\.enable'\)/);
});

test('image upload falls back to the SmartEditor file input when the native chooser event is missed', () => {
  assert.match(source, /image_file_input_not_found_/);
  assert.match(source, /input\[type="file"\]/);
  assert.match(source, /DOM\.setFileInputFiles/);
  assert.match(source, /objectId: inputObjectId/);
});
