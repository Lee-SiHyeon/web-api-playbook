# Grok public UI mode catalog

This small HTTP reader extracts the public mode catalog embedded in the observed Grok home-page server-rendered document. It reads `https://grok.com/` without cookies or authentication headers, follows no redirects, and accepts only a bounded `text/html` response containing the observed `server-client-data-modes` JSON script.

This is public UI configuration. It does not read authenticated XHR data, a signed-in account, plan entitlements, conversation history, or generation state, and it does not establish that a mode is available to a particular account. Conversation/library reads and generation remain unimplemented in this package.

## API

```js
import { getPublicModes } from './src/public-modes.mjs';

const result = await getPublicModes();
// result.scope === 'public_ui_modes'
// result.config contains the locale, default mode ID, and projected public mode rows.
```

The return value is kept in memory by this module and includes safe HTTP metadata (`status`, normalized MIME type, byte count, and check time). It validates the observed top-level `locale`, `defaultModeId`, and `modes` types, then leaves mode rows opaque for callers. The mode data is public response content and should be treated as untrusted display text. The module does not log or persist the response. Failures throw `GrokPublicModesError` with a safe `code` and, where applicable, `httpStatus`; errors do not include response bodies or underlying fetch messages.

The document body is limited to 2 MiB and the request timeout is 30 seconds. Local tests use synthetic HTML and do not contact Grok or load session state:

```powershell
npm test -w @affiliate-content-operations/grok-web-api
```
