import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWidgetInstance } from '../lib/web-auth/coupang-widget.mjs';

test('saved carousel instance: iframe code kept as issued, only Coupang-hosted srcs accepted', () => {
  const inst = { widgetInstanceId: 1037237, widgetInstanceName: 'n', datasetId: 39, width: '100%', height: '140',
    iframe: '<iframe src="https://ads-partners.coupang.com/widgets.html?id=1037237&template=carousel&trackingCode=AF5462559&subId=&width=100%&height=140&tsource=" width="100%" height="140" frameborder="0" scrolling="no" referrerpolicy="unsafe-url"></iframe>',
    js: '<script src="https://ads-partners.coupang.com/g.js"></script>' };
  const w = parseWidgetInstance(inst);
  assert.equal(w.widgetInstanceId, 1037237);
  assert.match(w.src, /^https:\/\/ads-partners\.coupang\.com\/widgets\.html\?id=1037237&/);
  assert.throws(() => parseWidgetInstance({ ...inst, iframe: inst.iframe.replace('ads-partners.coupang.com', 'evil.example') }), /WIDGET_IFRAME_INVALID/);
  assert.throws(() => parseWidgetInstance({ ...inst, iframe: null }), /WIDGET_IFRAME_INVALID/);
  assert.throws(() => parseWidgetInstance({}), /WIDGET_RESPONSE_INVALID/);
});
