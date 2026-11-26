"use strict";

const {GoogleAuth} = require("google-auth-library");
const {createGateway} = require("./proxy");

const resolverUrl = String(process.env.VM_GATEWAY_RESOLVER_URL || "").trim();
if (!/^https:\/\/[a-z0-9.-]+\/(?:vmGatewayResolve_v2)?$/.test(resolverUrl)) {
  throw new Error("resolver_url_required");
}

const auth = new GoogleAuth();
let client;
const gateway = createGateway({
  resolve: async (body) => {
    client ||= await auth.getIdTokenClient(resolverUrl);
    const response = await client.request({
      url: resolverUrl,
      method: "POST",
      data: body,
      timeout: 5000,
      retry: false,
    });
    return response.data;
  },
});

gateway.listen(Number(process.env.PORT || 8080), "0.0.0.0");
process.on("SIGTERM", () => {
  gateway.close();
  setTimeout(() => process.exit(0), 1000).unref();
});
