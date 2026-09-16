import { isQuiesced, setQuiesced } from '../../modules/memory-gate/quiesce.js';
import { registerResource } from '../crud.js';

/**
 * `ncl memory-gate quiesce --state on|off` — the database barrier for memory
 * gate maintenance and rollback (plan §4.3, §7).
 *
 * Operator-only. `hostOnly: true` is the enforcement: the CLI guard denies
 * every container caller regardless of cli_scope or approval (src/cli/guard.ts).
 * `access: 'hidden'` is presentation only — it keeps the verb out of agent-facing
 * help and "did you mean" suggestions (src/cli/dispatch.ts) but gates nothing.
 */
registerResource({
  name: 'memory-gate',
  plural: 'memory-gate',
  table: 'memory_gate_state',
  description: 'Memory provenance gate maintenance: pause and resume the durable memory write ledger.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'number', description: 'Always 1 (single-row state).', generated: true },
    { name: 'quiesced', type: 'boolean', description: 'When set, no memory op can be inserted.' },
    { name: 'updated_at', type: 'string', description: 'Last change to the flag.', generated: true },
  ],
  operations: {},
  customOperations: {
    quiesce: {
      access: 'hidden',
      hostOnly: true,
      description:
        'Set or clear the memory-write barrier. OPERATOR-ONLY. While on, no memory op can be inserted: ' +
        'memory_write requests are refused, approvals resolved meanwhile return to pending, and "remember:" ' +
        'messages are delivered but not filed. Completion of already-queued ops continues.',
      args: [
        {
          name: 'state',
          type: 'string',
          description: 'on to pause inserts, off to resume.',
          required: true,
          enum: ['on', 'off'],
        },
      ],
      examples: ['ncl memory-gate quiesce --state on', 'ncl memory-gate quiesce --state off'],
      handler: async (args) => {
        await setQuiesced(args.state === 'on');
        return { quiesced: await isQuiesced() };
      },
      formatHuman: (data) =>
        (data as { quiesced: boolean }).quiesced
          ? 'memory writes are paused (quiesced); ncl memory-gate quiesce --state off to resume'
          : 'memory writes are active',
    },
  },
});
