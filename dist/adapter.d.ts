export interface AdapterConfig {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    authMethod?: string;
    capabilities: string[];
    terminal: boolean;
}
export declare function getAdapter(name: string): AdapterConfig | undefined;
export declare function listAdapters(): string[];
