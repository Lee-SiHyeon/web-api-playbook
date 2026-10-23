export const ORIGIN = "https://www.adpick.co.kr";
export const ALLOWED_HOST = "www.adpick.co.kr";

export const LOGIN_PAGE = `${ORIGIN}/?ac=login`;
export const LOGIN_URL = `${ORIGIN}/?ac=proc&tac=login`;
export const CAPTCHA_URL = `${ORIGIN}/apis/captcha.php`;
export const DASHBOARD_URL = `${ORIGIN}/?ac=dashboard`;
export const SHOPPING_API = `${ORIGIN}/apis/shopping.php`;
export const SEARCH_API = `${ORIGIN}/apis/shopping_search.php`;
export const COUPANG_API = `${ORIGIN}/apis/shopping_coupang.php`;
export const REPORT_API = `${ORIGIN}/apis/shopping_report.php`;
export const CAMPAIGN_PAGE = `${ORIGIN}/?ac=offer&tac=campaign`;
export const BANNER_PAGE = `${ORIGIN}/?ac=tools&tac=banner`;
export const SHOPBOX_API = `${ORIGIN}/apis/shopbox.php`;
export const APPBOX_API = `${ORIGIN}/apis/appbox.php`;
export const MEDIA_PAGE = `${ORIGIN}/?ac=tools&tac=media`;
export const NATIVE_FRAME = `${ORIGIN}/nativeAD/ad.php`;
export const NATIVE_SCRIPT = `${ORIGIN}/nativeAD/script.js`;

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/auth";
export const GOOGLE_CLIENT_ID =
  "371393484416-t9t1v0qcl136pkmma0k37stdf2pqvjcb.apps.googleusercontent.com";
export const GOOGLE_REDIRECT = `${ORIGIN}/apis/sns-callback.php`;
export const GOOGLE_STATE = "GOOGLE_";
export const GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";

export const LOGIN_SUCCESS_BODY =
  '<script language=javascript>location.replace("/?ac=main");</script>';
export const LOGIN_FAILURE_BODY =
  "<script>alert('Social Login Fail!'); window.close();</script>";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
