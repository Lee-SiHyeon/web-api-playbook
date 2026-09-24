# Reference layout enforcement

The 2026-09-19 reference study already specified at least eight images and four quotation headings for a single-product article, along with alternating media and short explanations. The publisher previously defaulted optional image and quotation floors to zero. That allowed the hanger article to be published without images, despite passing the technical gates.

`tested_single_product` now selects `naver-single-product-v1` from the publication format. Missing reference metadata, fewer than eight images, fewer than four native quotation headings, missing lead/section images, missing source attribution, failed image loading, or a missing disclosure panel block publication. Omitting the format cannot bypass the check. Comparison articles retain their separate comparison-evidence requirements; this change does not claim that their layout policy is complete.

The user's explicit top-link direction supersedes the reference study's general bottom-link recommendation. The user also reported no personal drawbacks, so no negative personal experience was invented. References are not authority to overwrite these facts or preferences.

## Disclosure and images

The prior inline `#e2e2e2` text background did not meet the user's intended layout. The native editor's `quotation_postit` is an outlined note, not a gray-filled panel. The correction uses the editor's native one-cell table, with a `#f2f2f2` cell background, matching border, and readable gray text. The table/row/cell schema and percentage widths were inspected in the official editor 1.78.1 asset, then verified in the actual native editor and public desktop/mobile page. Table contents and presentation are bound to the same content and presentation fingerprints as other components.

The article uses eight distinct product visuals from the exact linked seller listing. The lead and each section contain relevant imagery. Captions identify seller imagery, and the article separates these visuals from the user's purchase and usage statements. `product_listing` records origin and required visible attribution; it does not assert ownership, a verified license, or that the author took the pictures.

Native previews compile journal-verified uploads through the same path as publication. They verify ordered image identities and actual loading in both viewport modes. Full preview captures enlarge the editor viewport to prevent silent clipping below its original 5,000px height.

The public renderer changes the observed upload host from `blogfiles.pstatic.net` to `postfiles.pstatic.net`. Exact readback accepts only that HTTPS host pair with an identical complete asset path. Different paths, unrelated hosts, HTTP, and credential-bearing URLs fail. Public image bytes and decoded PNG pixels are still audited for accessibility and duplication.

Live article: https://blog.naver.com/aicandoanything/224418225859

The update was submitted once. Read-only reconciliation verified all 42 ordered content units, eight distinct image resources, four quotation headings, the top affiliate link, and the original title. The author performed the review under the user's persistent publication instruction; an independent editorial review is not claimed.
