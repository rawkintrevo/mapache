"use strict";
const {GoogleAuth} = require("google-auth-library");
const {createGateway} = require("./proxy");
const url = process.env.VM_GATEWAY_RESOLVER_URL;
if (!url || !/^https:\/\/[a-z0-9.-]+\/(?:vmGatewayResolve_v2)?$/.test(url)) throw new Error("resolver_url_required");
const auth = new GoogleAuth();
let client;
const server = createGateway({resolve: async (body) => {
  client ||= await auth.getIdTokenClient(url);
  const result = await client.request({url, method: "POST", data: body, timeout: 5000, retry: false});
  return result.data;
}});
server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
process.on("SIGTERM", () => { server.close(); setTimeout(() => process.exit(0), 1000).unref(); });
