import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// 与 wrangler 的 Text rules 对齐：测试中 import "*.md" 得到文件内容而非 URL
const mdAsText: Plugin = {
  name: "md-as-text",
  enforce: "pre",
  load(id) {
    if (id.endsWith(".md")) {
      return `export default ${JSON.stringify(readFileSync(id.split("?")[0]!, "utf8"))};`;
    }
  },
};

export default defineConfig({
  plugins: [mdAsText],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
