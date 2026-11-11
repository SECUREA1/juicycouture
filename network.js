import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

// Honor hosting proxy/NO_PROXY settings and the inherited CA trust.
// RPC credentials stay on the server, including when a managed proxy injects them.
const dispatcher = new EnvHttpProxyAgent();
export function serverFetch(url, options = {}) {
  return undiciFetch(url, { ...options, dispatcher });
}
