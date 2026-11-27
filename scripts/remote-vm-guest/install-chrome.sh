#!/bin/sh
# Executed by virt-customize inside the new Noble guest image.
set -eu
version=158.0.8127.88-1
deb=/tmp/google-chrome-stable.deb
curl -fsSL --retry 3 "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}_amd64.deb" -o "$deb"
echo "a656b2db00a8cb7f13a1d754f6aad91f84014906452c6dfb7f3ead93035da03b  $deb" | sha256sum -c -
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$deb"
rm "$deb"
ln -s /usr/bin/google-chrome-stable /usr/local/bin/chromium
mcp=/opt/mapache/payload/runtime/lib-node-modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
test -x "$mcp"
ln -s "$mcp" /usr/local/bin/chrome-devtools-mcp
test -r /opt/mapache/payload/novnc/vnc.html
