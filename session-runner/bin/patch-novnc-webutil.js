#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const {patchNoVncWebUtil} = require("../lib/noVncWebUtil");

const webUtilPath = process.env.NOVNC_WEBUTIL_PATH || "/usr/share/novnc/app/webutil.js";
const source = fs.readFileSync(webUtilPath, "utf8");
fs.writeFileSync(webUtilPath, patchNoVncWebUtil(source));
