import { structuralFingerprint } from './html-public.mjs';

// Baselines fingerprinted from the direct public captures listed in
// gov-press-report.md. Counts are observed fixture counts; rolling lists allow
// a small tolerance, while article pages are exactly one record.
const baseline = (selectors, headerLabels = [], rowCount = 1, rowTolerance = 0) => ({
  ...structuralFingerprint(selectors, headerLabels),
  rowCount,
  rowTolerance
});

export const GOV_PRESS_LAYOUTS = Object.freeze({
  'korea-policy-list': baseline([
    'a[href*="policyNewsView.do"]', '.list_type', '.list_type strong', '.list_type .source',
    '.paging', 'a[onclick*="pageLink"]', 'form#mainForm', 'input[name="pageIndex"]'
  ], [], 10, 2),
  'korea-press-release-list': baseline([
    'a[href*="pressReleaseView.do"]', '.list_type', '.list_type strong', '.list_type .source',
    '.paging', 'a[onclick*="pageLink"]', 'form#mainForm', 'input[name="pageIndex"]'
  ], [], 20, 3),
  'korea-policy-detail': baseline([
    '.view_title', '.article_head .info', '.article_body .view_cont'
  ]),
  'korea-media-detail': baseline([
    'main#main h1', '.article_head .info', '.article_body .view_cont'
  ]),
  'mof-selectDoc': baseline([
    '.bo-tit', '.bod-info-box', '.bod-detail-view', '.attach-list'
  ]),
  'mafra-artclView': baseline([
    '.view_top dt', '.view_top .date', '.view_contents', '.file_list'
  ]),
  'mss-View': baseline([
    '.board_view h4#sj', 'label-value', '.board_view .view_contents', '.file_list'
  ], ['담당부서', '등록일', '조회', '작성자', '첨부파일']),
  'mois-commonSelectBoardArticle': baseline([
    '#contents h4.subject', '#contents .table_info', '#contents #desc_pc.desc', '.fileList'
  ]),
  'motir-view': baseline([
    '.detail-tit', '.detail-info', '#cont-body .detail-cont', '.info-down'
  ]),
  'mois-high-oil-page': baseline([
    '#contents h2.title', '#contents .bl_list_blue01, #contents table'
  ], ['구 분', '기초수급자', '차상위·한부모', '소득하위 70%'])
});
