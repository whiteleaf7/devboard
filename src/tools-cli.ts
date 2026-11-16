// MCP のツールの名前を JSON の配列で出す（`devboard tools`）

import { toolNames } from "./tool-names.ts";

console.log(JSON.stringify(toolNames()));
