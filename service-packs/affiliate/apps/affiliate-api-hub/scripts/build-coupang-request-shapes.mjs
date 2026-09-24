import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const REFERENCE = new URL('../references/coupang-request-shape-hints.json', import.meta.url);

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function requestShapeHints() {
  const commonReportFilters = ['filters[].column', 'filters[].operator', 'filters[].value'];
  return [
    { path: '/api/v1/search', method: 'POST', bodyFields: ['categoryId', 'filter', 'deliveryTypes', 'page.pageNumber', 'page.size'] },
    { path: '/api/v1/search/best', method: 'POST', bodyFields: ['page.pageNumber', 'page.size', 'category', 'categoryId'], variantsObserved: 2 },
    { path: '/api/v1/banner/iframe/url', method: 'POST', bodyFields: ['group', 'product'] },
    { path: '/api/v1/banner/gen', method: 'POST', bodyFields: ['group', 'product', 'options'] },
    { path: '/api/v1/widgets/banners', method: 'POST', bodyFields: ['datasetId', 'width', 'height'] },
    { path: '/api/v1/url/any', method: 'GET', queryFields: ['coupangUrl'] },
    { path: '/api/v1/url/instant/{categoryId}', method: 'GET', pathParameters: ['categoryId'] },
    { path: '/api/v1/events', method: 'POST', bodyFields: ['page.pageNumber', 'page.size'] },
    { path: '/api/v1/report/daily', method: 'POST', bodyFields: commonReportFilters,
      filterColumns: ['startDate', 'endDate', 'subIds', 'childTrackingCodes'] },
    { path: '/api/v1/report/monthly', method: 'POST', bodyFields: commonReportFilters,
      filterColumns: ['startDate', 'endDate', 'subIds', 'childTrackingCodes'] },
    { path: '/api/v1/report/dynamic-banner', method: 'POST', bodyFields: commonReportFilters,
      filterColumns: ['startDate', 'endDate', 'subIds', 'childTrackingCodes'] },
    { path: '/api/v1/performance/summary', method: 'POST', bodyFields: commonReportFilters,
      filterColumns: ['startDate', 'endDate', 'subIds', 'childTrackingCodes'] },
    { path: '/api/v1/report/settlement', method: 'POST', bodyFields: ['pageNumber', 'size'] },
    { path: '/api/v1/report/settlements', method: 'POST', bodyFields: [], opaqueBodyObject: true },
    { path: '/api/v1/report/settlements/details', method: 'POST', bodyFields: [], opaqueBodyObject: true },
    { path: '/api/v1/report/payouts', method: 'POST', bodyFields: [], opaqueBodyObject: true },
    { path: '/api/v1/report/payouts/details', method: 'POST', bodyFields: [], opaqueBodyObject: true },
    { path: '/api/v1/widgets/instances/search', method: 'POST', bodyFields: [], opaqueBodyObject: true },
    { path: '/api/v1/discovery/goldbox', method: 'GET', queryFields: ['limit'] },
    { path: '/api/v1/discovery/fashion', method: 'GET', queryFields: ['limit'] },
    { path: '/api/v1/discovery/rocket-fresh', method: 'GET', queryFields: ['limit'] },
    { path: '/api/v1/earning/summary/v2', method: 'GET' },
  ].map(item => ({
    ...item,
    bodyFields: [...new Set(item.bodyFields || [])].sort(),
    queryFields: [...new Set(item.queryFields || [])].sort(),
    pathParameters: [...new Set(item.pathParameters || [])].sort(),
    filterColumns: [...new Set(item.filterColumns || [])].sort(),
    confidence: 'public_bundle_direct_call',
    valuesObserved: false,
    requestBodyValuesPersisted: false,
    executable: false,
  }));
}

export function buildRequestShapeRecord({ now = () => new Date() } = {}) {
  const checkedAt = now();
  const shapes = requestShapeHints();
  return {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    provider: 'coupang_partners',
    mode: 'public_bundle_request_shape_hints',
    source: 'https://partners.coupang.com/static/js/main.78a66a44.js',
    shapeCount: shapes.length,
    fullyNamedBodyShapes: shapes.filter(item => item.method === 'POST' && item.bodyFields.length && !item.opaqueBodyObject).length,
    opaqueBodyShapes: shapes.filter(item => item.opaqueBodyObject).length,
    valuesObserved: false,
    requestBodyValuesPersisted: false,
    executableCount: 0,
    shapes,
  };
}

export async function run({ reference = REFERENCE, now = () => new Date() } = {}) {
  const record = buildRequestShapeRecord({ now });
  const text = JSON.stringify(record, null, 2) + '\n';
  await writeFile(reference, text);
  const evidence = new URL(`../evidence/coupang-request-shapes-${timestamp(new Date(record.checkedAt))}.json`, import.meta.url);
  await writeFile(evidence, text, { flag: 'wx' });
  return { record, reference, evidence };
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) {
  run().then(({ record, evidence }) => {
    console.log(JSON.stringify({ completed: true, shapeCount: record.shapeCount,
      fullyNamedBodyShapes: record.fullyNamedBodyShapes, opaqueBodyShapes: record.opaqueBodyShapes,
      evidenceFile: basename(evidence.pathname), executableCount: 0 }));
  }).catch(() => {
    console.error(JSON.stringify({ completed: false, code: 'COUPANG_REQUEST_SHAPES_FAILED' }));
    process.exitCode = 1;
  });
}
