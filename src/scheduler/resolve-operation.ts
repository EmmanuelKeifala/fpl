import 'dotenv/config';
import { getMutationOperations, resolveMutationOperation } from '../db/client.js';

const ACKNOWLEDGEMENT = 'I_VERIFIED_FPL_STATE';

async function main(): Promise<void> {
  const values = new Map(process.argv.slice(2).map(argument => {
    const [name, ...rest] = argument.replace(/^--/, '').split('=');
    return [name, rest.join('=')];
  }));
  const id = Number(values.get('id'));
  const status = values.get('status');
  const message = values.get('message') ?? '';
  if (!Number.isInteger(id) || id <= 0 || (status !== 'confirmed' && status !== 'rejected')) {
    throw new Error('Usage: --id=<positive integer> --status=confirmed|rejected --message=<verification notes> --ack=I_VERIFIED_FPL_STATE');
  }
  if (values.get('ack') !== ACKNOWLEDGEMENT) {
    throw new Error(`Refusing resolution without --ack=${ACKNOWLEDGEMENT}`);
  }
  const operation = (await getMutationOperations()).find(candidate => candidate.id === id);
  if (!operation) throw new Error(`Mutation operation ${id} does not exist`);
  console.log(`Resolving operation ${id}: ${operation.kind} GW${operation.gameweek} ${operation.status}`);
  await resolveMutationOperation(id, status, message);
  console.log(`Operation ${id} resolved as ${status}.`);
}

main().catch(error => {
  console.error('[MUTATION RESOLUTION]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
