/**
 * Parse @mentions from message content.
 * Matches @word patterns, strips trailing dots/commas.
 */
export function parseMentions(content) {
    const padded = " " + content;
    const matches = padded.matchAll(/\s@([\w._-]+)/g);
    const names = new Set();
    for (const m of matches) {
        let name = m[1];
        // Strip trailing punctuation
        name = name.replace(/[.,;:!?]+$/, "");
        if (name)
            names.add(name);
    }
    return [...names];
}
/**
 * Route a message to mentioned nodes in a channel.
 * Returns the list of target nodes to deliver to.
 */
export function route(channel, message) {
    const mentions = parseMentions(message.content);
    const targets = [];
    for (const name of mentions) {
        if (name === message.from)
            continue;
        const nodeId = channel.getNodeId(name);
        if (!nodeId)
            continue;
        targets.push({ nodeName: name, nodeId });
    }
    return targets;
}
//# sourceMappingURL=router.js.map