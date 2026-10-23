import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type WriteDeps } from "./writes.js";
export interface UploadDeps extends Pick<WriteDeps, "userId" | "restBase" | "authHeaders" | "serviceHeaders"> {
    supabaseUrl: string;
    publishableKey: string;
    userToken: () => string | undefined;
    tableColumns: (table: string) => Promise<string[] | null>;
}
export declare const MAX_URL_BYTES: number;
export declare const MAX_B64_BYTES: number;
export declare function assertPublicHttps(u: URL): Promise<void>;
/** Google Drive "share" links → direct download. */
export declare function directUrl(raw: string): string;
export declare function fileMeta(fileName: string, mime?: string | null): {
    ext: string;
    mime: string;
    fileType: string;
    isImage: boolean;
};
/** Builds the attachment row for `table` from its live columns. Pure; exported for the check script. */
export declare function buildRow(table: string, cols: string[], values: Record<string, any>, f: {
    url: string;
    path: string;
    name: string;
    size: number;
    mime: string;
    ext: string;
    fileType: string;
    isImage: boolean;
}, userId: string): Record<string, any>;
export declare function registerUploadTools(server: McpServer, deps: UploadDeps): void;
