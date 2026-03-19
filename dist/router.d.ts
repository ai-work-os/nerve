import type { Channel } from "./channel.js";
import type { MessageInfo } from "./protocol.js";
/**
 * Parse @mentions from message content.
 * Matches @word patterns, strips trailing dots/commas.
 */
export declare function parseMentions(content: string): string[];
export interface RouteTarget {
    nodeName: string;
    nodeId: string;
}
/**
 * Route a message to mentioned nodes in a channel.
 * Returns the list of target nodes to deliver to.
 */
export declare function route(channel: Channel, message: MessageInfo): RouteTarget[];
