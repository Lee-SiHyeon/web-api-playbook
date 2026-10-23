import http from 'node:http';
import https from 'node:https';

const SAFE_AGENT_OPTION_KEYS = new Set([
  'defaultPort', 'keepAlive', 'keepAliveMsecs', 'maxFreeSockets', 'maxSockets', 'maxTotalSockets',
  'noDelay', 'path', 'protocol', 'rejectUnauthorized', 'timeout',
]);

function agentFacts(agent, protocol) {
  const facts = {
    className: 'none',
    optionKeys: [],
    optionKeyCount: 0,
    prototypeNative: false,
    createConnectionNative: false,
    ownCreateConnection: false,
    optionsNullPrototype: false,
    keepAlive: null,
    rejectUnauthorized: null,
    defaultPortExpected: false,
    protocolHttps: false,
    noDelay: false,
    pathNull: false,
    allowed: agent === undefined || agent === null || agent === false,
  };
  if (agent === undefined || agent === null || agent === false) return facts;
  if (typeof agent !== 'object' || Array.isArray(agent)) {
    facts.className = 'other';
    return facts;
  }
  const prototype = Object.getPrototypeOf(agent);
  const Agent = protocol === 'https:' ? https.Agent : protocol === 'http:' ? http.Agent : null;
  facts.className = prototype === https.Agent.prototype ? 'https.Agent'
    : prototype === http.Agent.prototype ? 'http.Agent' : 'other';
  facts.prototypeNative = Agent !== null && prototype === Agent.prototype && agent.constructor === Agent;
  facts.ownCreateConnection = Object.hasOwn(agent, 'createConnection');
  facts.createConnectionNative = Agent !== null && agent.createConnection === Agent.prototype.createConnection;
  const options = agent.options;
  facts.optionsNullPrototype = Boolean(options && typeof options === 'object' && !Array.isArray(options)
    && Object.getPrototypeOf(options) === null);
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    const keys = Object.keys(options).sort();
    facts.optionKeyCount = Math.min(keys.length, 32);
    facts.optionKeys = keys.slice(0, 12).map(key => SAFE_AGENT_OPTION_KEYS.has(key) ? key : 'other');
    facts.keepAlive = typeof options.keepAlive === 'boolean' ? options.keepAlive : null;
    facts.rejectUnauthorized = typeof options.rejectUnauthorized === 'boolean' ? options.rejectUnauthorized : null;
    facts.defaultPortExpected = options.defaultPort === 443;
    facts.protocolHttps = options.protocol === 'https:';
    facts.noDelay = options.noDelay === true;
    facts.pathNull = options.path === null;
    const expectedKeys = ['defaultPort', 'keepAlive', 'noDelay', 'path', 'protocol', 'rejectUnauthorized'];
    facts.allowed = protocol === 'https:' && facts.className === 'https.Agent'
      && facts.prototypeNative && facts.createConnectionNative && !facts.ownCreateConnection
      && facts.optionsNullPrototype && keys.length === expectedKeys.length
      && keys.every((key, index) => key === expectedKeys[index])
      && facts.keepAlive === true && facts.rejectUnauthorized === true
      && facts.defaultPortExpected && facts.protocolHttps && facts.noDelay && facts.pathNull;
  }
  return facts;
}

export function isObservedNativeAgent(agent, protocol) {
  return agentFacts(agent, protocol).allowed;
}

export function readIssuerRequest(input, fallbackProtocol, extraOptions = {}) {
  let provided;
  if (typeof input === 'string' || input instanceof URL) {
    try { provided = new URL(input); } catch { return null; }
  }
  const options = provided ? extraOptions || {} : input || {};
  const protocol = options.protocol || provided?.protocol || fallbackProtocol;
  const hostname = options.hostname || options.host || provided?.hostname || '';
  const path = options.path || (provided ? `${provided.pathname}${provided.search}` : '/');
  let parsed;
  try { parsed = new URL(path, `${protocol}//${hostname}`); } catch { return null; }
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
  const port = String(Object.hasOwn(options, 'port') ? options.port : (parsed.port || provided?.port || ''));
  const defaultPort = protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '';
  const hasCustomSocketPath = options.socketPath !== undefined && options.socketPath !== null;
  const hasCustomConnection = options.createConnection !== undefined && options.createConnection !== null;
  const hasCustomLookup = options.lookup !== undefined && options.lookup !== null;
  const hasCustomNetworkBinding = ['localAddress', 'family', 'hints', 'autoSelectFamily', 'autoSelectFamilyAttemptTimeout']
    .some(key => options[key] !== undefined && options[key] !== null);
  const hasCustomTlsIdentity = ['ca', 'cert', 'key', 'pfx', 'secureContext', 'checkServerIdentity', 'passphrase', 'ciphers', 'minVersion', 'maxVersion', 'secureProtocol']
    .some(key => options[key] !== undefined && options[key] !== null)
    || options.rejectUnauthorized !== undefined && options.rejectUnauthorized !== true;
  const agent = options.agent;
  const agentSummary = agentFacts(agent, protocol);
  const hasCustomAgent = agent !== undefined && agent !== null && agent !== false && !agentSummary.allowed;
  const hasUnexpectedServername = options.servername !== undefined
    && String(options.servername).toLowerCase() !== parsed.hostname.toLowerCase();
  return {
    protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: port === defaultPort ? '' : port,
    hasAuth: Boolean(parsed.username || parsed.password || options.auth || provided?.username || provided?.password),
    hasCustomSocketPath, hasCustomConnection, hasCustomLookup, hasCustomNetworkBinding, hasCustomTlsIdentity,
    hasCustomAgent, hasUnexpectedServername,
    hasCustomTransport: hasCustomSocketPath || hasCustomConnection || hasCustomLookup || hasCustomNetworkBinding
      || hasCustomTlsIdentity || hasCustomAgent || hasUnexpectedServername,
    agentSummary,
    pathname: parsed.pathname,
    method,
    contentType: String(contentType).split(';', 1)[0].trim().toLowerCase(),
  };
}
