// Multi-account (owner 2026-10-30 "왜 계정 하나만 쓰냐"): the Canary/profile is signed into several Google accounts (authuser 0-3), each
// with its own Flow credits. FLOW_ACCOUNT=N selects account N: its own DPAPI entries and Flow's /u/N/ path prefix (observed 2026-10-30:
// the page for authuser 1 lives at /u/1/project/<id> and posts to /u/1/_/AiSandboxAngularFrontend/data/batchexecute; cookies are shared).
// N=0 keeps the original names and paths.
export const FLOW_ACCOUNT = /^[0-9]$/.test(process.env.FLOW_ACCOUNT ?? '') ? Number(process.env.FLOW_ACCOUNT) : 0;
export const FLOW_PATH_PREFIX = FLOW_ACCOUNT ? `/u/${FLOW_ACCOUNT}` : '';
export const FLOW_CREDENTIAL = FLOW_ACCOUNT ? `google-flow-session-v1-u${FLOW_ACCOUNT}` : 'google-flow-session-v1';
