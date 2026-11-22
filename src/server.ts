import { createApp } from './app.js';
import { CaseService } from './cases.js';
import { loadConfig } from './config.js';
import { createPool } from './database.js';
import { HostedMekoReader } from './integrations/meko.js';
import { startPublicationWorker } from './publication-worker.js';
import { createLearning } from './wiring.js';
import { createFallbackModel, createModel } from './integrations/models.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => console.error('An idle PostgreSQL connection failed'));
const memory = config.INVESTIGATION_MODE === 'meko' && config.MEKO_API_KEY && config.MEKO_DATAPACK_ID
  ? new HostedMekoReader(config.MEKO_API_KEY, config.MEKO_DATAPACK_ID) : undefined;
const learning = createLearning(pool, config);
const cases = new CaseService(pool, {
  challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD,
}, {
  mode: config.INVESTIGATION_MODE, memory, model: createModel(config), investigatorModel: createModel(config, true),
  fallbackModel: createFallbackModel(config), advanced: config.INVESTIGATION_PROFILE === 'extended', collective: config.INVESTIGATION_TEAM === 'collective', learning,
  memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS,
});

const server = createApp(pool, cases, learning).listen(config.PORT, '127.0.0.1', () => {
  console.log('ContextCon API listening at http://127.0.0.1:' + config.PORT + ' (' + config.INVESTIGATION_MODE + ' mode)');
});
const stopWorker = learning && config.INVESTIGATION_MODE === 'meko' && config.MEKO_AUTO_PUBLISH === 'on'
  ? startPublicationWorker(learning, () => console.error('Publication worker step failed. It will retry.')) : undefined;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => void Promise.resolve(stopWorker?.()).then(() => pool.end())));
}
