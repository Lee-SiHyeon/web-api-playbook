# Native disclosure and section formatting

Superseded for disclosure styling by [reference layout enforcement](naver-reference-layout-enforcement-2026-09-21.md). The user rejected the inline highlight described below; the current implementation uses a paragraph-wide native gray cell and eight attributed product images. This document records the earlier observation, not the accepted final standard.

Observed on 2026-09-21 KST. This is a small formatting sample, not a claim about conversion performance or the most common blog style.

- https://blog.naver.com/food_sumer/224379958982 uses black text with a `#e2e2e2` background for part of its affiliate disclosure.
- https://blog.naver.com/starstarshop-/224392991150 uses the native `se-quotation se-l-default` component for a section heading.
- https://blog.naver.com/kkkyung1201/224413619065 uses a plain disclosure without that background, so the sample does not support a universal convention.

The current Naver editor asset, https://editor-static.pstatic.net/e/basic.desktop/1.78.1/se-app-context.js?t=1786079488144, exposes `nodeStyle.fontColor` and `nodeStyle.backgroundColor`. The document compiler supports `notice.presentation = "muted"` using black on gray, and `heading.presentation = "quotation"` using the native quotation component with bold text. Both styles are included in the compiled presentation fingerprint.

Native quotation citation fields contain an empty text node and a `.se-placeholder` prompt. The preview reader excludes that editor placeholder from authored content while retaining any real citation text. Publication readback uses the actual public quotation units.

Live verification: the existing hanger article at https://blog.naver.com/aicandoanything/224418225859 was updated once with unchanged title, prose and link destinations. Exact public HTTP readback passed; unauthenticated desktop and mobile rendering showed the gray disclosure, three quotation headings, all 19 content units, one top affiliate anchor, and no horizontal overflow. The separate editorial reviewer was waived by explicit user direction and is not claimed as verified.
