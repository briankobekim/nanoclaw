/**
 * Advisory trust label on human messages (plan §4.4).
 *
 * Computed on the host from facts it owns (owner role, group membership, bot
 * markers) and stamped into the message content so the agent can tell Brian's
 * words from a stranger's. It is guidance for the model, not an enforcement
 * input: nothing in the memory gate reads it back.
 */
export type TrustLabel = 'owner' | 'known' | 'agent' | 'unknown';

export function parseContentSafe(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { text: raw };
    // eslint-disable-next-line no-catch-all/no-catch-all -- non-JSON content is data, not a bug
  } catch {
    return { text: raw };
  }
}

function senderIdOf(content: Record<string, unknown>): string | undefined {
  if (typeof content.senderId === 'string') return content.senderId;
  const author = content.author;
  if (typeof author === 'object' && author !== null && typeof (author as Record<string, unknown>).userId === 'string') {
    return (author as Record<string, unknown>).userId as string;
  }
  return undefined;
}

function isBotAuthored(content: Record<string, unknown>): boolean {
  const author = content.author;
  if (typeof author === 'object' && author !== null && (author as Record<string, unknown>).isBot === true) return true;
  const senderId = senderIdOf(content);
  return typeof senderId === 'string' && senderId.startsWith('slack:bot:');
}

export async function classifyTrust(args: {
  userId: string | null;
  channelType: string;
  content: Record<string, unknown>;
  owners: ReadonlySet<string>;
  /** Group membership check for the delivering agent group; consulted only for non-owners. */
  isKnown: (userId: string) => Promise<boolean>;
}): Promise<TrustLabel> {
  if (args.userId && args.owners.has(args.userId)) return 'owner';
  if (args.channelType === 'agent' || isBotAuthored(args.content)) return 'agent';
  if (args.userId && (await args.isKnown(args.userId))) return 'known';
  return 'unknown';
}

/** Stamp the label into the content JSON, overwriting any value a sender supplied. */
export function stampTrust(contentJson: string, trust: TrustLabel): string {
  const content = parseContentSafe(contentJson);
  content.trust = trust;
  return JSON.stringify(content);
}
