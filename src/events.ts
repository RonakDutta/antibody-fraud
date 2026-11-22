import { z } from 'zod';

const accountId = z.string().regex(/^acct-[a-z0-9-]{1,60}$/);
const deviceId = z.string().regex(/^dev-[a-z0-9-]{1,60}$/);
const networkId = z.string().regex(/^net-[a-z0-9-]{1,60}$/);
const payeeId = z.string().regex(/^payee-[a-z0-9-]{1,60}$/);
const base = z.strictObject({
  id: z.uuid().transform((id) => id.toLowerCase()),
  timestamp: z.iso.datetime({ offset: true, precision: 3 }).refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2000 && year <= 2100;
  }, 'Timestamp outside synthetic replay range').transform((value) => new Date(value).toISOString()),
  accountId,
  sessionId: z.string().regex(/^sess-[a-z0-9-]{1,60}$/).optional(),
  deviceId,
  networkId,
  location: z.strictObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  behaviour: z.strictObject({
    dwellMs: z.number().min(1).max(2_000),
    flightMs: z.number().min(1).max(5_000),
    interactionMs: z.number().min(1).max(60_000),
  }).optional(),
});

export const eventSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('login') }),
  base.extend({ kind: z.literal('login_failed') }),
  base.extend({ kind: z.literal('password_reset') }),
  base.extend({ kind: z.literal('payee_added'), payeeId }),
  base.extend({ kind: z.literal('transfer'), payeeId, amountMinor: z.int().min(1).max(100_000_000) }),
]);

export type FraudEvent = z.infer<typeof eventSchema>;
