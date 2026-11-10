import { MadModelClient } from "./client.mjs";
import { loadConfig } from "./config.mjs";
import { startModelService } from "./server.mjs";
import { safeFailure } from "./protocol.mjs";
const help =
  "MadModel：复用学校统一认证，提供本机 OpenAI Chat Completions 服务\n\nnode bin/thu-campus.mjs madmodel login [--headless]\nnode bin/thu-campus.mjs madmodel status|check|refresh|logout|models\nnode bin/thu-campus.mjs madmodel serve\nnode bin/thu-campus.mjs madmodel chat < request.json\n\n默认 Base URL：http://127.0.0.1:8765/v1\n配置：MADMODEL_HOST/PORT/API_KEY/STATE_DIR/CHECK_INTERVAL_MS/REFRESH_AHEAD_MS\n密码只通过浏览器已保存凭据自动填充；验证码需本人处理。\n";
export async function main(args = []) {
  const [command = "help", ...flags] = args;
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help);
    return;
  }
  const config = loadConfig();
  if (command === "serve") {
    const running = await startModelService(config);
    const stop = () =>
      void running.close().then(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  const client = new MadModelClient({ config });
  let result;
  if (command === "login") {
    await client.manager.ensure({
      interactive: true,
      force: true,
      headless: flags.includes("--headless"),
    });
    result = await client.manager.status();
  } else if (command === "refresh") {
    await client.manager.ensure({ force: true });
    result = await client.manager.status();
  } else if (command === "status") result = await client.manager.status();
  else if (command === "check") result = await client.manager.check();
  else if (command === "logout") result = await client.manager.logout();
  else if (command === "models") result = await client.models();
  else if (command === "chat") {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > config.maxBodyBytes)
        throw new Error("Request too large");
    }
    const response = await client.completion(JSON.parse(input));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Upstream refused request");
    }
    for await (const chunk of response.body) process.stdout.write(chunk);
    return;
  } else {
    process.stdout.write(help);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
export { safeFailure };
