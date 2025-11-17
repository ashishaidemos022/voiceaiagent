// lib/mcp-client.ts
import WebSocket from "ws";

export class MCPClient {
  private ws: WebSocket;
  private pending = new Map<string, (msg: any) => void>();
  private counter = 0;

  constructor(
    private url: string,
    private apiKey: string
  ) {
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    this.ws.on("message", (msg) => {
      const data = JSON.parse(msg.toString());
      if (!data.id) return;
      const resolver = this.pending.get(data.id);
      if (resolver) {
        resolver(data);
        this.pending.delete(data.id);
      }
    });
  }

  waitForReady() {
    return new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });
  }

  private send(method: string, params: any = {}) {
    const id = `${++this.counter}`;
    const payload = { jsonrpc: "2.0", id, method, params };

    this.ws.send(JSON.stringify(payload));

    return new Promise<any>((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  ping() {
    return this.send("ping");
  }

  listTools() {
    return this.send("tools/list");
  }

  executeTool(tool: string, parameters: any) {
    return this.send("tools/execute", { tool, params: parameters });
  }
}
