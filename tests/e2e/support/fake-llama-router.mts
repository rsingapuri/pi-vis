import http from "node:http";

export interface FakeLlamaRouter {
  readonly baseUrl: string;
  readonly requests: string[];
  close: () => Promise<void>;
}

export async function createFakeLlamaRouter(): Promise<FakeLlamaRouter> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);

    if (request.method === "GET" && url.pathname === "/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "pivis-e2e.gguf",
              status: { value: "loaded" },
              architecture: { input_modalities: ["text"] },
              meta: { n_ctx: 4096 },
            },
          ],
        }),
      );
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/props" &&
      url.searchParams.size === 2 &&
      url.searchParams.get("model") === "pivis-e2e.gguf" &&
      url.searchParams.get("autoload") === "false"
    ) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ chat_template: "pivis-e2e-chat-template" }));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Unexpected fake-router request" } }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Fake llama.cpp router did not bind a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
