import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontier, identity, nextNodes, recordObservation, ROOT } from '../tools/discovery/frontier.mjs';

test('canonicalization retains operation selectors and actor scope; does not execute JS controls', () => {
  const url = `${ROOT}/config/blog?blogId=4053103`;
  assert.equal(identity(url).id, identity(`${url}&blogId=4053103#section`).id);
  assert.notEqual(identity(`${url}&Redirect=A`).id, identity(`${url}&Redirect=B`).id);
  assert.equal(identity('javascript:adminMain.GotoPage(\'https://admin.blog.naver.com/ItemBagMusic.naver\',false);').navigable, false);
  assert.equal(identity('https://admin.blog.naver.com/another?blogId=9999').navigable, false);
});

test('historical checkpoint keeps all siblings and edges across shared runtime blockage', () => {
  const legacy = { nodes: [
    { url: ROOT, state: 'inspected', depth: 0, attempts: 1 },
    { url: `${ROOT}/config/blog`, state: 'pending', depth: 1, parent: ROOT },
    { url: `${ROOT}/config/memo`, state: 'pending', depth: 1, parent: ROOT },
    { url: `${ROOT}/config/reset`, state: 'mutation_excluded', depth: 1, parent: ROOT },
  ], edges: [] };
  const map = buildFrontier(legacy, { boundary: { code: 'BROWSER_POLICY_UNAVAILABLE' } });
  assert.equal(map.scope.requestedRoot, ROOT);
  assert.equal(map.nodes.filter(n => n.state === 'pending').length, 2);
  assert.equal(nextNodes(map).length, 0);
  map.sharedFailureBoundary = null;
  assert.equal(nextNodes(map).length, 2);
  recordObservation(map, { url: `${ROOT}/config/blog`, links: [{ url: `${ROOT}/new-child`, readOnly: true }, `${ROOT}/unknown-control`], observedAt: '2026-09-13T00:00:00Z' });
  assert.equal(map.nodes.find(n => n.url.endsWith('/config/blog')).state, 'inspected');
  assert.equal(map.nodes.find(n => n.url.endsWith('/config/memo')).state, 'pending');
  assert.equal(map.nodes.find(n => n.url.endsWith('/new-child')).state, 'pending');
  assert.equal(map.nodes.find(n => n.url.endsWith('/unknown-control')).state, 'candidate');
  assert.equal(map.nodes.filter(n => n.state === 'request_observed').length, 0);
  assert.equal(map.nodes.filter(n => n.state === 'mutation_excluded').length, 1);
});
