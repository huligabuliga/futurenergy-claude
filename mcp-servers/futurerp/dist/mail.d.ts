import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface MailDeps {
    userId: string;
    uuidRx: RegExp;
    restBase: string;
    authHeaders: (extra?: Record<string, string>) => Record<string, string>;
    sbApi: (path: string, headers?: Record<string, string>) => Promise<any>;
}
export declare function mailConfigured(): boolean;
export declare function assertSafeAddress(email: string, field: string): string;
export declare function buildRawMessage(input: {
    from: string;
    fromName?: string;
    to: string;
    subject: string;
    text: string;
    attachments?: {
        filename: string;
        mimeType: string;
        bytes: Buffer;
    }[];
}): string;
export declare function registerMailTools(server: McpServer, deps: MailDeps): void;
